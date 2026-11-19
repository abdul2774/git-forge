// The MCP endpoint (POST /mcp): JSON-RPC 2.0, modern era (server/discover) with the legacy
// initialize handshake answered too. Tools run against the same store and domain operations as
// REST, so an object created over MCP reads back over REST with the same ids. tools/list answers
// a module-level constant, byte-identical across calls by construction.

import { createIssue, createPull, issueView, mergePull, pullView, repoView } from './domain.ts';
import { VIEWER, type RepoRec } from './store.ts';
import { isRecord, readBody, sendJson, type WebCtx } from './web.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'cimol-forge', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function tool(name: string, description: string, properties: Record<string, string>, required: string[]): ToolDef {
  const props: Record<string, { type: string; description: string }> = {};
  for (const [key, type] of Object.entries(properties)) props[key] = { type, description: `${key} parameter` };
  return { name, description, inputSchema: { type: 'object', properties: props, required } };
}

/** The six tools, exactly as tools/list answers them (a constant: idempotent by construction). */
const TOOLS: readonly ToolDef[] = Object.freeze([
  tool(
    'create_repo',
    'Create a new repository owned by the authenticated user',
    { name: 'string', description: 'string', private: 'boolean', owner: 'string' },
    ['name'],
  ),
  tool('get_repo', 'Get a repository by owner and name', { owner: 'string', repo: 'string' }, ['owner', 'repo']),
  tool(
    'create_issue',
    'Create an issue in a repository',
    { owner: 'string', repo: 'string', title: 'string', body: 'string' },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List the issues of a repository, optionally filtered by state',
    { owner: 'string', repo: 'string', state: 'string' },
    ['owner', 'repo'],
  ),
  tool(
    'create_pull_request',
    'Create a pull request from a head branch into a base branch',
    { owner: 'string', repo: 'string', title: 'string', body: 'string', head: 'string', base: 'string' },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'merge_pull_request',
    'Squash-merge a pull request by number',
    { owner: 'string', repo: 'string', pull_number: 'number' },
    ['owner', 'repo', 'pull_number'],
  ),
]);

type RpcId = string | number | null;

interface RpcError {
  code: number;
  message: string;
}

function rpcResult(ctx: WebCtx, id: RpcId, result: unknown): void {
  sendJson(ctx, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(ctx: WebCtx, id: RpcId, error: RpcError, status = 200): void {
  sendJson(ctx, status, { jsonrpc: '2.0', id, error });
}

function toolSuccess(ctx: WebCtx, id: RpcId, view: unknown): void {
  rpcResult(ctx, id, {
    content: [{ type: 'text', text: JSON.stringify(view) }],
    structuredContent: view,
    isError: false,
  });
}

function toolFailure(ctx: WebCtx, id: RpcId, message: string): void {
  rpcResult(ctx, id, {
    content: [{ type: 'text', text: message }],
    isError: true,
  });
}

function findRepo(ctx: WebCtx, args: Record<string, unknown>): RepoRec | null {
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER.login;
  const repo = typeof args.repo === 'string' ? args.repo : '';
  return ctx.store.getRepo(owner, repo) ?? null;
}

function runTool(ctx: WebCtx, id: RpcId, name: string, args: Record<string, unknown>): void {
  switch (name) {
    case 'create_repo': {
      const repoName = args.name as string;
      const created = ctx.store.createRepo(
        repoName,
        typeof args.private === 'boolean' ? args.private : false,
        typeof args.description === 'string' ? args.description : '',
      );
      if (created === null) {
        toolFailure(ctx, id, `Repository ${repoName} already exists`);
        return;
      }
      toolSuccess(ctx, id, repoView(created));
      return;
    }
    case 'get_repo': {
      const repo = findRepo(ctx, args);
      if (repo === null) {
        toolFailure(ctx, id, 'Repository not found');
        return;
      }
      toolSuccess(ctx, id, repoView(repo));
      return;
    }
    case 'create_issue': {
      const repo = findRepo(ctx, args);
      if (repo === null) {
        toolFailure(ctx, id, 'Repository not found');
        return;
      }
      const result = createIssue(ctx.store, repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : undefined,
      });
      if (!result.ok) {
        toolFailure(ctx, id, result.message);
        return;
      }
      toolSuccess(ctx, id, issueView(result.issue));
      return;
    }
    case 'list_issues': {
      const repo = findRepo(ctx, args);
      if (repo === null) {
        toolFailure(ctx, id, 'Repository not found');
        return;
      }
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()].filter((issue) => issue.kind === 'issue');
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      toolSuccess(ctx, id, issues.map(issueView));
      return;
    }
    case 'create_pull_request': {
      const repo = findRepo(ctx, args);
      if (repo === null) {
        toolFailure(ctx, id, 'Repository not found');
        return;
      }
      const result = createPull(ctx.store, repo, {
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : undefined,
        head: args.head as string,
        base: args.base as string,
      });
      if (!result.ok) {
        toolFailure(ctx, id, result.message);
        return;
      }
      toolSuccess(ctx, id, pullView(result.pull));
      return;
    }
    case 'merge_pull_request': {
      const repo = findRepo(ctx, args);
      if (repo === null) {
        toolFailure(ctx, id, 'Repository not found');
        return;
      }
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = Number.isInteger(number) ? repo.issues.get(number) : undefined;
      if (pull === undefined || pull.kind !== 'pull') {
        toolFailure(ctx, id, 'Pull request not found');
        return;
      }
      const result = mergePull(ctx.store, repo, pull);
      if (!result.ok) {
        toolFailure(ctx, id, result.message);
        return;
      }
      toolSuccess(ctx, id, pullView(pull));
      return;
    }
    default:
      rpcError(ctx, id, { code: -32602, message: `Unknown tool: ${name}` });
  }
}

export async function handleMcp(ctx: WebCtx): Promise<void> {
  // Authentication is decided before anything else, even before the body is read.
  if (!ctx.authed) {
    rpcError(ctx, null, { code: -32001, message: 'Unauthorized' }, 401);
    return;
  }
  const raw = await readBody(ctx);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    rpcError(ctx, null, { code: -32700, message: 'Parse error' }, 400);
    return;
  }
  if (!isRecord(parsed)) {
    rpcError(ctx, null, { code: -32600, message: 'Invalid Request' }, 400);
    return;
  }

  // A notification (no id member) is accepted and answered with an empty 202.
  if (!('id' in parsed) || parsed.id === undefined) {
    ctx.res.writeHead(202, { 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return;
  }

  const id = (typeof parsed.id === 'string' || typeof parsed.id === 'number' ? parsed.id : null) as RpcId;
  const method = typeof parsed.method === 'string' ? parsed.method : '';
  const params = isRecord(parsed.params) ? parsed.params : {};

  switch (method) {
    case 'server/discover':
      rpcResult(ctx, id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18';
      rpcResult(ctx, id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    }
    case 'ping':
      rpcResult(ctx, id, {});
      return;
    case 'tools/list':
      rpcResult(ctx, id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const def = TOOLS.find((candidate) => candidate.name === toolName);
      if (def === undefined) {
        rpcError(ctx, id, { code: -32602, message: `Unknown tool: ${toolName}` });
        return;
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      for (const required of def.inputSchema.required) {
        if (args[required] === undefined || args[required] === null) {
          rpcError(ctx, id, { code: -32602, message: `Missing required argument: ${required}` });
          return;
        }
      }
      runTool(ctx, id, toolName, args);
      return;
    }
    default:
      rpcError(ctx, id, { code: -32601, message: `Method not found: ${method}` });
  }
}
