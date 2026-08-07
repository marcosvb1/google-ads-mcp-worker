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
- **OAuth client id and secret** — Google Cloud Console → *APIs & Services → Credentials → OAuth client ID*, with the Google Ads API enabled on the project.
- **Refresh token** — generated for the scope `https://www.googleapis.com/auth/adwords`.

A service account will **not** work here without domain-wide delegation; the Google Ads API expects a user credential.

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

Then either point the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) at `http://localhost:8787/mcp` (`npm run inspect`), or run the smoke script:

```bash
./scripts/smoke.sh
```

### 4. Deploy

```bash
npx wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN
npx wrangler secret put GOOGLE_ADS_CLIENT_ID
npx wrangler secret put GOOGLE_ADS_CLIENT_SECRET
npx wrangler secret put GOOGLE_ADS_REFRESH_TOKEN
npx wrangler secret put MCP_SHARED_SECRET      # if using bearer auth
npx wrangler deploy
```

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
| `GOOGLE_ADS_API_VERSION` | var | `v25` | see the version note below |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | var | — | manager account id, digits only |
| `GOOGLE_ADS_ALLOWED_CUSTOMER_IDS` | var | — | comma-separated allowlist |
| `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` | var | — | enables Cloudflare Access mode |
| `MCP_SHARED_SECRET` | secret | — | enables bearer mode |
| `MCP_ALLOW_UNAUTHENTICATED` | var | — | `"true"` disables the gate |

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
