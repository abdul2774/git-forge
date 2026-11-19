#!/usr/bin/env bash
# One-command local evaluation for this forge: boots a FRESH forge process
# and runs the competition kit's own conformance suite against it
# (sdk/run.ts — byte-identical to the sealed grader). With --perf it also
# runs the four benchmark workloads.
#
#   npm test        -> conformance (120 checks)
#   npm run bench   -> conformance + performance workloads
#
# The suite is stateful per process, so every run starts a new forge.
# FORGE_KIT_DIR overrides where the unpacked kit lives.
set -euo pipefail
cd "$(dirname "$0")/.."

KIT_DIR="${FORGE_KIT_DIR:-$HOME/workspace/makefun/github-core-clone-01-kit/github-core-clone-01-kit}"
PORT="${DEV_PORT:-8734}"
TOKEN="dev-token"

# Free the port if a previous harness instance is still around.
PID="$(ss -ltnp 2>/dev/null | grep ":${PORT} " | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
if [ -n "${PID}" ]; then
  kill "${PID}" 2>/dev/null || true
  sleep 0.7
fi

MAKEFUN_SHOP_TOKEN="${TOKEN}" DEV_PORT="${PORT}" \
  node --experimental-strip-types tools/dev-server.ts > /tmp/forge-harness.log 2>&1 &
SERVER_PID=$!
trap 'kill ${SERVER_PID} 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:${PORT}/healthz" > /dev/null 2>&1; then break; fi
  sleep 0.25
done

EXTRA=""
if [ "${1:-}" = "--perf" ]; then EXTRA="--perf"; fi

node --experimental-strip-types "${KIT_DIR}/sdk/run.ts" \
  --url "http://127.0.0.1:${PORT}" --token "${TOKEN}" ${EXTRA}
