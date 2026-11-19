// HTTP plumbing shared by every surface: request ids on every response, JSON discipline (never
// HTML), bearer auth against MAKEFUN_SHOP_TOKEN, and bounded body reads. The protocol checks read
// these behaviours off the wire, so they live in exactly one place.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestSeq = 0;

/** A non-empty, unique-per-process request id (the protocol check only requires non-empty). */
export function nextRequestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq.toString(16).padStart(8, '0')}`;
}

export interface WebCtx {
  req: IncomingMessage;
  res: ServerResponse;
  store: Store;
  method: string;
  url: URL;
  path: string;
  /** The request's Host header (Link headers are built from it, same-origin by construction). */
  host: string;
  /** Whether the request presented the right bearer token. */
  authed: boolean;
  requestId: string;
  bodyPromise: Promise<Buffer> | null;
  bodyCache: Buffer | null;
}

/** Whether the request's Authorization header carries the trial token. */
export function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return false;
  const presented = (match[1] as string).trim();
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return presented !== '';
  return presented === expected;
}

export function makeCtx(req: IncomingMessage, res: ServerResponse, store: Store): WebCtx {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    url = new URL('/', 'http://entry');
  }
  return {
    req,
    res,
    store,
    method: req.method ?? 'GET',
    url,
    path: url.pathname,
    host: req.headers.host ?? '127.0.0.1',
    authed: isAuthed(req),
    requestId: nextRequestId(),
    bodyPromise: null,
    bodyCache: null,
  };
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Read the whole request body (bounded; git packs are the big ones). */
export function readBody(ctx: WebCtx): Promise<Buffer> {
  if (ctx.bodyCache !== null) return Promise.resolve(ctx.bodyCache);
  if (ctx.bodyPromise === null) {
    ctx.bodyPromise = new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      ctx.req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          reject(new Error('request body too large'));
          ctx.req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      ctx.req.on('end', () => {
        ctx.bodyCache = Buffer.concat(chunks);
        resolve(ctx.bodyCache);
      });
      ctx.req.on('error', reject);
    });
  }
  return ctx.bodyPromise;
}

/** The request body parsed as JSON: {ok:false} for an absent or malformed body. */
export async function jsonBody(ctx: WebCtx): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const body = await readBody(ctx);
  if (body.length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Send a JSON response with the standard headers (request id always, JSON content type always). */
export function sendJson(ctx: WebCtx, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...headers,
  });
  ctx.res.end(text);
}

/** Send a GitHub-shaped error: a JSON object with a non-empty string message. */
export function sendError(ctx: WebCtx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

/** Send a bodyless response (204). */
export function sendEmpty(ctx: WebCtx, status: number): void {
  ctx.res.writeHead(status, { 'x-github-request-id': ctx.requestId });
  ctx.res.end();
}

/** Send raw bytes with an explicit content type (git smart HTTP). */
export function sendBytes(ctx: WebCtx, status: number, body: Buffer, contentType: string): void {
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': ctx.requestId,
  });
  ctx.res.end(body);
}

/** A field of a JSON object body as a string (undefined when absent or not a string). */
export function strField(value: unknown, field: string): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const found = (value as Record<string, unknown>)[field];
  return typeof found === 'string' ? found : undefined;
}

/** A field of a JSON object body as a boolean (undefined when absent or not a boolean). */
export function boolField(value: unknown, field: string): boolean | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const found = (value as Record<string, unknown>)[field];
  return typeof found === 'boolean' ? found : undefined;
}

/** Whether a parsed JSON value is a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
