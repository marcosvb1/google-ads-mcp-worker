#!/usr/bin/env bash
# Smoke-test a running server: auth gate, protocol handshake, tool surface.
#
#   ./scripts/smoke.sh                                   # local dev, reads .dev.vars
#   ./scripts/smoke.sh https://your-worker.workers.dev "$TOKEN"
#
# Exercises the 2026-07-28 path and the 2025-era fallback. Does not need working
# Google credentials — it never calls a tool that reaches Google.
set -uo pipefail

BASE="${1:-http://localhost:8787}"
TOKEN="${2:-}"

if [[ -z "$TOKEN" && -f .dev.vars ]]; then
  TOKEN="$(grep -E '^MCP_SHARED_SECRET=' .dev.vars | head -1 | cut -d= -f2- | tr -d '"')"
fi

PROTOCOL="2026-07-28"
META='"_meta":{"io.modelcontextprotocol/protocolVersion":"'"$PROTOCOL"'","io.modelcontextprotocol/clientCapabilities":{}}'
pass=0
fail=0

check() { # name expected actual
  if [[ "$2" == "$3" ]]; then
    printf '  ok    %s\n' "$1"
    pass=$((pass + 1))
  else
    printf '  FAIL  %s (expected %s, got %s)\n' "$1" "$2" "$3"
    fail=$((fail + 1))
  fi
}

# rpc <method> <tool-name-or-empty> <json-body>
rpc() {
  local args=(-sS -X POST "$BASE/mcp"
    -H 'content-type: application/json'
    -H 'accept: application/json, text/event-stream'
    -H "authorization: Bearer $TOKEN"
    -H "MCP-Protocol-Version: $PROTOCOL"
    -H "Mcp-Method: $1")
  [[ -n "$2" ]] && args+=(-H "Mcp-Name: $2")
  args+=(-d "$3")
  curl "${args[@]}"
}

status() { curl -sS -o /dev/null -w '%{http_code}' "$@"; }

echo "Smoke test against $BASE"

check "liveness" "200" "$(status "$BASE/")"

check "unauthenticated /mcp is refused" "401" \
  "$(status -X POST "$BASE/mcp" -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"

check "wrong bearer token is refused" "401" \
  "$(status -X POST "$BASE/mcp" -H 'content-type: application/json' \
     -H 'authorization: Bearer definitely-wrong' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')"

check "GET /mcp is 405 (no sessions in this revision)" "405" \
  "$(status -X GET "$BASE/mcp" -H "authorization: Bearer $TOKEN")"

body='{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{'"$META"'}}'
discover="$(rpc server/discover '' "$body")"
check "server/discover advertises $PROTOCOL" "$PROTOCOL" \
  "$(printf '%s' "$discover" | grep -o '[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}' | head -1)"

body='{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{'"$META"'}}'
tools="$(rpc tools/list '' "$body")"
check "tools/list exposes 4 read-only tools" "4" \
  "$(printf '%s' "$tools" | grep -o '"readOnlyHint":true' | wc -l | tr -d ' ')"
check "no mutating tool is exposed" "0" \
  "$(printf '%s' "$tools" | grep -o '"readOnlyHint":false' | wc -l | tr -d ' ')"

legacy="$(curl -sS -X POST "$BASE/mcp" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -H "authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')"
check "2025-era client still served" "yes" \
  "$(printf '%s' "$legacy" | grep -q 'list_accessible_customers' && echo yes || echo no)"

args='{"customer_id":"1234567890","query":"DELETE FROM campaign"}'
body='{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":'"$args"','"$META"'}}'
check "non-SELECT query is refused" "yes" \
  "$(rpc tools/call search "$body" | grep -q 'Only SELECT queries are supported' && echo yes || echo no)"

args='{"customer_id":"123","query":"SELECT campaign.id FROM campaign"}'
body='{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search","arguments":'"$args"','"$META"'}}'
check "malformed customer id is refused" "yes" \
  "$(rpc tools/call search "$body" | grep -q 'expected 10 digits' && echo yes || echo no)"

args='{"customer_id":"1234567890","query":"SELECT campaign.id FROM campaign","page_size":99999}'
body='{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"search","arguments":'"$args"','"$META"'}}'
check "oversized page_size is rejected by schema" "yes" \
  "$(rpc tools/call search "$body" | grep -q 'Too big' && echo yes || echo no)"

echo
echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
