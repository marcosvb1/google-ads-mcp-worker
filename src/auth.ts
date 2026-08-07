import { createRemoteJWKSet, jwtVerify } from "jose";
import { type Env, readSecret } from "./env";

/**
 * Who may call this server. Three modes, resolved in this order:
 *
 *   1. Cloudflare Access — ACCESS_TEAM_DOMAIN + ACCESS_AUD set. Every allowed
 *      request carries a signed `Cf-Access-Jwt-Assertion`; we verify it against
 *      the team's JWKS. Verifying is not optional: without it, anyone who knows
 *      the Worker URL bypasses Access entirely.
 *   2. Bearer token — MCP_SHARED_SECRET set, compared against `Authorization:
 *      Bearer <token>`.
 *   3. Open — only when MCP_ALLOW_UNAUTHENTICATED is exactly "true".
 *
 * With none of the three configured the server denies everything. That is
 * deliberate: a Google Ads credential is worth more than an uptime blip.
 */

export interface Principal {
  /** How the caller was authenticated, for logs. */
  mode: "access" | "bearer" | "anonymous";
  /** Caller identity when the mode carries one. */
  subject?: string;
}

// One JWKS set per team domain, reused for the life of the isolate.
let jwksCache: { domain: string; set: ReturnType<typeof createRemoteJWKSet> } | null = null;

function getJwks(teamDomain: string) {
  if (!jwksCache || jwksCache.domain !== teamDomain) {
    jwksCache = {
      domain: teamDomain,
      set: createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`)),
    };
  }
  return jwksCache.set;
}

/** Normalize to `https://<team>.cloudflareaccess.com`, no trailing slash. */
function normalizeTeamDomain(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/** Length-checked constant-time compare, so we don't leak the secret by timing. */
function secretMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? "";
}

/**
 * Authenticate a request. Resolves to the caller's Principal, or to a ready-to-
 * return 401 `Response` when the request must be refused.
 */
export async function authenticate(request: Request, env: Env): Promise<Principal | Response> {
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) return unauthorized("Missing Cloudflare Access token", "access");

    const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
    try {
      const { payload } = await jwtVerify(token, getJwks(teamDomain), {
        issuer: teamDomain,
        audience: env.ACCESS_AUD,
      });
      const subject = (payload.email as string | undefined) ?? (payload.sub as string | undefined);
      return { mode: "access", subject };
    } catch {
      return unauthorized("Invalid Cloudflare Access token", "access");
    }
  }

  const expected = await readSecret(env.MCP_SHARED_SECRET);
  if (expected) {
    return secretMatches(bearerToken(request), expected)
      ? { mode: "bearer" }
      : unauthorized("Invalid or missing bearer token", "bearer");
  }

  if (env.MCP_ALLOW_UNAUTHENTICATED === "true") {
    return { mode: "anonymous" };
  }

  return unauthorized(
    "This server has no authentication configured and therefore refuses all requests. " +
      "Set ACCESS_TEAM_DOMAIN + ACCESS_AUD, or MCP_SHARED_SECRET, or (for local development only) MCP_ALLOW_UNAUTHENTICATED=true.",
    "unconfigured",
  );
}

function unauthorized(message: string, mode: string): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (mode === "bearer") {
    headers.set("www-authenticate", `Bearer error="invalid_token", error_description="${message}"`);
  }
  // JSON-RPC shaped so an MCP client surfaces the reason instead of a bare 401.
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message } }),
    { status: 401, headers },
  );
}
