// Git smart HTTP (/{owner}/{repo}.git/...): advertisement, upload-pack, receive-pack. Placeholder.

import { sendError, type WebCtx } from './web.ts';

export async function handleGitHttp(ctx: WebCtx, owner: string, repoName: string, tail: readonly string[]): Promise<void> {
  void owner;
  void repoName;
  void tail;
  sendError(ctx, 404, 'Not Found');
}
