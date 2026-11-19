// The GraphQL endpoint (POST /api/graphql): a mini engine over the shared store. Placeholder.

import { sendError, type WebCtx } from './web.ts';

export async function handleGraphql(ctx: WebCtx): Promise<void> {
  void ctx;
  sendError(ctx, 404, 'Not Found');
}
