// The MCP endpoint (POST /mcp): JSON-RPC 2.0 over the shared store. Placeholder until its stage.

import { sendError, type WebCtx } from './web.ts';

export async function handleMcp(ctx: WebCtx): Promise<void> {
  void ctx;
  sendError(ctx, 404, 'Not Found');
}
