// The forge's HTTP surface: a health probe, REST v3 (/api/v3), GraphQL (/api/graphql), the MCP
// endpoint (/mcp) and git smart HTTP (/{owner}/{repo}.git/...), all over one shared in-memory
// store. app.ts only routes; each surface lives in its own module. main.ts is the entry <-> env
// lifecycle and stays exactly as the starter ships it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGitHttp } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, segmentsOf } from './rest.ts';
import { store } from './store.ts';
import { makeCtx, sendError, sendJson, type WebCtx } from './web.ts';

async function dispatch(ctx: WebCtx): Promise<void> {
  const { method, path } = ctx;

  // The env's boot check calls this twice: 200 {"ok":true}.
  if (method === 'GET' && path === '/healthz') {
    sendJson(ctx, 200, { ok: true });
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    await handleRest(ctx, segmentsOf(path.slice('/api/v3'.length)));
    return;
  }

  if (path === '/api/graphql' && method === 'POST') {
    await handleGraphql(ctx);
    return;
  }

  if (path === '/mcp' && method === 'POST') {
    await handleMcp(ctx);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}.
  const segments = segmentsOf(path);
  if (segments.length >= 3 && (segments[1] as string).endsWith('.git')) {
    const owner = segments[0] as string;
    const repoName = (segments[1] as string).slice(0, -'.git'.length);
    await handleGitHttp(ctx, owner, repoName, segments.slice(2));
    return;
  }

  sendError(ctx, 404, 'Not Found');
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const ctx = makeCtx(req, res, store);
    dispatch(ctx).catch(() => {
      // A handler failure must still answer in JSON, never hang or crash the process.
      try {
        if (!res.headersSent) sendError(ctx, 500, 'Internal Server Error');
        else if (!res.writableEnded) res.end();
      } catch {
        // The socket is already gone; nothing more to do.
      }
    });
  });
}
