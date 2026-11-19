// Git object machinery over a plain Map<oid, {type, data}>: hashing, commit/tree parse and build,
// pack read (with delta resolution) and write (plain objects only), history walks, tree diffs and
// merge analysis. Pure functions of the object map — the store owns the maps, this module owns git.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObjectRec, GitObjectType } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjectMap = Map<string, GitObjectRec>;

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** SHA-1 over `<type> <length>\0<data>` — the object id of a git object. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** Store an object and answer its id (idempotent: objects are content-addressed). */
export function putObject(map: ObjectMap, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!map.has(oid)) map.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, message, author, committer };
}

export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  message: string;
  authorLine: string;
  committerLine: string;
}): Buffer {
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.authorLine}`);
  lines.push(`committer ${input.committerLine}`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

/** An `Name <email> epoch +0000` identity line. */
export function identityLine(name: string, email: string, epochSec: number): string {
  return `${name} <${email}> ${epochSec} +0000`;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: byte-wise by name, directories compared as if named `name/`. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** The entry at a `/`-separated path under a tree, or null. */
export function lookupPath(
  map: ObjectMap,
  treeOid: string,
  segments: readonly string[],
): { mode: string; oid: string; type: 'blob' | 'tree' } | null {
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const tree = map.get(current);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) {
      return { mode: entry.mode, oid: entry.oid, type: entry.mode === '40000' ? 'tree' : 'blob' };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** Every file (blob) under a tree as path -> oid, recursively. */
export function flattenTree(map: ObjectMap, treeOid: string, prefix = '', out = new Map<string, string>()): Map<string, string> {
  const tree = map.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(map, entry.oid, path, out);
    else out.set(path, entry.oid);
  }
  return out;
}

/** Build (and store) nested trees from a flat path -> blob oid map; answers the root tree oid. */
export function buildTreeFromFiles(map: ObjectMap, files: ReadonlyMap<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, oid] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index] as string;
      let child = node.dirs.get(segment);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, oid);
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: emit(child) });
    return putObject(map, 'tree', buildTree(entries));
  };
  return emit(root);
}

/** The tree oid a commit holds, or null when the commit is unknown. */
export function commitTree(map: ObjectMap, commitOid: string): string | null {
  const commit = map.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return null;
  return parseCommit(commit.data).tree;
}

// ---------------------------------------------------------------- history walks

/** Every object reachable from the given tips (commits walk to parents; tags to their target). */
export function reachable(map: ObjectMap, tips: readonly string[], stopAt?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = map.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (stopAt === undefined || !stopAt.has(oid)) stack.push(...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      const target = parseTagTarget(object.data);
      if (target !== null) stack.push(target);
    }
  }
  return seen;
}

export function parseTagTarget(data: Buffer): string | null {
  const match = /^object ([0-9a-f]{40})/m.exec(data.toString('utf8'));
  return match === null ? null : (match[1] as string);
}

/** Peel a tag chain to the final non-tag object id (the object itself when it is not a tag). */
export function peelToNonTag(map: ObjectMap, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = map.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    const target = parseTagTarget(object.data);
    if (target === null) return current;
    current = target;
  }
  return current;
}

/** Whether `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(map: ObjectMap, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = map.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

/** All ancestors of a commit (including itself) with their generation (longest distance from it). */
function ancestorGenerations(map: ObjectMap, tip: string): Map<string, number> {
  const generations = new Map<string, number>([[tip, 0]]);
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const gen = generations.get(oid) as number;
    const object = map.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      const known = generations.get(parent);
      if (known === undefined || known < gen + 1) {
        generations.set(parent, gen + 1);
        queue.push(parent);
      }
    }
  }
  return generations;
}

/** A best common ancestor of two commits (the merge base), or null when unrelated. */
export function mergeBase(map: ObjectMap, a: string, b: string): string | null {
  const ancestorsA = ancestorGenerations(map, a);
  if (ancestorsA.has(b)) return b;
  if (ancestorGenerations(map, b).has(a)) return a;
  // Walk b's ancestry breadth-first; the first commit also ancestral to a is a merge base.
  const seen = new Set<string>([b]);
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (ancestorsA.has(oid)) return oid;
    const object = map.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- fetch computation

export interface FetchComputation {
  /** Object ids to pack and send. */
  send: string[];
  /** Boundary commits to name with `shallow` lines in shallow-info. */
  shallow: string[];
  /** Previously-shallow commits whose parents are now included (`unshallow` lines). */
  unshallow: string[];
  /** Haves the server holds (for ACK lines). */
  common: string[];
}

/**
 * The upload-pack set arithmetic. The send set is the wants' closure minus the haves' closure;
 * the haves' closure never crosses the parents of a client-declared shallow boundary commit.
 * With a depth, commit generations count from the wants (generation 1): commits at the depth
 * limit that still have parents in the full graph become the new shallow boundary.
 */
export function computeFetch(
  map: ObjectMap,
  wants: readonly string[],
  haves: readonly string[],
  shallowList: readonly string[],
  depth: number | null,
): FetchComputation {
  const shallowSet = new Set(shallowList);
  const haveSet = reachable(map, haves, shallowSet);

  // Generation of every commit reachable from the wants (1 = a want), capped by the depth.
  const generations = new Map<string, number>();
  const queue: string[] = [];
  const seed = (oid: string, gen: number): void => {
    const known = generations.get(oid);
    if (known === undefined || gen < known) {
      generations.set(oid, gen);
      queue.push(oid);
    }
  };
  const extraObjects = new Set<string>();
  for (const want of wants) {
    const object = map.get(want);
    if (object === undefined) continue;
    if (object.type === 'commit') seed(want, 1);
    else if (object.type === 'tag') {
      extraObjects.add(want);
      seed(peelToNonTag(map, want), 1);
    } else {
      for (const oid of reachable(map, [want])) extraObjects.add(oid);
    }
  }
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const gen = generations.get(oid) as number;
    const object = map.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    if (depth !== null && gen >= depth) continue;
    for (const parent of parseCommit(object.data).parents) seed(parent, gen + 1);
  }

  const wantObjects = new Set<string>(extraObjects);
  const boundary = new Set<string>();
  const unshallow = new Set<string>();
  const commitTrees: string[] = [];
  for (const [oid, gen] of generations) {
    wantObjects.add(oid);
    const object = map.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    commitTrees.push(commit.tree);
    if (depth !== null && gen === depth && commit.parents.length > 0) boundary.add(oid);
    if (shallowSet.has(oid) && (depth === null || gen < depth)) unshallow.add(oid);
  }
  // One walk over every commit's tree with a shared visited set: successive commits share most
  // of their trees, so per-commit walks would re-traverse the same subtrees again and again.
  for (const treeOid of reachable(map, commitTrees)) wantObjects.add(treeOid);

  const send = [...wantObjects].filter((oid) => !haveSet.has(oid));
  const common = haves.filter((have) => map.has(have));
  return { send, shallow: [...boundary], unshallow: [...unshallow], common };
}

// ---------------------------------------------------------------- diffs and merges

export interface FileChange {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
}

/** Path-level diff between two trees (either may be null for an empty tree). */
export function diffTrees(map: ObjectMap, baseTree: string | null, headTree: string | null): FileChange[] {
  const baseFiles = baseTree === null ? new Map<string, string>() : flattenTree(map, baseTree);
  const headFiles = headTree === null ? new Map<string, string>() : flattenTree(map, headTree);
  const changes: FileChange[] = [];
  for (const [path, oid] of headFiles) {
    const before = baseFiles.get(path);
    if (before === undefined) changes.push({ path, status: 'added', oldOid: null, newOid: oid });
    else if (before !== oid) changes.push({ path, status: 'modified', oldOid: before, newOid: oid });
  }
  for (const [path, oid] of baseFiles) {
    if (!headFiles.has(path)) changes.push({ path, status: 'removed', oldOid: oid, newOid: null });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

/** Lines in a blob: newline count, plus one for a trailing partial line. */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  let lines = 0;
  for (const byte of data) if (byte === 0x0a) lines += 1;
  if (data[data.length - 1] !== 0x0a) lines += 1;
  return lines;
}

export interface MergeAnalysis {
  /** The merge base commit, or null when the branches share no history. */
  base: string | null;
  /** Paths changed on both sides since the merge base with different results. */
  conflicts: string[];
  /** The file map the merged tree should hold (head's wins where only head changed, etc.). */
  mergedFiles: Map<string, string>;
}

/**
 * Three-way path-level merge analysis. The squash rule the suite exercises: a path changed on both
 * sides of the merge base to different blobs conflicts; otherwise the merged tree is the base side's
 * current tree with the head side's changes applied.
 */
export function analyzeMerge(map: ObjectMap, baseTip: string, headTip: string): MergeAnalysis {
  const base = mergeBase(map, baseTip, headTip);
  const baseTree = base === null ? null : commitTree(map, base);
  const baseFiles = baseTree === null ? new Map<string, string>() : flattenTree(map, baseTree);
  const currentBaseTree = commitTree(map, baseTip);
  const currentBaseFiles = currentBaseTree === null ? new Map<string, string>() : flattenTree(map, currentBaseTree);
  const headTree = commitTree(map, headTip);
  const headFiles = headTree === null ? new Map<string, string>() : flattenTree(map, headTree);

  const changedOnHead = new Map<string, string | null>();
  for (const [path, oid] of headFiles) {
    if (baseFiles.get(path) !== oid) changedOnHead.set(path, oid);
  }
  for (const path of baseFiles.keys()) {
    if (!headFiles.has(path)) changedOnHead.set(path, null);
  }
  const conflicts: string[] = [];
  const mergedFiles = new Map(currentBaseFiles);
  for (const [path, oid] of changedOnHead) {
    const baseSideChanged = currentBaseFiles.get(path) !== baseFiles.get(path);
    if (baseSideChanged && currentBaseFiles.get(path) !== oid) {
      conflicts.push(path);
      continue;
    }
    if (oid === null) mergedFiles.delete(path);
    else mergedFiles.set(path, oid);
  }
  return { base, conflicts, mergedFiles };
}

// ---------------------------------------------------------------- packs

/** Serialise objects (already-resolved {type, data}) as a version-2 pack with a SHA-1 trailer. */
export function writePack(objects: readonly GitObjectRec[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(encodePackObjectHeader(TYPE_CODES[object.type], object.data.length));
    // Level 1: packs are built once and then served from the cache, and the suite sits on the
    // same host, so trading a few percent of size for much cheaper compression wins time.
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function encodePackObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Apply a git delta (copy/insert instructions) to a base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // base size (the caller verifies by hash)
  const resultSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const opcode = delta[offset] as number;
    offset += 1;
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (opcode & (1 << bit)) {
          copyOffset += (delta[offset] as number) * 2 ** (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (opcode & (0x10 << bit)) {
          copySize += (delta[offset] as number) * 2 ** (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (opcode > 0) {
      out.push(delta.subarray(offset, offset + opcode));
      produced += opcode;
      offset += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize) throw new Error('delta result size mismatch');
  if (produced !== resultSize) throw new Error('delta produced size mismatch');
  return result;
}

export interface ReadPackResult {
  objects: GitObjectRec[];
  count: number;
}

/**
 * Read a pack, resolving OFS/REF deltas (bases from the pack itself, or from `resolveBase` for thin
 * packs). Throws on a bad trailer or a malformed object. Answers the resolved plain objects.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObjectRec | undefined): ReadPackResult {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack header missing');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack checksum mismatch');

  interface Pending {
    type: GitObjectType | null;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    offset: number;
  }
  const pendings: Pending[] = [];
  const byOffset = new Map<number, GitObjectRec>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const objectOffset = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset varint to the base object.
      let back = pack[offset] as number;
      offset += 1;
      let value = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset] as number;
        offset += 1;
        value = ((value + 1) << 7) | (back & 0x7f);
      }
      baseOffset = objectOffset - value;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateSync(pack.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    offset += inflated.engine.bytesWritten;
    if (inflated.buffer.length !== size) throw new Error('pack object size mismatch');
    if (typeCode === 6 || typeCode === 7) {
      pendings.push({ type: null, data: inflated.buffer, baseOffset, baseOid, offset: objectOffset });
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`pack object type ${typeCode}`);
      const record: GitObjectRec = { type, data: inflated.buffer };
      pendings.push({ type, data: inflated.buffer, offset: objectOffset });
      byOffset.set(objectOffset, record);
    }
  }

  // Resolve deltas iteratively: plain entries seed the by-id map, then each delta whose base is
  // known (by pack offset, by id inside the pack, or from the caller's store) resolves in turn.
  const resolvedByOffset = new Map<number, GitObjectRec>(byOffset);
  const byOid = new Map<string, GitObjectRec>();
  for (const pending of pendings) {
    if (pending.type !== null) byOid.set(hashObject(pending.type, pending.data), { type: pending.type, data: pending.data });
  }
  const resolvedDelta = new Map<Pending, GitObjectRec>();
  let remaining = pendings.filter((pending) => pending.type === null);
  let progressed = true;
  while (remaining.length > 0 && progressed) {
    progressed = false;
    for (const pending of [...remaining]) {
      let base: GitObjectRec | undefined;
      if (pending.baseOffset !== undefined) base = resolvedByOffset.get(pending.baseOffset);
      else if (pending.baseOid !== undefined) base = byOid.get(pending.baseOid) ?? resolveBase?.(pending.baseOid);
      if (base === undefined) continue;
      const record: GitObjectRec = { type: base.type, data: applyDelta(base.data, pending.data) };
      resolvedByOffset.set(pending.offset, record);
      byOid.set(hashObject(record.type, record.data), record);
      resolvedDelta.set(pending, record);
      remaining = remaining.filter((candidate) => candidate !== pending);
      progressed = true;
    }
  }
  if (remaining.length > 0) throw new Error('delta base missing');
  const objects = pendings.map((pending) =>
    pending.type !== null ? { type: pending.type, data: pending.data } : (resolvedDelta.get(pending) as GitObjectRec),
  );
  return { objects, count };
}
