// Shared domain operations and JSON views. REST, MCP and GraphQL all funnel through these functions
// so the three surfaces can never disagree about an object: one create path, one merge path, one
// serialisation per resource.

import {
  analyzeMerge,
  buildCommit,
  buildTreeFromFiles,
  commitTree,
  countLines,
  diffTrees,
  flattenTree,
  hashObject,
  identityLine,
  lookupPath,
  parseCommit,
  parseTree,
  putObject,
} from './gitobj.ts';
import { VIEWER, type IssueRec, type RepoRec, type Store } from './store.ts';

export type Json = Record<string, unknown>;

// ---------------------------------------------------------------- views

export function userView(): Json {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    name: VIEWER.name,
    email: VIEWER.email,
    type: 'User',
    site_admin: false,
  };
}

export function repoView(repo: RepoRec): Json {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    html_url: `/${repo.owner}/${repo.name}`,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

export function labelView(name: string, color: string): Json {
  return { name, color, description: null, default: false };
}

export function issueView(issue: IssueRec): Json {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    user: { login: VIEWER.login, id: VIEWER.id },
  };
}

export function commentView(comment: { id: number; body: string; createdAt: string }): Json {
  return {
    id: comment.id,
    body: comment.body,
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    user: { login: VIEWER.login, id: VIEWER.id },
  };
}

export function pullView(pull: IssueRec): Json {
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef ?? '', sha: pull.headSha ?? '', label: `${VIEWER.login}:${pull.headRef ?? ''}` },
    base: { ref: pull.baseRef ?? '', sha: pull.baseSha ?? '', label: `${VIEWER.login}:${pull.baseRef ?? ''}` },
    merged: pull.merged === true,
    merged_at: pull.mergedAt ?? null,
    merge_commit_sha: pull.mergeCommitSha ?? null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    user: { login: VIEWER.login, id: VIEWER.id },
  };
}

// ---------------------------------------------------------------- issues

export type CreateIssueResult =
  | { ok: true; issue: IssueRec }
  | { ok: false; status: number; message: string };

export function createIssue(
  store: Store,
  repo: RepoRec,
  input: { title: string; body?: string; labels?: readonly string[] },
): CreateIssueResult {
  const labels = input.labels ?? [];
  for (const label of labels) {
    if (!repo.labels.has(label)) {
      return { ok: false, status: 422, message: `Label "${label}" does not exist in this repository` };
    }
  }
  const now = store.nowIso();
  const issue: IssueRec = {
    kind: 'issue',
    id: store.nextIssueId(),
    number: store.allocNumber(repo),
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [...labels],
    comments: [],
    createdSeq: store.nextSeq(),
    createdAt: now,
    updatedAt: now,
  };
  repo.issues.set(issue.number, issue);
  return { ok: true, issue };
}

export function addComment(store: Store, repo: RepoRec, issue: IssueRec, body: string): { id: number; body: string; createdAt: string } {
  const comment = { id: store.nextCommentId(), body, createdAt: store.nowIso() };
  issue.comments.push(comment);
  store.touchIssue(repo, issue);
  return comment;
}

// ---------------------------------------------------------------- git writes through the API

/** The identity line forge-created commits carry. */
function forgeIdentity(store: Store): string {
  return identityLine(VIEWER.name, VIEWER.email, store.nowEpochSec());
}

/** Create a commit on `branch` whose tree is `files`, with parent = the branch tip (if any). */
export function commitFiles(
  store: Store,
  repo: RepoRec,
  branch: string,
  files: ReadonlyMap<string, string>,
  message: string,
): string {
  const tree = buildTreeFromFiles(repo.objects, files);
  const ref = `refs/heads/${branch}`;
  const parent = repo.refs.get(ref);
  const identity = forgeIdentity(store);
  const commit = buildCommit({
    tree,
    parents: parent === undefined ? [] : [parent],
    message: message.endsWith('\n') ? message : `${message}\n`,
    authorLine: identity,
    committerLine: identity,
  });
  const oid = putObject(repo.objects, 'commit', commit);
  repo.refs.set(ref, oid);
  store.touchRepo(repo);
  return oid;
}

/** The file map of a branch tip (empty for an unborn branch). */
export function branchFiles(repo: RepoRec, branch: string): Map<string, string> {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return new Map();
  const tree = commitTree(repo.objects, tip);
  if (tree === null) return new Map();
  return flattenTree(repo.objects, tree);
}

export type PutContentsResult =
  | { ok: true; status: number; contentSha: string; commitSha: string }
  | { ok: false; status: number; message: string };

/**
 * PUT /contents semantics: write `content` at `path` on `branch` (default: the default branch),
 * creating the branch from the default branch's tip when it does not exist yet, and creating the
 * repository's first commit when the branch is unborn. `sha` is the expected current blob id for
 * an update; a mismatch is a 409.
 */
export function putContents(
  store: Store,
  repo: RepoRec,
  input: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
): PutContentsResult {
  const branch = input.branch ?? repo.defaultBranch;
  const ref = `refs/heads/${branch}`;
  if (!repo.refs.has(ref) && branch !== repo.defaultBranch && repo.refs.has(`refs/heads/${repo.defaultBranch}`)) {
    repo.refs.set(ref, repo.refs.get(`refs/heads/${repo.defaultBranch}`) as string);
  }
  const files = branchFiles(repo, branch);
  const existing = files.get(input.path);
  if (existing !== undefined && input.sha !== undefined && input.sha !== existing) {
    return { ok: false, status: 409, message: `The sha given does not match the current blob sha for ${input.path}` };
  }
  const blobOid = putObject(repo.objects, 'blob', input.content);
  files.set(input.path, blobOid);
  const commitSha = commitFiles(store, repo, branch, files, input.message);
  return { ok: true, status: existing === undefined ? 201 : 200, contentSha: blobOid, commitSha };
}

export type DeleteContentsResult =
  | { ok: true; commitSha: string }
  | { ok: false; status: number; message: string };

export function deleteContents(
  store: Store,
  repo: RepoRec,
  input: { path: string; message: string; branch?: string; sha?: string },
): DeleteContentsResult {
  const branch = input.branch ?? repo.defaultBranch;
  const files = branchFiles(repo, branch);
  const existing = files.get(input.path);
  if (existing === undefined) return { ok: false, status: 404, message: 'Not Found' };
  if (input.sha !== undefined && input.sha !== existing) {
    return { ok: false, status: 409, message: `The sha given does not match the current blob sha for ${input.path}` };
  }
  files.delete(input.path);
  const commitSha = commitFiles(store, repo, branch, files, input.message);
  return { ok: true, commitSha };
}

/** Read one path on a ref (branch name, full ref, or commit id): file view data or directory entries. */
export function readContents(
  repo: RepoRec,
  path: string,
  refName: string | undefined,
): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; entries: { name: string; path: string; oid: string; type: 'file' | 'dir' }[] } | null {
  const tip = resolveRef(repo, refName ?? repo.defaultBranch);
  if (tip === null) return null;
  const tree = commitTree(repo.objects, tip);
  if (tree === null) return null;
  if (path === '' || path === '/') {
    return { kind: 'dir', entries: dirEntries(repo, tree, '') };
  }
  const segments = path.split('/').filter((segment) => segment !== '');
  const found = lookupPath(repo.objects, tree, segments);
  if (found === null) return null;
  if (found.type === 'blob') {
    const blob = repo.objects.get(found.oid);
    if (blob === undefined) return null;
    return { kind: 'file', oid: found.oid, data: blob.data };
  }
  return { kind: 'dir', entries: dirEntries(repo, found.oid, segments.join('/')) };
}

function dirEntries(repo: RepoRec, treeOid: string, prefix: string): { name: string; path: string; oid: string; type: 'file' | 'dir' }[] {
  const tree = repo.objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return [];
  return parseTree(tree.data).map((entry) => ({
    name: entry.name,
    path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
    oid: entry.oid,
    type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
  }));
}

/** Resolve a branch name, full ref, tag, or commit id to a commit oid. */
export function resolveRef(repo: RepoRec, name: string): string | null {
  if (repo.refs.has(name)) return repo.refs.get(name) as string;
  const branchRef = `refs/heads/${name}`;
  if (repo.refs.has(branchRef)) return repo.refs.get(branchRef) as string;
  const tagRef = `refs/tags/${name}`;
  if (repo.refs.has(tagRef)) return repo.refs.get(tagRef) as string;
  if (/^[0-9a-f]{40}$/.test(name) && repo.objects.has(name)) return name;
  return null;
}

/** Commits reachable from a ref, newest first (first-parent order is the history the checks read). */
export function listCommits(repo: RepoRec, startOid: string): { sha: string; message: string }[] {
  const out: { sha: string; message: string }[] = [];
  const seen = new Set<string>();
  const stack = [startOid];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    out.push({ sha: oid, message: commit.message.replace(/\n$/, '') });
    // Push parents in reverse so the first parent is walked first (newest-first listing).
    for (let index = commit.parents.length - 1; index >= 0; index -= 1) stack.push(commit.parents[index] as string);
  }
  return out;
}

// ---------------------------------------------------------------- pull requests

export type CreatePullResult =
  | { ok: true; pull: IssueRec }
  | { ok: false; status: number; message: string };

export function createPull(
  store: Store,
  repo: RepoRec,
  input: { title: string; body?: string; head: string; base: string },
): CreatePullResult {
  const headTip = repo.refs.get(`refs/heads/${input.head}`);
  if (headTip === undefined) return { ok: false, status: 422, message: `Head branch "${input.head}" does not exist` };
  const baseTip = repo.refs.get(`refs/heads/${input.base}`);
  if (baseTip === undefined) return { ok: false, status: 422, message: `Base branch "${input.base}" does not exist` };
  for (const existing of repo.issues.values()) {
    if (existing.kind === 'pull' && existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
      return { ok: false, status: 422, message: `A pull request already exists for ${input.head} into ${input.base}` };
    }
  }
  const now = store.nowIso();
  const pull: IssueRec = {
    kind: 'pull',
    id: store.nextIssueId(),
    number: store.allocNumber(repo),
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels: [],
    comments: [],
    createdSeq: store.nextSeq(),
    createdAt: now,
    updatedAt: now,
    headRef: input.head,
    baseRef: input.base,
    headSha: headTip,
    baseSha: baseTip,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
  };
  repo.issues.set(pull.number, pull);
  return { ok: true, pull };
}

/** The changed-file list of a pull request: head tip tree against base tip tree. */
export function pullFiles(repo: RepoRec, pull: IssueRec): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef ?? ''}`) ?? pull.headSha ?? '';
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef ?? ''}`) ?? pull.baseSha ?? '';
  const headTree = headTip === '' ? null : commitTree(repo.objects, headTip);
  const baseTree = baseTip === '' ? null : commitTree(repo.objects, baseTip);
  return diffTrees(repo.objects, baseTree, headTree).map((change) => {
    const additions = change.newOid === null ? 0 : countLines(repo.objects.get(change.newOid)?.data ?? Buffer.alloc(0));
    const deletions = change.oldOid === null ? 0 : countLines(repo.objects.get(change.oldOid)?.data ?? Buffer.alloc(0));
    return {
      filename: change.path,
      status: change.status,
      additions,
      deletions,
      changes: additions + deletions,
    };
  });
}

/** Whether a pull request can merge cleanly under the suite's conflict rule. */
export function pullMergeable(repo: RepoRec, pull: IssueRec): 'MERGEABLE' | 'CONFLICTING' {
  if (pull.state !== 'open') return 'CONFLICTING';
  const headTip = repo.refs.get(`refs/heads/${pull.headRef ?? ''}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef ?? ''}`);
  if (headTip === undefined || baseTip === undefined) return 'CONFLICTING';
  const analysis = analyzeMerge(repo.objects, baseTip, headTip);
  return analysis.conflicts.length === 0 ? 'MERGEABLE' : 'CONFLICTING';
}

export type MergePullResult =
  | { ok: true; sha: string }
  | { ok: false; status: number; message: string };

/** Squash-merge a pull request: one new commit on the base branch holding the merged tree. */
export function mergePull(store: Store, repo: RepoRec, pull: IssueRec): MergePullResult {
  if (pull.kind !== 'pull') return { ok: false, status: 404, message: 'Not Found' };
  if (pull.state !== 'open' || pull.merged === true) {
    return { ok: false, status: 405, message: 'Pull request is not open' };
  }
  const headTip = repo.refs.get(`refs/heads/${pull.headRef ?? ''}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef ?? ''}`);
  if (headTip === undefined || baseTip === undefined) {
    return { ok: false, status: 405, message: 'Pull request branch is missing' };
  }
  const analysis = analyzeMerge(repo.objects, baseTip, headTip);
  if (analysis.conflicts.length > 0) {
    return { ok: false, status: 405, message: `Merge conflict in ${analysis.conflicts.join(', ')}` };
  }
  const message = `${pull.title} (#${pull.number})\n\n${pull.body ?? ''}`.trimEnd() + '\n';
  const sha = commitFiles(store, repo, pull.baseRef as string, analysis.mergedFiles, message);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.nowIso();
  pull.mergeCommitSha = sha;
  store.touchIssue(repo, pull);
  return { ok: true, sha };
}

/** The blob id a path holds on a ref, or null (used by the contents stale-sha rule). */
export function blobAt(repo: RepoRec, path: string, refName: string | undefined): string | null {
  const found = readContents(repo, path, refName);
  return found !== null && found.kind === 'file' ? found.oid : null;
}

export function hashOf(type: 'blob', data: Buffer): string {
  return hashObject(type, data);
}
