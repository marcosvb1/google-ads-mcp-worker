import { McpServer, createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { authenticate } from "./auth";
import type { Env } from "./env";
import { listProfiles } from "./profiles";
import { registerGoogleAdsTools } from "./tools";

const MCP_ROUTE = "/mcp";

/** Advertised to clients in `server/discover`. Keep in step with package.json. */
const SERVER_VERSION = "0.1.0";

/**
 * Guidance the client can put in front of the model before it writes a query.
 * Cheaper than letting it discover these the hard way, one failed query at a time.
 */
function instructions(env: Env): string {
  const profiles = listProfiles(env);

  // Only worth explaining when there is actually a choice to make.
  const profileNote =
    profiles.length > 1
      ? `\n\nThis deployment has several credential profiles: ${profiles.join(", ")}. ` +
        `Each is a separate developer token, manager account and login, so an account ` +
        `visible under one is generally not visible under another. Every tool takes a ` +
        `"profile" argument; it defaults to "${profiles[0]}". If a customer id is not ` +
        `found, try listing accounts under the other profiles before concluding it does ` +
        `not exist.`
      : "";

  return `Read-only access to the Google Ads API through GAQL.

Start by finding the account: list_accessible_customers, then list_customer_clients
to expand a manager (MCC) into its client accounts. Metrics do not exist on manager
accounts — always query a client account.

Before writing a query, call get_resource_metadata for the resource you intend to
select from. Guessing field names fails the entire query rather than the one column.

Money is in micros (divide cost_micros by 1,000,000). Query fields are snake_case;
the JSON response is camelCase. Results are paginated at 10,000 rows — follow
next_page_token when it comes back.${profileNote}`;
}

/**
 * MCP 2026-07-28 is stateless: no `initialize` handshake, no session id. The
 * handler builds a fresh server per request, so nothing leaks between callers.
 *
 * The handler itself is built once per isolate. Rebuilding it per request would
 * orphan any open `subscriptions/listen` stream, since those belong to the
 * handler instance that opened them.
 */
let handler: McpHttpHandler | null = null;

function getHandler(env: Env): McpHttpHandler {
  handler ??= createMcpHandler(() => {
    const server = new McpServer(
      { name: "google-ads-mcp-worker", version: SERVER_VERSION },
      { instructions: instructions(env) },
    );
    registerGoogleAdsTools(server, env);
    return server;
  });
  return handler;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Liveness probe. Unauthenticated on purpose, and it leaks nothing —
    // no account ids, no configuration, no dependency versions.
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("google-ads-mcp-worker up\n", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }

    if (url.pathname !== MCP_ROUTE) {
      return new Response("Not found\n", { status: 404 });
    }

    const principal = await authenticate(request, env);
    if (principal instanceof Response) return principal;

    return getHandler(env).fetch(request);
  },
} satisfies ExportedHandler<Env>;
