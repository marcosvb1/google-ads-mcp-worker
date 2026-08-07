# google-ads-mcp-worker

A **remote** [MCP](https://modelcontextprotocol.io) server for the Google Ads API, running on Cloudflare Workers.

Read-only access to your Google Ads data through GAQL, reachable over HTTPS from any MCP client — no local process, no Python environment, no container. Implements the [`2026-07-28` MCP specification](https://modelcontextprotocol.io/specification/2026-07-28/): stateless Streamable HTTP, `server/discover`, no session ids.

> **Status: early.** The protocol layer is exercised by tests and by the smoke script below. The tool surface is small on purpose and will grow with real use. Issues and PRs welcome.

## Why this exists

Google ships an [official MCP server](https://github.com/googleads/google-ads-mcp) (Python, Apache-2.0). It is good, and if you want a local stdio server you should probably use it. This project is a different shape:

| | `googleads/google-ads-mcp` | this project |
|---|---|---|
| Runtime | Python, local `stdio` (remote via Cloud Run) | Cloudflare Workers, remote-first |
| MCP revision | 2025-era FastMCP | **2026-07-28** (stateless, `server/discover`) |
| Ads API version | pinned in code (`v24` at time of writing) | **`v25`**, set by a config var — bump without a code change |
| Ops | you run and patch a process | `wrangler deploy`, then nothing |
| Cold start | Python interpreter | edge isolate, ~ms |
| Auth to the server | OAuth proxy | Cloudflare Access JWT, bearer token, or open |
| MCC expansion | not exposed | `list_customer_clients` |

Neither replaces the other. Use whichever matches how you deploy.

## Tools

All four are read-only (`readOnlyHint: true`). This server exposes **no mutating tools** — it never calls a `mutate` endpoint, so it cannot change your campaigns, budgets, or bids.

| Tool | What it does |
|---|---|
| `list_accessible_customers` | Customer ids the credentials can reach directly. Start here. |
| `list_customer_clients` | Expand a manager (MCC) account into its client accounts, with name, currency and time zone. |
| `search` | Run a GAQL query against one account. Paginated, with `next_page_token`. |
| `get_resource_metadata` | Selectable/filterable/sortable fields of a resource, plus compatible metrics and segments. |

The server also ships `instructions` (served in `server/discover`) telling the model the things that otherwise cost a failed query each: metrics don't exist on manager accounts, money is in micros, query fields are snake_case while the response is camelCase.

## Quickstart

### 1. Google Ads credentials

You need four values:

- **Developer token** — Google Ads manager account → *Tools & Settings → API Center*. Note the [access levels](https://developers.google.com/google-ads/api/docs/access-levels): *Test* reaches test accounts only, *Explorer* is capped at 2,880 operations/day and blocks several services, *Basic* gives 15,000/day, *Standard* is uncapped.
- **OAuth client id and secret** — Google Cloud Console → *APIs & Services → Credentials → OAuth client ID*, with the Google Ads API enabled on the project. Choose **Desktop app** unless you have a reason not to: it allows the loopback redirect the helper below uses, with nothing to register.
- **Refresh token** — for the scope `https://www.googleapis.com/auth/adwords`. If you don't have one:

  ```bash
  node scripts/get-refresh-token.mjs path/to/your-oauth-client.json
  ```

  It runs the consent flow against a local loopback and writes the client id, secret and refresh token into `.dev.vars` — no copy-pasting a token through your scrollback. Pass `--print` if you'd rather handle it yourself.

Two things that catch people out:

- A **service account will not work** without domain-wide delegation. The Google Ads API expects a user credential.
- While your OAuth consent screen is in **Testing**, refresh tokens **expire after 7 days**. Publish the app before you rely on one for a deployed server, or the Worker starts failing with `invalid_grant` a week later.

### 2. Install and configure

```bash
git clone https://github.com/marcosvb1/google-ads-mcp-worker
cd google-ads-mcp-worker
npm install
cp .dev.vars.example .dev.vars   # fill it in
```

### 3. Run it locally

```bash
npm run dev
```

Or check everything in one command — it starts a server, smoke-tests it and shuts it down:

```bash
npm run verify
```

To poke at it by hand, point the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) at `http://localhost:8787/mcp` (`npm run inspect`). `./scripts/smoke.sh` tests a server you are already running, or a deployed one:

```bash
./scripts/smoke.sh https://your-worker.workers.dev "$TOKEN"
```

### 4. Deploy

Load the four Google secrets straight from a credentials file, without them passing through your terminal:

```bash
./scripts/set-secrets.sh path/to/credentials.json
```

Or set each one by hand:

```bash
npx wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN
npx wrangler secret put GOOGLE_ADS_CLIENT_ID
npx wrangler secret put GOOGLE_ADS_CLIENT_SECRET
npx wrangler secret put GOOGLE_ADS_REFRESH_TOKEN
```

Then pick an auth gate — **without one the server refuses every request** — and ship:

```bash
npx wrangler secret put MCP_SHARED_SECRET
npx wrangler deploy
```

## Serving more than one manager account

Developer tokens are issued **per manager account** and carry their own daily operation quota, and a client's MCC usually arrives with its own token and its own login. So "which credentials" is a property of the account being queried, not of the deployment.

Suffix any credential variable with `_<PROFILE>` to add a profile:

```bash
# default profile
npx wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN

# profile "globex" — its own token and manager, reusing the default login
npx wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN_GLOBEX
# GOOGLE_ADS_LOGIN_CUSTOMER_ID_GLOBEX goes in wrangler.jsonc (not a secret)
```

Or in one step, per profile:

```bash
./scripts/set-secrets.sh --profile globex path/to/credentials.json
```

Then every tool takes a `profile` argument. It is typed as an enum of the profiles you actually configured, so a wrong value fails schema validation with the real list rather than as a confusing permission error from Google. Anything a profile leaves unset is **inherited from the default**, so sharing one Google login across several managers costs one variable per profile. Results echo back which profile served them.

With a single profile configured, the argument is not advertised at all — nothing to think about until you need it.

## Authentication

Two separate questions, easy to conflate:

1. **How the Worker talks to Google** — one set of credentials, held as Worker secrets. Every caller of this server shares that identity.
2. **Who may call the Worker** — configured below. Because of (1), this is the gate that matters: whoever reaches `/mcp` can read whatever those credentials can read.

Three modes, resolved in order. **With none configured the server denies every request** — that is deliberate.

| Mode | Set | How callers authenticate |
|---|---|---|
| Cloudflare Access | `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` | Access does the OAuth; the Worker verifies the `Cf-Access-Jwt-Assertion` JWT against your team's JWKS |
| Bearer token | `MCP_SHARED_SECRET` | `Authorization: Bearer <token>` |
| Open | `MCP_ALLOW_UNAUTHENTICATED="true"` | none — local development only |

Narrow the blast radius further with `GOOGLE_ADS_ALLOWED_CUSTOMER_IDS`, a comma-separated allowlist of the accounts this deployment may query. Any other id is refused before a request reaches Google.

### If you put it behind a Cloudflare MCP Portal

A [MCP Server Portal](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/) gives you tool curation, per-call logging and a single endpoint for several servers. It is **not** a security perimeter for this Worker: Cloudflare's own documentation warns that blocked users can still reach the server's direct URL and bypass the Access policy. Keep `MCP_SHARED_SECRET` set (the portal stores it as the upstream credential), or configure Access on the Worker itself.

## Connecting a client

```json
{
  "mcpServers": {
    "google-ads": {
      "type": "http",
      "url": "https://google-ads-mcp-worker.<your-subdomain>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <MCP_SHARED_SECRET>" }
    }
  }
}
```

Clients that predate the `2026-07-28` revision still work: the handler serves 2025-era requests through its stateless fallback. `GET` and `DELETE` on `/mcp` answer `405`, since those were session operations and there are no sessions.

## Configuration reference

| Variable | Kind | Default | Notes |
|---|---|---|---|
| `GOOGLE_ADS_DEVELOPER_TOKEN` | secret | — | required |
| `GOOGLE_ADS_CLIENT_ID` | secret | — | required |
| `GOOGLE_ADS_CLIENT_SECRET` | secret | — | required |
| `GOOGLE_ADS_REFRESH_TOKEN` | secret | — | required, scope `adwords` |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | var | — | manager account id, digits only |
| `GOOGLE_ADS_API_VERSION` | var | `v25` | see the version note below |
| `GOOGLE_ADS_ALLOWED_CUSTOMER_IDS` | var | — | comma-separated allowlist |
| `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` | var | — | enables Cloudflare Access mode |
| `MCP_SHARED_SECRET` | secret | — | enables bearer mode |
| `MCP_ALLOW_UNAUTHENTICATED` | var | — | `"true"` disables the gate |

Any of the five `GOOGLE_ADS_*` credential variables may carry a `_<PROFILE>` suffix to define an additional profile — see [above](#serving-more-than-one-manager-account). `GOOGLE_ADS_API_VERSION` and `GOOGLE_ADS_ALLOWED_CUSTOMER_IDS` are deployment-wide and are never suffixed.

Secrets may also be supplied through the [Secrets Store](https://developers.cloudflare.com/secrets-store/integrations/workers/); the code reads either a plain string binding or a store binding.

## Things that will bite you

Collected from the API's sharper edges — most of them cost somebody a debugging session.

- **API versions are retired abruptly.** On 2026-08-07, `v21` began returning `Version v21 is deprecated. Requests to this version will be blocked.` mid-session, and a `validateOnly` dry run had passed minutes earlier. A clean dry run does **not** guarantee the next call succeeds. That is why the version is a var: bump `GOOGLE_ADS_API_VERSION` and redeploy. Check the [sunset dates](https://developers.google.com/google-ads/api/docs/sunset-dates).
- **`login-customer-id` is required for MCC access.** Reaching a client account through a manager without it fails with `USER_PERMISSION_DENIED`, and the failure does not name the missing header.
- **Manager accounts have no metrics.** Query a client account; use `list_customer_clients` to find one.
- **Query is snake_case, response is camelCase.** `cost_micros` in GAQL comes back as `costMicros`. Read the returned `fieldMask`.
- **Money is micros.** Divide by 1,000,000.
- **Brazil:** Google does not pass PIS/COFINS through to the advertiser, so `cost_micros / 1e6` is the amount actually billed — no gross-up. This is *not* symmetric with Meta Ads, which does pass tax through. A report combining both channels must not apply the same factor to both.
- **Pages cap at 10,000 rows.** Ignoring `next_page_token` silently truncates large queries.
- **Rate limits are a token bucket, not a fixed number.** Expect `RESOURCE_TEMPORARILY_EXHAUSTED` under load and back off.
- **A Worker has 6 simultaneous outbound connections.** Relevant if you fan out across many accounts.

## Design notes

- **`googleAds:search`, not `searchStream`.** `searchStream` returns the whole result set in one response — and, uniquely in this API, [wrapped in a JSON array](https://developers.google.com/google-ads/api/rest/common/search) rather than an object. That is a poor fit for a 128 MB Worker and gives the caller no way to stop early. Paging keeps every response bounded.
- **No Durable Object.** MCP `2026-07-28` is stateless, and this server is a thin REST proxy that holds nothing between requests. A fresh `McpServer` is built per request; the handler is built once per isolate so that `subscriptions/listen` streams are not orphaned.
- **No `nodejs_compat`.** `@modelcontextprotocol/server` has a `workerd` export condition and bundles a `@cfworker/json-schema` validator, because Ajv compiles with `new Function`, which workerd forbids.
- **Access tokens are cached per isolate** and refreshed a minute early. It is only ever a cache — a cold isolate simply fetches again.
- **Response size is capped** at 60k characters, and the tool says so rather than returning truncated (invalid) JSON.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: `npm run typecheck && npm test` must pass, and new tools stay read-only unless there is a discussion first.

## License

[Apache-2.0](LICENSE). Not an official Google product, and not affiliated with Google.
