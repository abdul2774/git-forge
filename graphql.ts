// The GraphQL endpoint (POST /api/graphql): a mini engine — lexer, parser and resolver-based
// executor — over the shared store. It covers exactly the surface gh exercises: viewer, repository
// with issues/pullRequests connections and cursor pagination, node(id:), introspection for the
// types gh feature-detects, and the createIssue / closeIssue / createPullRequest /
// mergePullRequest / addComment mutations. Global ids are opaque, deterministic base64.

import { addComment, createIssue, createPull, mergePull, pullFiles, pullMergeable } from './domain.ts';
import { VIEWER, type IssueRec, type RepoRec, type Store } from './store.ts';
import { isRecord, jsonBody, sendError, sendJson, type WebCtx } from './web.ts';

// ---------------------------------------------------------------- global ids

function globalId(type: string, key: string | number): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon === -1) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function findRepoByDbId(store: Store, dbId: number): RepoRec | null {
  for (const repo of store.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

function findIssueByGlobalId(store: Store, globalNumericId: number): { repo: RepoRec; issue: IssueRec } | null {
  for (const repo of store.repos.values()) {
    for (const issue of repo.issues.values()) {
      if (issue.id === globalNumericId) return { repo, issue };
    }
  }
  return null;
}

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'punct'; value: string };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] as string;
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (/\s|,/.test(char)) {
      index += 1;
      continue;
    }
    if (source.startsWith('...', index)) {
      tokens.push({ kind: 'punct', value: '...' });
      index += 3;
      continue;
    }
    if ('{}()[]:$!@='.includes(char)) {
      tokens.push({ kind: 'punct', value: char });
      index += 1;
      continue;
    }
    if (char === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(index + 3, end) });
        index = end + 3;
        continue;
      }
      let value = '';
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\') {
          const escaped = source[index + 1] as string;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          index += 2;
        } else {
          value += source[index];
          index += 1;
        }
      }
      if (index >= source.length) throw new Error('unterminated string');
      index += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(char)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(index));
      if (match === null) throw new Error(`bad number at ${index}`);
      tokens.push({ kind: 'number', value: Number(match[0]) });
      index += match[0].length;
      continue;
    }
    if (/[_A-Za-z]/.test(char)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(index));
      if (match === null) throw new Error(`bad name at ${index}`);
      tokens.push({ kind: 'name', value: match[0] });
      index += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(char)}`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  name: string;
  alias: string | null;
  args: { name: string; value: ValueNode }[];
  selections: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; typeCondition: string; selections: SelectionNode[] };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.pos < this.tokens.length) {
      if (this.atPunct('{')) {
        operations.push({ operation: 'query', name: null, selections: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'fragment') {
        // Named fragments are parsed and skipped (the suite uses inline fragments only).
        this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected on in fragment definition');
        this.expectName();
        this.parseSelectionSet();
        continue;
      }
      if (keyword !== 'query' && keyword !== 'mutation') throw new Error(`unexpected ${keyword}`);
      let name: string | null = null;
      const ahead = this.peek();
      if (ahead !== undefined && ahead.kind === 'name') name = this.expectName();
      if (this.atPunct('(')) this.parseVariableDefinitions();
      operations.push({ operation: keyword, name, selections: this.parseSelectionSet() });
    }
    return operations;
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.atPunct('=')) {
        this.next();
        this.parseValue();
      }
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.atPunct('!')) this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.atPunct('...')) {
        this.next();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected on in inline fragment');
        const typeCondition = this.expectName();
        selections.push({ kind: 'fragment', typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    const selections = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { name, alias, args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.atPunct('}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value token');
  }
}

// ---------------------------------------------------------------- values and views

type Variables = Record<string, unknown>;

function evalValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

interface GqlObject {
  __typename: string;
  [key: string]: unknown;
}

function userView(): GqlObject {
  return { __typename: 'User', id: globalId('User', VIEWER.id), login: VIEWER.login, name: VIEWER.name, email: VIEWER.email };
}

function repoView(repo: RepoRec): GqlObject {
  return {
    __typename: 'Repository',
    _repo: repo,
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    isPrivate: repo.isPrivate,
  };
}

function issueView(issue: IssueRec): GqlObject {
  return {
    __typename: 'Issue',
    _issue: issue,
    id: globalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
  };
}

function pullView(pull: IssueRec, repo: RepoRec): GqlObject {
  return {
    __typename: 'PullRequest',
    _pull: pull,
    _repo: repo,
    id: globalId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged === true ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged === true,
    headRefName: pull.headRef ?? '',
    baseRefName: pull.baseRef ?? '',
  };
}

// ---------------------------------------------------------------- introspection

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'repository', 'comments', 'labels'],
  PullRequest: [
    'id',
    'number',
    'title',
    'state',
    'body',
    'merged',
    'mergeable',
    'headRefName',
    'baseRefName',
    'files',
    'url',
    'createdAt',
    'updatedAt',
    'author',
  ],
  Repository: [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'issue',
    'issues',
    'pullRequest',
    'pullRequests',
    'description',
    'isPrivate',
    'url',
  ],
  User: ['id', 'login', 'name', 'email'],
  Ref: ['id', 'name', 'prefix', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

function typeView(name: string): GqlObject | null {
  if (TYPE_FIELDS[name] !== undefined) {
    return {
      __typename: '__Type',
      name,
      kind: 'OBJECT',
      fields: (TYPE_FIELDS[name] as string[]).map((field) => ({ __typename: '__Field', name: field })),
      enumValues: null,
    };
  }
  if (ENUM_VALUES[name] !== undefined) {
    return {
      __typename: '__Type',
      name,
      kind: 'ENUM',
      fields: null,
      enumValues: (ENUM_VALUES[name] as string[]).map((value) => ({ __typename: '__EnumValue', name: value })),
    };
  }
  return null;
}

// ---------------------------------------------------------------- cursors

function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${offset}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? 0 : Number(match[1]);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- resolvers

interface GqlCtx {
  store: Store;
  errors: { message: string }[];
}

type Resolver = (obj: GqlObject, args: Record<string, unknown>, ctx: GqlCtx) => unknown;

function repoOf(obj: GqlObject): RepoRec {
  return obj._repo as RepoRec;
}

function issuesConnection(repo: RepoRec, args: Record<string, unknown>): GqlObject {
  let issues = [...repo.issues.values()].filter((issue) => issue.kind === 'issue');
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  let direction = 'DESC';
  if (isRecord(args.orderBy) && typeof args.orderBy.direction === 'string') direction = args.orderBy.direction;
  issues.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : issues.length;
  const start = decodeCursor(args.after);
  const page = issues.slice(start, start + first);
  const hasNextPage = start + page.length < issues.length;
  return {
    __typename: 'IssueConnection',
    nodes: page.map(issueView),
    totalCount: issues.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? encodeCursor(start + 1) : null,
      endCursor: page.length > 0 ? encodeCursor(start + page.length) : null,
    },
  };
}

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userView(),
    repository: (_obj, args, ctx) => {
      const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repoView(repo);
    },
    node: (_obj, args, ctx) => {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (decoded === null) return null;
      if (decoded.type === 'Repository') {
        const repo = findRepoByDbId(ctx.store, Number(decoded.key));
        return repo === null ? null : repoView(repo);
      }
      if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
        const found = findIssueByGlobalId(ctx.store, Number(decoded.key));
        if (found === null) return null;
        return found.issue.kind === 'pull' ? pullView(found.issue, found.repo) : issueView(found.issue);
      }
      return null;
    },
    __type: (_obj, args) => typeView(String(args.name ?? '')),
  },
  Mutation: {
    createIssue: (_obj, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.type === 'Repository' ? findRepoByDbId(ctx.store, Number(decoded.key)) : null;
      if (repo === null) throw new Error('Repository not found for createIssue');
      const result = createIssue(ctx.store, repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : undefined,
      });
      if (!result.ok) throw new Error(result.message);
      return { __typename: 'CreateIssuePayload', issue: issueView(result.issue) };
    },
    closeIssue: (_obj, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      const found = decoded !== null ? findIssueByGlobalId(ctx.store, Number(decoded.key)) : null;
      if (found === null) throw new Error('Issue not found for closeIssue');
      found.issue.state = 'closed';
      ctx.store.touchIssue(found.repo, found.issue);
      return { __typename: 'CloseIssuePayload', issue: issueView(found.issue) };
    },
    createPullRequest: (_obj, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.type === 'Repository' ? findRepoByDbId(ctx.store, Number(decoded.key)) : null;
      if (repo === null) throw new Error('Repository not found for createPullRequest');
      const result = createPull(ctx.store, repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : undefined,
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      if (!result.ok) throw new Error(result.message);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullView(result.pull, repo) };
    },
    mergePullRequest: (_obj, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      const found = decoded !== null ? findIssueByGlobalId(ctx.store, Number(decoded.key)) : null;
      if (found === null || found.issue.kind !== 'pull') throw new Error('Pull request not found for mergePullRequest');
      const result = mergePull(ctx.store, found.repo, found.issue);
      if (!result.ok) throw new Error(result.message);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullView(found.issue, found.repo) };
    },
    addComment: (_obj, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      const found = decoded !== null ? findIssueByGlobalId(ctx.store, Number(decoded.key)) : null;
      if (found === null) throw new Error('Subject not found for addComment');
      const comment = addComment(ctx.store, found.repo, found.issue, String(input.body ?? ''));
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', id: globalId('IssueComment', comment.id), body: comment.body },
        },
      };
    },
  },
  Repository: {
    owner: (obj) => ({ __typename: 'User', id: globalId('User', VIEWER.id), login: repoOf(obj).owner, name: VIEWER.name }),
    defaultBranchRef: (obj) => ({ __typename: 'Ref', name: repoOf(obj).defaultBranch, prefix: 'refs/heads/' }),
    issue: (obj, args) => {
      const found = repoOf(obj).issues.get(Number(args.number));
      return found !== undefined && found.kind === 'issue' ? issueView(found) : null;
    },
    issues: (obj, args) => issuesConnection(repoOf(obj), args),
    pullRequest: (obj, args) => {
      const repo = repoOf(obj);
      const found = repo.issues.get(Number(args.number));
      return found !== undefined && found.kind === 'pull' ? pullView(found, repo) : null;
    },
    pullRequests: (obj, args) => {
      const repo = repoOf(obj);
      let pulls = [...repo.issues.values()].filter((issue) => issue.kind === 'pull');
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : pulls.length;
      pulls = pulls.slice(0, first);
      return { __typename: 'PullRequestConnection', nodes: pulls.map((pull) => pullView(pull, repo)), totalCount: pulls.length };
    },
  },
  PullRequest: {
    mergeable: (obj) => pullMergeable(obj._repo as RepoRec, obj._pull as IssueRec),
    files: (obj, args) => {
      const repo = obj._repo as RepoRec;
      const pull = obj._pull as IssueRec;
      const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : Number.MAX_SAFE_INTEGER;
      const files = pullFiles(repo, pull);
      const nodes = files.slice(0, first).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename }));
      return { __typename: 'PullRequestChangedFileConnection', nodes, totalCount: files.length };
    },
  },
};

// ---------------------------------------------------------------- executor

function executeSelections(
  selections: readonly SelectionNode[],
  obj: GqlObject,
  typeName: string,
  variables: Variables,
  ctx: GqlCtx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (obj.__typename === selection.typeCondition) {
        Object.assign(out, executeSelections(selection.selections, obj, selection.typeCondition, variables, ctx));
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of field.args) args[arg.name] = evalValue(arg.value, variables);
    const resolver = RESOLVERS[typeName]?.[field.name];
    let value: unknown;
    if (resolver !== undefined) {
      try {
        value = resolver(obj, args, ctx);
      } catch (err) {
        ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
        out[key] = null;
        continue;
      }
    } else if (field.name in obj) {
      value = obj[field.name];
    } else {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, field, variables, ctx);
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, variables: Variables, ctx: GqlCtx): unknown {
  if (value === null || value === undefined) return null;
  if (field.selections === null) return value;
  if (Array.isArray(value)) return value.map((entry) => completeValue(entry, field, variables, ctx));
  if (isRecord(value) && typeof value.__typename === 'string') {
    return executeSelections(field.selections, value as GqlObject, value.__typename, variables, ctx);
  }
  return value;
}

function executeOperation(operation: OperationNode, variables: Variables, ctx: GqlCtx): Record<string, unknown> {
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __typename: rootType };
  return executeSelections(operation.selections, root, rootType, variables, ctx);
}

// ---------------------------------------------------------------- HTTP

interface GqlEnvelope {
  data?: Record<string, unknown> | null;
  errors?: { message: string }[];
}

function runOne(store: Store, body: unknown): GqlEnvelope {
  if (!isRecord(body) || typeof body.query !== 'string') {
    return { errors: [{ message: 'A GraphQL request needs a query string' }] };
  }
  const variables: Variables = isRecord(body.variables) ? body.variables : {};
  let operations: OperationNode[];
  try {
    operations = new Parser(lex(body.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : null;
  const operation = operations.find((candidate) => operationName === null || candidate.name === operationName) ?? operations[0];
  if (operation === undefined) return { errors: [{ message: 'No operation in the document' }] };
  const ctx: GqlCtx = { store, errors: [] };
  const data = executeOperation(operation, variables, ctx);
  const envelope: GqlEnvelope = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

export async function handleGraphql(ctx: WebCtx): Promise<void> {
  if (!ctx.authed) {
    sendError(ctx, 401, 'Bad credentials');
    return;
  }
  const parsed = await jsonBody(ctx);
  if (!parsed.ok) {
    sendJson(ctx, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed.value)) {
    sendJson(ctx, 200, parsed.value.map((entry) => runOne(ctx.store, entry)));
    return;
  }
  sendJson(ctx, 200, runOne(ctx.store, parsed.value));
}
