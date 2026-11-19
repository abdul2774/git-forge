// Git smart HTTP: ref advertisement (protocol v0 and v2), upload-pack (v2 ls-refs and fetch with
// shallow/deepen, v0 fetch) and receive-pack (v0, report-status with per-ref results). Packs are
// written plain (no deltas); packs received are read with full delta resolution (gitobj.readPack).

import {
  ZERO_OID,
  computeFetch,
  isAncestor,
  parseCommit,
  peelToNonTag,
  putObject,
  readPack,
  writePack,
  type GitObjectRec,
} from './gitobj.ts';
import type { RepoRec } from './store.ts';
import { readBody, sendBytes, sendError, type WebCtx } from './web.ts';

// ---------------------------------------------------------------- pkt-lines

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

interface PktFrame {
  kind: 'data' | 'flush' | 'delim';
  payload: Buffer;
}

/** Parse pkt-line frames from `body` starting at `start`; stops after the first flush. */
function parseFrames(body: Buffer, start: number): { frames: PktFrame[]; next: number } {
  const frames: PktFrame[] = [];
  let offset = start;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      frames.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      return { frames, next: offset };
    }
    if (length === 1) {
      frames.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) break;
    frames.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { frames, next: offset };
}

function frameText(frame: PktFrame): string {
  return frame.payload.toString('utf8').replace(/\n$/, '');
}

/** Chunk bytes into side-band-64k band-1 packets (payload ≤ 32 KiB per packet). */
function sidebandPackets(data: Buffer, band = 1): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, Math.min(offset + CHUNK, data.length));
    packets.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.from([band])));
  return packets;
}

// ---------------------------------------------------------------- refs

interface RefLine {
  name: string;
  oid: string;
}

/** All refs in advertisement order: HEAD first, then the refs sorted by name. */
function sortedRefs(repo: RepoRec): RefLine[] {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------- the handler

export async function handleGitHttp(ctx: WebCtx, owner: string, repoName: string, tail: readonly string[]): Promise<void> {
  const repo = ctx.store.getRepo(owner, repoName);
  const action = tail.join('/');

  if (ctx.method === 'GET' && action === 'info/refs') {
    if (repo === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    const service = ctx.url.searchParams.get('service') ?? '';
    if (service === 'git-upload-pack') {
      advertiseUploadPack(ctx, repo);
      return;
    }
    if (service === 'git-receive-pack') {
      advertiseV0(ctx, repo, 'git-receive-pack');
      return;
    }
    sendError(ctx, 404, 'Not Found');
    return;
  }

  if (ctx.method === 'POST' && action === 'git-upload-pack') {
    if (repo === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    await uploadPack(ctx, repo);
    return;
  }

  if (ctx.method === 'POST' && action === 'git-receive-pack') {
    if (repo === undefined) {
      sendError(ctx, 404, 'Not Found');
      return;
    }
    await receivePack(ctx, repo);
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- advertisement

function advertiseUploadPack(ctx: WebCtx, repo: RepoRec): void {
  const gitProtocol = ctx.req.headers['git-protocol'] ?? '';
  if (/(^|:)version=2/.test(gitProtocol)) {
    const lines = [
      'version 2',
      'agent=git/cimol-forge',
      'ls-refs=unborn',
      'fetch=shallow',
      'object-format=sha1',
    ];
    const body = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), FLUSH]);
    sendBytes(ctx, 200, body, 'application/x-git-upload-pack-advertisement');
    return;
  }
  advertiseV0(ctx, repo, 'git-upload-pack');
}

function advertiseV0(ctx: WebCtx, repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): void {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow symref=HEAD:${headTarget(repo)} agent=git/cimol-forge`
      : 'report-status side-band-64k delete-refs ofs-delta agent=git/cimol-forge';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
    parts.push(pktLine(`${headOid} HEAD\0${caps}`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const target = repo.objects.get(ref.oid);
      if (target !== undefined && target.type === 'tag') {
        parts.push(pktLine(`${peelToNonTag(repo.objects, ref.oid)} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(FLUSH);
  sendBytes(ctx, 200, Buffer.concat(parts), `application/x-${service}-advertisement`);
}

// ---------------------------------------------------------------- upload-pack

async function uploadPack(ctx: WebCtx, repo: RepoRec): Promise<void> {
  const body = await readBody(ctx);
  const { frames } = parseFrames(body, 0);
  const lines = frames.filter((frame) => frame.kind === 'data').map(frameText);
  const command = lines.find((line) => line.startsWith('command='));
  if (command === 'command=ls-refs') {
    lsRefs(ctx, repo, lines);
    return;
  }
  if (command === 'command=fetch') {
    fetchV2(ctx, repo, lines);
    return;
  }
  // No command line: a v0 fetch request (want lines, flush, have lines, done, flush).
  if (lines.some((line) => line.startsWith('want '))) {
    fetchV0(ctx, repo, frames);
    return;
  }
  // A malformed body must not crash the server: answer a plain 400 and stay up.
  ctx.res.writeHead(400, { 'content-type': 'text/plain', 'x-github-request-id': ctx.requestId });
  ctx.res.end('bad request\n');
}

function lsRefs(ctx: WebCtx, repo: RepoRec, lines: readonly string[]): void {
  const args = lines.slice(lines.indexOf('command=ls-refs') + 1);
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));

  const out: string[] = [];
  const headOid = repo.refs.get(headTarget(repo));
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      out.push(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget(repo)}` : ''}`);
    } else if (unborn) {
      out.push(`unborn HEAD symref-target:${headTarget(repo)}`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const target = repo.objects.get(ref.oid);
      if (target !== undefined && target.type === 'tag') line += ` peeled:${peelToNonTag(repo.objects, ref.oid)}`;
    }
    out.push(line);
  }
  const body = Buffer.concat([...out.map((line) => pktLine(`${line}\n`)), FLUSH]);
  sendBytes(ctx, 200, body, 'application/x-git-upload-pack-result');
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
    else if (line === 'done') args.done = true;
  }
  return args;
}

/** Build (or fetch from the cache) the pack bytes for a computed send set. */
function packForSendSet(repo: RepoRec, cacheKey: string, send: readonly string[]): Buffer {
  const cached = repo.packCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const objects: GitObjectRec[] = [];
  for (const oid of send) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }
  const pack = writePack(objects);
  repo.packCache.set(cacheKey, pack);
  return pack;
}

/** The cache key for an assembled fetch response: the full argument tuple decides the bytes. */
function fetchCacheKey(prefix: string, args: FetchArgs): string {
  return `${prefix}|d=${args.depth ?? 'full'}|w=${args.wants.join(',')}|h=${args.haves.join(',')}|s=${args.shallow.join(',')}|done=${args.done ? 1 : 0}`;
}

/** Replay a cached fetch response, or return false when this exact request was never served. */
function replayFetch(ctx: WebCtx, repo: RepoRec, key: string): boolean {
  const cached = repo.fetchCache.get(key);
  if (cached === undefined) return false;
  sendBytes(ctx, 200, cached, 'application/x-git-upload-pack-result');
  return true;
}

/** Remember an assembled fetch response (bounded: the cache resets rather than growing past 128). */
function rememberFetch(repo: RepoRec, key: string, body: Buffer): void {
  if (repo.fetchCache.size >= 128) repo.fetchCache.clear();
  repo.fetchCache.set(key, body);
}

function fetchV2(ctx: WebCtx, repo: RepoRec, lines: readonly string[]): void {
  const args = parseFetchArgs(lines);
  const cacheKey = fetchCacheKey('v2', args);
  if (replayFetch(ctx, repo, cacheKey)) return;
  const computed = computeFetch(repo.objects, args.wants, args.haves, args.shallow, args.depth);
  const sections: Buffer[][] = [];

  if (args.haves.length > 0) {
    const ackLines: string[] = ['acknowledgments'];
    if (computed.common.length > 0) {
      for (const oid of computed.common) ackLines.push(`ACK ${oid}`);
    } else {
      ackLines.push('NAK');
    }
    if (args.done && computed.send.length === 0) ackLines.push('ready');
    sections.push(ackLines.map((line) => pktLine(`${line}\n`)));
  }
  if (computed.shallow.length > 0 || computed.unshallow.length > 0) {
    const infoLines: string[] = ['shallow-info'];
    for (const oid of computed.shallow) infoLines.push(`shallow ${oid}`);
    for (const oid of computed.unshallow) infoLines.push(`unshallow ${oid}`);
    sections.push(infoLines.map((line) => pktLine(`${line}\n`)));
  }
  if (computed.send.length > 0) {
    const packKey = `v2|${args.depth ?? 'full'}|${[...computed.send].sort().join(',')}`;
    const pack = packForSendSet(repo, packKey, computed.send);
    sections.push([pktLine('packfile\n'), ...sidebandPackets(pack)]);
  }

  const parts: Buffer[] = [];
  sections.forEach((section, index) => {
    parts.push(...section);
    parts.push(index === sections.length - 1 ? FLUSH : DELIM);
  });
  if (sections.length === 0) parts.push(FLUSH);
  const body = Buffer.concat(parts);
  rememberFetch(repo, cacheKey, body);
  sendBytes(ctx, 200, body, 'application/x-git-upload-pack-result');
}

function fetchV0(ctx: WebCtx, repo: RepoRec, frames: readonly PktFrame[]): void {
  // Rebuild the two request sections from the raw frames: wants first, haves after the flush.
  const texts = frames.filter((frame) => frame.kind === 'data').map(frameText);
  const args = parseFetchArgs(texts);
  const cacheKey = fetchCacheKey('v0', args);
  if (replayFetch(ctx, repo, cacheKey)) return;
  const computed = computeFetch(repo.objects, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  if (computed.common.length > 0) {
    parts.push(pktLine(`ACK ${computed.common[computed.common.length - 1]}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of computed.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of computed.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (computed.send.length > 0) {
    const packKey = `v0|${args.depth ?? 'full'}|${[...computed.send].sort().join(',')}`;
    const pack = packForSendSet(repo, packKey, computed.send);
    parts.push(...sidebandPackets(pack));
  }
  parts.push(FLUSH);
  const body = Buffer.concat(parts);
  rememberFetch(repo, cacheKey, body);
  sendBytes(ctx, 200, body, 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

async function receivePack(ctx: WebCtx, repo: RepoRec): Promise<void> {
  const body = await readBody(ctx);
  const { frames, next } = parseFrames(body, 0);
  const commands: PushCommand[] = [];
  for (const frame of frames) {
    if (frame.kind !== 'data') continue;
    const text = frame.payload.toString('utf8').replace(/\n$/, '');
    const line = text.split('\0')[0] as string;
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (match !== null) {
      commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
    }
  }
  const packBytes = body.subarray(next);

  // Ingest the pack first (a delete-only push carries none). A bad pack refuses every ref.
  let unpackOk = true;
  const hasUpdates = commands.some((command) => command.newOid !== ZERO_OID);
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const object of read.objects) putObject(repo.objects, object.type, object.data);
    } catch {
      unpackOk = false;
    }
  } else if (hasUpdates) {
    // A create/update with no pack bytes at all is missing its pack (a zero-object pack is legal
    // and arrives as 32 bytes, so it never lands here).
    unpackOk = false;
  }

  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : 'error'}`];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpacker error`);
      continue;
    }
    const verdict = applyCommand(repo, command);
    reportLines.push(verdict === null ? `ok ${command.ref}` : `ng ${command.ref} ${verdict}`);
  }

  const reportStream = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), FLUSH]);
  const parts: Buffer[] = [];
  // The report stream rides in band-1 packets, chunked so no pkt-line exceeds the limit.
  const CHUNK = 32768;
  for (let offset = 0; offset < reportStream.length; offset += CHUNK) {
    const chunk = reportStream.subarray(offset, Math.min(offset + CHUNK, reportStream.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(FLUSH);
  ctx.store.touchRepo(repo);
  sendBytes(ctx, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

/** Validate and apply one ref update; answers null on success or the ng reason. */
function applyCommand(repo: RepoRec, command: PushCommand): string | null {
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (current !== command.oldOid) {
    return command.oldOid === ZERO_OID ? 'reference already exists' : 'stale info';
  }
  if (command.newOid === ZERO_OID) {
    repo.refs.delete(command.ref);
    return null;
  }
  const target = repo.objects.get(command.newOid);
  if (target === undefined) return 'missing object';
  if (command.oldOid !== ZERO_OID) {
    // Fast-forward rule for branches: the new tip must descend from the old tip. Tags may move.
    if (command.ref.startsWith('refs/heads/')) {
      const newCommit = peelToNonTag(repo.objects, command.newOid);
      const oldCommit = peelToNonTag(repo.objects, command.oldOid);
      if (!isAncestor(repo.objects, oldCommit, newCommit)) return 'non-fast-forward';
    }
  } else if (target.type === 'commit') {
    void parseCommit(target.data);
  }
  repo.refs.set(command.ref, command.newOid);
  return null;
}
