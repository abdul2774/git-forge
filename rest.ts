// The REST v3 surface (/api/v3): repositories, branches, commits, contents, labels, issues,
// comments and pull requests. Handlers are thin: parse, delegate to domain.ts, serialise. Every
// error is a JSON {message} body; auth (401) is enforced by app.ts before dispatch.

import {
  addComment,
  commentView,
  createIssue,
  createPull,
  deleteContents,
  issueView,
  labelView,
  listCommits,
  mergePull,
  pullFiles,
  pullView,
  putContents,
  readContents,
  repoView,
  resolveRef,
  userView,
} from './domain.ts';
import { VIEWER, type IssueRec, type RepoRec } from './store.ts';
import { boolField, isRecord, jsonBody, sendEmpty, sendError, sendJson, strField, type WebCtx } from './web.ts';

const NOT_FOUND = 'Not Found';

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Split a path into decoded segments. */
export function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '').map(decode);
}

function pageParams(ctx: WebCtx): { page: number; perPage: number } {
  const page = Number(ctx.url.searchParams.get('page') ?? '1');
  const perPage = Number(ctx.url.searchParams.get('per_page') ?? '30');
  return {
    page: Number.isFinite(page) && page >= 1 ? Math.floor(page) : 1,
    perPage: Number.isFinite(perPage) && perPage >= 1 ? Math.min(100, Math.floor(perPage)) : 30,
  };
}

function paginate<T>(ctx: WebCtx, items: readonly T[]): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(ctx);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const base = `http://${ctx.host}${ctx.path}`;
    const next = `${base}?page=${page + 1}&per_page=${perPage}`;
    const last = `${base}?page=${Math.ceil(items.length / perPage)}&per_page=${perPage}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return { page: slice, headers };
}

// ---------------------------------------------------------------- top level

export async function handleRest(ctx: WebCtx, segments: readonly string[]): Promise<void> {
  const [head, ...rest] = segments;

  if (segments.length === 0) {
    // GET /api/v3 — the API root document (public, as on GitHub).
    if (ctx.method === 'GET') {
      sendJson(
        ctx,
        200,
        {
          current_user_url: '/api/v3/user',
          current_user_repositories_url: '/api/v3/user/repos',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          issue_url: '/api/v3/repos/{owner}/{repo}/issues',
          rate_limit_url: '/api/v3/rate_limit',
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    sendError(ctx, 404, NOT_FOUND);
    return;
  }

  if (!ctx.authed) {
    sendError(ctx, 401, 'Bad credentials');
    return;
  }

  if (head === 'meta' && rest.length === 0 && ctx.method === 'GET') {
    sendJson(ctx, 200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      installed_version: '1.0.0-forge',
      github_services_sha: 'forge',
    });
    return;
  }

  if (head === 'user') {
    await handleUser(ctx, rest);
    return;
  }

  if (head === 'repos' && rest.length >= 2) {
    const owner = rest[0] as string;
    const name = rest[1] as string;
    await handleRepo(ctx, owner, name, rest.slice(2));
    return;
  }

  sendError(ctx, 404, NOT_FOUND);
}

async function handleUser(ctx: WebCtx, segments: readonly string[]): Promise<void> {
  if (segments.length === 0) {
    if (ctx.method === 'GET') {
      sendJson(ctx, 200, userView());
      return;
    }
    sendError(ctx, 404, NOT_FOUND);
    return;
  }
  if (segments[0] === 'repos') {
    if (ctx.method === 'GET') {
      const { page, headers } = paginate(ctx, ctx.store.listViewerRepos());
      sendJson(ctx, 200, page.map(repoView), headers);
      return;
    }
    if (ctx.method === 'POST') {
      const parsed = await jsonBody(ctx);
      if (!parsed.ok) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return;
      }
      const name = strField(parsed.value, 'name');
      if (name === undefined || name === '') {
        sendError(ctx, 422, 'name is required');
        return;
      }
      const repo = ctx.store.createRepo(name, boolField(parsed.value, 'private') ?? false, strField(parsed.value, 'description') ?? '');
      if (repo === null) {
        sendError(ctx, 422, 'name already exists on this account');
        return;
      }
      sendJson(ctx, 201, repoView(repo));
      return;
    }
  }
  sendError(ctx, 404, NOT_FOUND);
}

// ---------------------------------------------------------------- one repository

async function handleRepo(ctx: WebCtx, owner: string, name: string, segments: readonly string[]): Promise<void> {
  const repo = ctx.store.getRepo(owner, name);
  if (segments.length === 0) {
    if (repo === undefined) {
      sendError(ctx, 404, NOT_FOUND);
      return;
    }
    if (ctx.method === 'GET') {
      sendJson(ctx, 200, repoView(repo));
      return;
    }
    if (ctx.method === 'PATCH') {
      const parsed = await jsonBody(ctx);
      if (!parsed.ok) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return;
      }
      const description = strField(parsed.value, 'description');
      if (description !== undefined) repo.description = description;
      const isPrivate = boolField(parsed.value, 'private');
      if (isPrivate !== undefined) repo.isPrivate = isPrivate;
      sendJson(ctx, 200, repoView(repo));
      return;
    }
    if (ctx.method === 'DELETE') {
      ctx.store.deleteRepo(owner, name);
      sendEmpty(ctx, 204);
      return;
    }
    sendError(ctx, 404, NOT_FOUND);
    return;
  }
  if (repo === undefined) {
    sendError(ctx, 404, NOT_FOUND);
    return;
  }

  const [area, ...tail] = segments;
  switch (area) {
    case 'branches':
      handleBranches(ctx, repo, tail);
      return;
    case 'commits':
      handleCommits(ctx, repo);
      return;
    case 'labels':
      await handleLabels(ctx, repo, tail);
      return;
    case 'git':
      await handleGitData(ctx, repo, tail);
      return;
    case 'contents':
      await handleContents(ctx, repo, tail);
      return;
    case 'issues':
      await handleIssues(ctx, repo, tail);
      return;
    case 'pulls':
      await handlePulls(ctx, repo, tail);
      return;
    default:
      sendError(ctx, 404, NOT_FOUND);
  }
}

function handleBranches(ctx: WebCtx, repo: RepoRec, tail: readonly string[]): void {
  if (ctx.method !== 'GET') {
    sendError(ctx, 404, NOT_FOUND);
    return;
  }
  if (tail.length === 0) {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    sendJson(ctx, 200, branches);
    return;
  }
  const branch = tail.join('/');
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) {
    sendError(ctx, 404, NOT_FOUND);
    return;
  }
  sendJson(ctx, 200, { name: branch, commit: { sha }, protected: false });
}

function handleCommits(ctx: WebCtx, repo: RepoRec): void {
  if (ctx.method !== 'GET') {
    sendError(ctx, 404, NOT_FOUND);
    return;
  }
  const shaParam = ctx.url.searchParams.get('sha') ?? repo.defaultBranch;
  const tip = resolveRef(repo, shaParam);
  if (tip === null) {
    sendJson(ctx, 200, []);
    return;
  }
  const commits = listCommits(repo, tip).slice(0, 300).map((entry) => ({
    sha: entry.sha,
    commit: {
      message: entry.message,
      author: { name: VIEWER.name, email: VIEWER.email },
      committer: { name: VIEWER.name, email: VIEWER.email },
    },
    parents: [],
  }));
  sendJson(ctx, 200, commits);
}

async function handleLabels(ctx: WebCtx, repo: RepoRec, tail: readonly string[]): Promise<void> {
  if (tail.length === 0 && ctx.method === 'GET') {
    sendJson(ctx, 200, [...repo.labels.values()].map((label) => labelView(label.name, label.color)));
    return;
  }
  if (tail.length === 0 && ctx.method === 'POST') {
    const parsed = await jsonBody(ctx);
    if (!parsed.ok) {
      sendError(ctx, 400, 'Problems parsing JSON');
      return;
    }
    const name = strField(parsed.value, 'name');
    if (name === undefined || name === '') {
      sendError(ctx, 422, 'name is required');
      return;
    }
    if (repo.labels.has(name)) {
      sendError(ctx, 422, 'name already exists on this repository');
      return;
    }
    const color = strField(parsed.value, 'color') ?? 'ededed';
    repo.labels.set(name, { name, color });
    sendJson(ctx, 201, labelView(name, color));
    return;
  }
  sendError(ctx, 404, NOT_FOUND);
}

async function handleGitData(ctx: WebCtx, repo: RepoRec, tail: readonly string[]): Promise<void> {
  if (tail[0] === 'refs' && ctx.method === 'POST' && tail.length === 1) {
    const parsed = await jsonBody(ctx);
    if (!parsed.ok) {
      sendError(ctx, 400, 'Problems parsing JSON');
      return;
    }
    const ref = strField(parsed.value, 'ref');
    const sha = strField(parsed.value, 'sha');
    if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) {
      sendError(ctx, 422, 'ref and sha are required');
      return;
    }
    const object = repo.objects.get(sha);
    if (object === undefined) {
      sendError(ctx, 422, `Object ${sha} does not exist`);
      return;
    }
    repo.refs.set(ref, sha);
    ctx.store.touchRepo(repo);
    sendJson(ctx, 201, { ref, object: { sha, type: object.type } });
    return;
  }
  if (tail[0] === 'refs' && ctx.method === 'GET') {
    if (tail.length === 1) {
      const all = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
      sendJson(ctx, 200, all);
      return;
    }
    const ref = `refs/${tail.slice(1).join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) {
      sendError(ctx, 404, NOT_FOUND);
      return;
    }
    sendJson(ctx, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
    return;
  }
  sendError(ctx, 404, NOT_FOUND);
}

// ---------------------------------------------------------------- contents

async function handleContents(ctx: WebCtx, repo: RepoRec, tail: readonly string[]): Promise<void> {
  const path = tail.join('/');
  if (ctx.method === 'GET') {
    const ref = ctx.url.searchParams.get('ref') ?? undefined;
    const found = readContents(repo, path, ref);
    if (found === null) {
      sendError(ctx, 404, NOT_FOUND);
      return;
    }
    if (found.kind === 'file') {
      const name = path.split('/').pop() ?? path;
      sendJson(ctx, 200, {
        type: 'file',
        encoding: 'base64',
        content: found.data.toString('base64'),
        name,
        path,
        sha: found.oid,
        size: found.data.length,
      });
      return;
    }
    sendJson(
      ctx,
      200,
      found.entries.map((entry) => ({ type: entry.type, name: entry.name, path: entry.path, sha: entry.oid, size: 0 })),
    );
    return;
  }
  if (ctx.method === 'PUT') {
    const parsed = await jsonBody(ctx);
    if (!parsed.ok || !isRecord(parsed.value)) {
      sendError(ctx, 400, 'Problems parsing JSON');
      return;
    }
    const contentB64 = strField(parsed.value, 'content');
    const message = strField(parsed.value, 'message');
    if (contentB64 === undefined || message === undefined) {
      sendError(ctx, 422, 'content and message are required');
      return;
    }
    const content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
    const result = putContents(ctx.store, repo, {
      path,
      content,
      message,
      branch: strField(parsed.value, 'branch'),
      sha: strField(parsed.value, 'sha'),
    });
    if (!result.ok) {
      sendError(ctx, result.status, result.message);
      return;
    }
    const name = path.split('/').pop() ?? path;
    sendJson(ctx, result.status, {
      content: { name, path, sha: result.contentSha, size: content.length, type: 'file', encoding: 'base64' },
      commit: { sha: result.commitSha },
    });
    return;
  }
  if (ctx.method === 'DELETE') {
    const parsed = await jsonBody(ctx);
    if (!parsed.ok || !isRecord(parsed.value)) {
      sendError(ctx, 400, 'Problems parsing JSON');
      return;
    }
    const message = strField(parsed.value, 'message');
    if (message === undefined) {
      sendError(ctx, 422, 'message is required');
      return;
    }
    const result = deleteContents(ctx.store, repo, {
      path,
      message,
      branch: strField(parsed.value, 'branch'),
      sha: strField(parsed.value, 'sha'),
    });
    if (!result.ok) {
      sendError(ctx, result.status, result.message);
      return;
    }
    sendJson(ctx, 200, { content: null, commit: { sha: result.commitSha } });
    return;
  }
  sendError(ctx, 404, NOT_FOUND);
}

// ---------------------------------------------------------------- issues and comments

function findIssue(repo: RepoRec, number: number): IssueRec | undefined {
  return repo.issues.get(number);
}

async function handleIssues(ctx: WebCtx, repo: RepoRec, tail: readonly string[]): Promise<void> {
  if (tail.length === 0) {
    if (ctx.method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      const direction = ctx.url.searchParams.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()].filter((issue) => issue.kind === 'issue');
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      const { page, headers } = paginate(ctx, issues);
      sendJson(ctx, 200, page.map(issueView), headers);
      return;
    }
    if (ctx.method === 'POST') {
      const parsed = await jsonBody(ctx);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return;
      }
      const title = strField(parsed.value, 'title');
      if (title === undefined) {
        sendError(ctx, 422, 'title is required');
        return;
      }
      const labelsRaw = parsed.value.labels;
      const labels = Array.isArray(labelsRaw) ? labelsRaw.filter((label): label is string => typeof label === 'string') : [];
      const result = createIssue(ctx.store, repo, { title, body: strField(parsed.value, 'body'), labels });
      if (!result.ok) {
        sendError(ctx, result.status, result.message);
        return;
      }
      sendJson(ctx, 201, issueView(result.issue));
      return;
    }
    sendError(ctx, 404, NOT_FOUND);
    return;
  }

  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) {
    sendError(ctx, 404, NOT_FOUND);
    return;
  }
  const issue = findIssue(repo, number);

  if (tail.length === 1) {
    if (issue === undefined) {
      sendError(ctx, 404, NOT_FOUND);
      return;
    }
    if (ctx.method === 'GET') {
      // The read workload hammers this route: serve the cached serialisation when present.
      const cached = repo.issueBodyCache.get(number);
      if (cached !== undefined && issue.kind === 'issue') {
        ctx.res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(cached),
          'x-github-request-id': ctx.requestId,
        });
        ctx.res.end(cached);
        return;
      }
      const view = issueView(issue);
      if (issue.kind === 'issue') repo.issueBodyCache.set(number, `${JSON.stringify(view)}\n`);
      sendJson(ctx, 200, view);
      return;
    }
    if (ctx.method === 'PATCH') {
      const parsed = await jsonBody(ctx);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return;
      }
      const state = strField(parsed.value, 'state');
      if (state !== undefined) {
        if (state !== 'open' && state !== 'closed') {
          sendError(ctx, 422, 'state must be open or closed');
          return;
        }
        issue.state = state;
      }
      const title = strField(parsed.value, 'title');
      if (title !== undefined) issue.title = title;
      const body = strField(parsed.value, 'body');
      if (body !== undefined) issue.body = body;
      ctx.store.touchIssue(repo, issue);
      sendJson(ctx, 200, issueView(issue));
      return;
    }
    sendError(ctx, 404, NOT_FOUND);
    return;
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (issue === undefined) {
      sendError(ctx, 404, NOT_FOUND);
      return;
    }
    if (ctx.method === 'GET') {
      sendJson(ctx, 200, issue.comments.map(commentView));
      return;
    }
    if (ctx.method === 'POST') {
      const parsed = await jsonBody(ctx);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return;
      }
      const body = strField(parsed.value, 'body');
      if (body === undefined) {
        sendError(ctx, 422, 'body is required');
        return;
      }
      const comment = addComment(ctx.store, repo, issue, body);
      sendJson(ctx, 201, commentView(comment));
      return;
    }
  }
  sendError(ctx, 404, NOT_FOUND);
}

// ---------------------------------------------------------------- pull requests

async function handlePulls(ctx: WebCtx, repo: RepoRec, tail: readonly string[]): Promise<void> {
  if (tail.length === 0) {
    if (ctx.method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.issues.values()].filter((issue) => issue.kind === 'pull');
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      const { page, headers } = paginate(ctx, pulls);
      sendJson(ctx, 200, page.map(pullView), headers);
      return;
    }
    if (ctx.method === 'POST') {
      const parsed = await jsonBody(ctx);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(ctx, 400, 'Problems parsing JSON');
        return;
      }
      const title = strField(parsed.value, 'title');
      const headRaw = strField(parsed.value, 'head');
      const baseRaw = strField(parsed.value, 'base');
      if (title === undefined || headRaw === undefined || baseRaw === undefined) {
        sendError(ctx, 422, 'title, head and base are required');
        return;
      }
      const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
      const result = createPull(ctx.store, repo, { title, body: strField(parsed.value, 'body'), head, base });
      if (!result.ok) {
        sendError(ctx, result.status, result.message);
        return;
      }
      sendJson(ctx, 201, pullView(result.pull));
      return;
    }
    sendError(ctx, 404, NOT_FOUND);
    return;
  }

  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) {
    sendError(ctx, 404, NOT_FOUND);
    return;
  }
  const pull = repo.issues.get(number);
  if (pull === undefined || pull.kind !== 'pull') {
    sendError(ctx, 404, NOT_FOUND);
    return;
  }

  if (tail.length === 1 && ctx.method === 'GET') {
    sendJson(ctx, 200, pullView(pull));
    return;
  }
  if (tail.length === 2 && tail[1] === 'files' && ctx.method === 'GET') {
    sendJson(ctx, 200, pullFiles(repo, pull));
    return;
  }
  if (tail.length === 2 && tail[1] === 'merge' && ctx.method === 'PUT') {
    const parsed = await jsonBody(ctx);
    if (!parsed.ok) {
      sendError(ctx, 400, 'Problems parsing JSON');
      return;
    }
    const method = strField(parsed.value, 'merge_method') ?? 'squash';
    if (method !== 'squash') {
      sendError(ctx, 405, `Merge method ${method} is not supported`);
      return;
    }
    const result = mergePull(ctx.store, repo, pull);
    if (!result.ok) {
      sendError(ctx, result.status, result.message);
      return;
    }
    sendJson(ctx, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  sendError(ctx, 404, NOT_FOUND);
}
