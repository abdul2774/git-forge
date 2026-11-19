// The forge's in-memory store: one shared state for the REST, GraphQL, MCP and git surfaces, so an
// object created over any surface reads back identically over every other. Everything lives in Maps;
// ids come from monotonic counters and timestamps from a deterministic clock (MAKEFUN_TRIAL_NOW when
// the trial sets it, a fixed epoch otherwise) — never the wall clock, so responses are reproducible.

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObjectRec {
  type: GitObjectType;
  data: Buffer;
}

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
}

/** An issue or a pull request: both share one per-repo number counter, as on GitHub. */
export interface IssueRec {
  kind: 'issue' | 'pull';
  /** Global, stable numeric id (the REST `id`, distinct from the per-repo number). */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdSeq: number;
  createdAt: string;
  updatedAt: string;
  // Pull-request-only fields (undefined for plain issues).
  headRef?: string;
  baseRef?: string;
  headSha?: string;
  baseSha?: string;
  merged?: boolean;
  mergedAt?: string | null;
  mergeCommitSha?: string | null;
}

export interface RepoRec {
  /** The numeric database id (REST `id`, GraphQL `databaseId`). */
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObjectRec>;
  /** Full ref name ('refs/heads/main') -> object id. */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  /** Issues and pull requests by their shared per-repo number. */
  issues: Map<number, IssueRec>;
  nextNumber: number;
  createdSeq: number;
  /** Serialised GET-issue bodies, invalidated on any write to that issue (the read workload). */
  issueBodyCache: Map<number, string>;
  /** Built pack bytes for shallow fetches, keyed by want/depth (the clone workload). */
  packCache: Map<string, Buffer>;
}

/** The token owner: the suite's seeded scenario fixes this identity. */
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'ada.iversen@example.dev',
} as const;

/** The base instant for the deterministic clock. */
function trialBaseMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) return asNumber < 1e12 ? asNumber * 1000 : asNumber;
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.UTC(2025, 0, 1, 0, 0, 0);
}

export class Store {
  readonly repos = new Map<string, RepoRec>();
  private repoSeq = 0;
  private issueSeq = 0;
  private commentSeq = 0;
  private clockSeq = 0;
  private readonly baseMs = trialBaseMs();

  /** The next deterministic timestamp as an ISO string (one second per call, monotonic). */
  nowIso(): string {
    const ms = this.baseMs + this.clockSeq * 1000;
    this.clockSeq += 1;
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** The next deterministic timestamp as epoch seconds (for git commit headers). */
  nowEpochSec(): number {
    const sec = Math.floor(this.baseMs / 1000) + this.clockSeq;
    this.clockSeq += 1;
    return sec;
  }

  nextSeq(): number {
    this.clockSeq += 1;
    return this.clockSeq;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** Create a repository owned by the viewer; null when the name is taken. */
  createRepo(name: string, isPrivate: boolean, description: string): RepoRec | null {
    const key = this.repoKey(VIEWER.login, name);
    if (this.repos.has(key)) return null;
    this.repoSeq += 1;
    const repo: RepoRec = {
      id: this.repoSeq,
      owner: VIEWER.login,
      name,
      isPrivate,
      description,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      nextNumber: 1,
      createdSeq: this.repoSeq,
      issueBodyCache: new Map(),
      packCache: new Map(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** The viewer's repositories in creation order. */
  listViewerRepos(): RepoRec[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === VIEWER.login)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }

  /** Allocate the next shared issue/PR number for a repository. */
  allocNumber(repo: RepoRec): number {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    return number;
  }

  nextIssueId(): number {
    this.issueSeq += 1;
    return this.issueSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  /** Invalidate every cached serialisation a repository write could have changed. */
  touchRepo(repo: RepoRec): void {
    repo.packCache.clear();
  }

  touchIssue(repo: RepoRec, issue: IssueRec): void {
    repo.issueBodyCache.delete(issue.number);
    issue.updatedAt = this.nowIso();
  }
}

/** The one store instance the whole app shares. */
export const store = new Store();
