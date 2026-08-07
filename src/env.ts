/** Secrets Store binding — the value must be read with `await binding.get()`. */
export interface SecretsStoreSecret {
  get(): Promise<string>;
}

/** A secret may arrive as a plain Worker secret (string) or a Secrets Store binding. */
export type SecretLike = string | SecretsStoreSecret | undefined;

export interface Env {
  // ── Google Ads credentials, default profile (secrets) ─────────────────────
  // Every key below may also carry a `_<PROFILE>` suffix to define an
  // additional profile — see src/profiles.ts. The index signature at the bottom
  // is what makes those suffixed keys readable.

  /** Developer token from your Google Ads manager account. Sent as `developer-token`. */
  GOOGLE_ADS_DEVELOPER_TOKEN?: SecretLike;
  /** OAuth2 client id (Desktop or Web app) from Google Cloud Console. */
  GOOGLE_ADS_CLIENT_ID?: SecretLike;
  /** OAuth2 client secret. */
  GOOGLE_ADS_CLIENT_SECRET?: SecretLike;
  /** OAuth2 refresh token carrying the `https://www.googleapis.com/auth/adwords` scope. */
  GOOGLE_ADS_REFRESH_TOKEN?: SecretLike;

  // ── Google Ads configuration (plain vars) ─────────────────────────────────

  /**
   * API version used in request paths, e.g. `v25`. Retired versions are blocked
   * abruptly by Google, so this is a var you can bump without a code change.
   */
  GOOGLE_ADS_API_VERSION?: string;

  /**
   * Manager (MCC) account id, digits only. Sent as `login-customer-id` on every
   * call. Required whenever the target account is reached *through* a manager —
   * omitting it is the most common cause of `USER_PERMISSION_DENIED`.
   */
  GOOGLE_ADS_LOGIN_CUSTOMER_ID?: string;

  /**
   * Optional comma-separated allowlist of customer ids this deployment may
   * query. Unset means "any account the credentials can reach". Set it when the
   * server is shared, so a caller cannot pivot to an unrelated account.
   */
  GOOGLE_ADS_ALLOWED_CUSTOMER_IDS?: string;

  // ── MCP-side auth: who may call THIS server ───────────────────────────────
  // Three modes, resolved in order. The server fails closed if none is set,
  // unless MCP_ALLOW_UNAUTHENTICATED is explicitly "true".

  /** Cloudflare Access team domain, e.g. `https://your-team.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN?: string;
  /** Application Audience (AUD) tag of the Access application protecting this Worker. */
  ACCESS_AUD?: string;

  /** Static bearer token compared against the `Authorization: Bearer …` header. */
  MCP_SHARED_SECRET?: SecretLike;

  /**
   * Escape hatch for local development and for deployments fronted by another
   * perimeter. Must be the literal string "true". Note that a Cloudflare MCP
   * Portal is NOT such a perimeter: the docs warn that blocked users can still
   * reach the Worker's direct URL and bypass the Access policy.
   */
  MCP_ALLOW_UNAUTHENTICATED?: string;

  /**
   * Profile-suffixed credentials (`GOOGLE_ADS_DEVELOPER_TOKEN_GLOBEX`, …) and any
   * other binding the runtime injects. Typed loosely because the key names are
   * only known at runtime; `readSecret` narrows the value.
   */
  [key: string]: unknown;
}

/** Read a secret that may be a plain string or a Secrets Store binding. */
export async function readSecret(value: unknown): Promise<string | undefined> {
  if (typeof value === "string") return value.trim() || undefined;
  if (value && typeof (value as SecretsStoreSecret).get === "function") {
    return (value as SecretsStoreSecret).get();
  }
  return undefined;
}
