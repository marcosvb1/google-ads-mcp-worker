#!/usr/bin/env bash
# Start a local server, smoke-test it, tear it down. One command, one terminal.
#
#   npm run verify
#
# Use scripts/smoke.sh directly when you already have a server running, or to
# test a deployed Worker.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

PORT="${PORT:-8787}"
BASE="http://localhost:$PORT"
LOG="$(mktemp -t google-ads-mcp-worker)"
PID=""

cleanup() {
  [[ -n "$PID" ]] && kill "$PID" 2>/dev/null
  # wrangler spawns a workerd child that outlives the parent otherwise.
  pkill -P "${PID:-0}" 2>/dev/null
  rm -f "$LOG"
}
trap cleanup EXIT

if [[ ! -f .dev.vars ]]; then
  cat >&2 <<'EOF'
No .dev.vars found.

The smoke test needs an auth gate configured (it checks that unauthenticated
requests are refused). Create one with:

  cp .dev.vars.example .dev.vars

and set at least MCP_SHARED_SECRET. Google credentials are optional -- nothing
in the smoke test calls Google.
EOF
  exit 1
fi

echo "Starting a local server on port $PORT..."
npx wrangler dev --port "$PORT" >"$LOG" 2>&1 &
PID=$!

for _ in $(seq 1 60); do
  [[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/" 2>/dev/null)" == "200" ]] && break
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "The server exited before it was ready. Its output:" >&2
    tail -25 "$LOG" >&2
    exit 1
  fi
  sleep 1
done

if [[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$BASE/" 2>/dev/null)" != "200" ]]; then
  echo "The server did not become ready within 60s. Its output:" >&2
  tail -25 "$LOG" >&2
  exit 1
fi

echo
./scripts/smoke.sh "$BASE"
