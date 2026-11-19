// Dev-only launcher for the local test harness: imports createApp() and
// listens on a fixed local port. The graded entrypoint stays main.ts; this
// file exists so tools/run-checks.sh can boot a fresh forge without the
// trial lifecycle (no MAKEFUN_ENV_URL registration).
import { createApp } from '../app.ts';

const port = Number(process.env.DEV_PORT ?? '8734');
const server = createApp();
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`[harness] forge listening on http://127.0.0.1:${port}\n`);
});
