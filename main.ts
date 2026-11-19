// Entrypoint for the forge's trial lifecycle.
//
// The harness starts this process beside its own env server and tells us
// where that server lives through MAKEFUN_ENV_URL. Our side of the contract:
//   1. Bind an ephemeral port (never a fixed one) and report it by POSTing
//      {"port": <port>} to $MAKEFUN_ENV_URL/register.
//   2. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true},
//      then close our server and exit 0.
// Without MAKEFUN_ENV_URL there is no harness to talk to, so we exit 1
// immediately instead of serving into the void.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envUrl === '') {
  console.error('[forge] MAKEFUN_ENV_URL is not set: no harness to register with, exiting');
  process.exit(1);
}

/** Sleep for `ms` milliseconds. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff schedule: start small, double each round, cap at a few seconds. */
function backoff(round: number): number {
  return Math.min(250 * 2 ** round, 2000);
}

/** POST our bound port to the env's /register, retrying until it accepts. */
async function register(port: number): Promise<void> {
  for (let round = 0; ; round += 1) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
      // 200: recorded. 409: an earlier attempt of ours already won the
      // registration and only its answer was lost — just as good.
      if (res.status === 200 || res.status === 409) {
        await res.text();
        return;
      }
      // 400/405 mean the request itself breaks the contract; sending the
      // same bytes again cannot fix that, so fail loudly instead.
      if (res.status === 400 || res.status === 405) {
        console.error(`[forge] register refused by the harness: HTTP ${res.status}`);
        process.exit(1);
      }
    } catch {
      // Network error or timeout: the harness may still be coming up.
    }
    await wait(backoff(round));
  }
}

/** Poll the env's /done until it reports the trial is finished. */
async function waitForDone(): Promise<void> {
  for (let round = 0; ; round += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
        round = 0; // A healthy answer resets the failure backoff.
      }
    } catch {
      // A failed poll is not fatal: wait and ask again.
    }
    await wait(backoff(round));
  }
}

const server = createApp();

server.listen(0, async () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await register(port);
  await waitForDone();
  server.close(() => process.exit(0));
});
