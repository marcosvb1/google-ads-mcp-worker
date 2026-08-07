#!/usr/bin/env bash
# Load Google Ads credentials into Worker secrets without printing them.
#
# Values are piped straight from the source file into `wrangler secret put`.
# Nothing is echoed, and nothing is written to shell history.
#
#   ./scripts/set-secrets.sh                                  # default gcloud ADC path
#   ./scripts/set-secrets.sh path/to/credentials.json
#   ./scripts/set-secrets.sh --local path/to/credentials.json # write .dev.vars instead
#
# The JSON may be either shape:
#   • gcloud ADC          — from `gcloud auth application-default login`
#                           (top-level client_id / client_secret / refresh_token)
#   • OAuth client secret — downloaded from Google Cloud Console
#                           (nested under "installed" or "web"; has no refresh
#                           token, so you will be prompted for one)
set -euo pipefail

LOCAL=0
if [[ "${1:-}" == "--local" ]]; then
  LOCAL=1
  shift
fi

SOURCE="${1:-$HOME/.config/gcloud/application_default_credentials.json}"

if [[ ! -f "$SOURCE" ]]; then
  cat >&2 <<EOF
No credentials file at: $SOURCE

Generate one with:
  gcloud auth application-default login \\
    --scopes=https://www.googleapis.com/auth/adwords \\
    --client-id-file=/path/to/your-oauth-client.json

or pass the path explicitly:
  $0 /path/to/credentials.json
EOF
  exit 1
fi

# Pull one field without ever putting it on a command line or in the environment.
field() {
  python3 -c '
import json, sys
data = json.load(open(sys.argv[1]))
node = data.get("installed") or data.get("web") or data
value = node.get(sys.argv[2], "")
sys.stdout.write(value if isinstance(value, str) else "")
' "$SOURCE" "$1"
}

CLIENT_ID="$(field client_id)"
CLIENT_SECRET="$(field client_secret)"
REFRESH_TOKEN="$(field refresh_token)"

[[ -n "$CLIENT_ID" ]] || { echo "No client_id found in $SOURCE" >&2; exit 1; }
[[ -n "$CLIENT_SECRET" ]] || { echo "No client_secret found in $SOURCE" >&2; exit 1; }

if [[ -z "$REFRESH_TOKEN" ]]; then
  echo "No refresh_token in that file (it looks like a client-secret download)."
  read -rsp "Paste a refresh token with the adwords scope: " REFRESH_TOKEN
  echo
fi

read -rsp "Google Ads developer token: " DEVELOPER_TOKEN
echo
[[ -n "$DEVELOPER_TOKEN" ]] || { echo "A developer token is required." >&2; exit 1; }

if [[ $LOCAL -eq 1 ]]; then
  umask 077
  {
    printf 'GOOGLE_ADS_CLIENT_ID="%s"\n' "$CLIENT_ID"
    printf 'GOOGLE_ADS_CLIENT_SECRET="%s"\n' "$CLIENT_SECRET"
    printf 'GOOGLE_ADS_REFRESH_TOKEN="%s"\n' "$REFRESH_TOKEN"
    printf 'GOOGLE_ADS_DEVELOPER_TOKEN="%s"\n' "$DEVELOPER_TOKEN"
    printf 'MCP_SHARED_SECRET="%s"\n' "$(openssl rand -hex 32)"
  } > .dev.vars
  echo "Wrote .dev.vars (gitignored), including a fresh random MCP_SHARED_SECRET."
  echo "Run: npm run dev && ./scripts/smoke.sh"
  exit 0
fi

put() { printf '%s' "$2" | npx wrangler secret put "$1" >/dev/null && echo "  set $1"; }

echo "Setting Worker secrets…"
put GOOGLE_ADS_CLIENT_ID "$CLIENT_ID"
put GOOGLE_ADS_CLIENT_SECRET "$CLIENT_SECRET"
put GOOGLE_ADS_REFRESH_TOKEN "$REFRESH_TOKEN"
put GOOGLE_ADS_DEVELOPER_TOKEN "$DEVELOPER_TOKEN"

echo
echo "Done. Remaining steps:"
echo "  • Set an auth gate, or the server will refuse every request:"
echo "      npx wrangler secret put MCP_SHARED_SECRET"
echo "  • If your accounts sit under a manager, set GOOGLE_ADS_LOGIN_CUSTOMER_ID in wrangler.jsonc"
echo "  • npx wrangler deploy"
