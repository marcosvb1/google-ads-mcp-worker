import { type Env, readSecret } from "./env";

const TOKEN_ENDPOINT = "https://www.googleapis.com/oauth2/v3/token";
const API_HOST = "https://googleads.googleapis.com";
const REQUEST_TIMEOUT_MS = 30_000;

/** Google's own page size for `googleAds:search`. Requesting more is ignored. */
export const MAX_PAGE_SIZE = 10_000;

/**
 * Access tokens live ~1h. Cache per isolate, keyed by client id, and refresh a
 * minute early. Isolates are reused across requests, so this removes a token
 * round-trip from most calls — but it is only ever a cache: a cold isolate just
 * fetches again.
 */
interface CachedToken {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<string, CachedToken>();

export class GoogleAdsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "GoogleAdsError";
  }
}

/** Digits only — the API rejects the hyphenated form shown in the Ads UI. */
export function normalizeCustomerId(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 10) {
    throw new GoogleAdsError(
      `Invalid customer id ${JSON.stringify(raw)}: expected 10 digits (e.g. 1234567890 or 123-456-7890), got ${digits.length}.`,
      400,
    );
  }
  return digits;
}

/** Guard against a typo'd or hostile `GOOGLE_ADS_API_VERSION` reaching the URL. */
function apiVersion(env: Env): string {
  const version = env.GOOGLE_ADS_API_VERSION?.trim() || "v25";
  if (!/^v\d+(_\d+)?$/.test(version)) {
    throw new GoogleAdsError(
      `Invalid GOOGLE_ADS_API_VERSION ${JSON.stringify(version)}: expected something like "v25" or "v25_1".`,
      500,
    );
  }
  return version;
}

async function getAccessToken(env: Env): Promise<string> {
  const [clientId, clientSecret, refreshToken] = await Promise.all([
    readSecret(env.GOOGLE_ADS_CLIENT_ID),
    readSecret(env.GOOGLE_ADS_CLIENT_SECRET),
    readSecret(env.GOOGLE_ADS_REFRESH_TOKEN),
  ]);

  if (!clientId || !clientSecret || !refreshToken) {
    throw new GoogleAdsError(
      "Missing Google OAuth configuration. Set GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET and GOOGLE_ADS_REFRESH_TOKEN.",
      500,
    );
  }

  const cached = tokenCache.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const body = await response.text();
    // `invalid_grant` is the one worth naming: it means the refresh token was
    // revoked or expired, and no amount of retrying fixes it.
    const hint = body.includes("invalid_grant")
      ? " The refresh token is revoked or expired — generate a new one."
      : "";
    throw new GoogleAdsError(
      `Google rejected the token refresh (HTTP ${response.status}).${hint} ${body.slice(0, 500)}`,
      response.status,
    );
  }

  const data = (await response.json()) as { access_token: string; expires_in?: number };
  const ttlMs = ((data.expires_in ?? 3600) - 60) * 1000;
  tokenCache.set(clientId, { token: data.access_token, expiresAt: Date.now() + ttlMs });
  return data.access_token;
}

/**
 * Pull the human-readable part out of a Google Ads error body. The useful text
 * is nested in `error.details[].errors[].message`; the top-level message is
 * often just "Request contains an invalid argument."
 */
function describeApiError(status: number, body: string): { message: string; requestId?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { message: `HTTP ${status}: ${body.slice(0, 500)}` };
  }

  const error = (parsed as { error?: Record<string, unknown> }).error;
  if (!error) return { message: `HTTP ${status}: ${body.slice(0, 500)}` };

  const details = (error.details ?? []) as Array<Record<string, unknown>>;
  const requestId = details.find((d) => typeof d.requestId === "string")?.requestId as
    | string
    | undefined;

  const messages: string[] = [];
  for (const detail of details) {
    for (const e of (detail.errors ?? []) as Array<Record<string, unknown>>) {
      const code = e.errorCode ? Object.values(e.errorCode as object).join(".") : undefined;
      messages.push(code ? `${code}: ${String(e.message)}` : String(e.message));
    }
  }

  const summary = messages.length ? messages.join(" | ") : String(error.message ?? body.slice(0, 500));
  return { message: `HTTP ${status} — ${summary}`, requestId };
}

export interface SearchPage {
  results: unknown[];
  nextPageToken?: string;
  fieldMask?: string;
  totalResultsCount?: string;
}

export class GoogleAdsClient {
  constructor(private readonly env: Env) {}

  /** Customer ids this deployment is allowed to touch, or null when unrestricted. */
  private allowlist(): Set<string> | null {
    const raw = this.env.GOOGLE_ADS_ALLOWED_CUSTOMER_IDS?.trim();
    if (!raw) return null;
    const ids = raw
      .split(",")
      .map((id) => id.replace(/\D/g, ""))
      .filter(Boolean);
    return ids.length ? new Set(ids) : null;
  }

  private assertAllowed(customerId: string): void {
    const allowed = this.allowlist();
    if (allowed && !allowed.has(customerId)) {
      throw new GoogleAdsError(
        `Customer id ${customerId} is not in GOOGLE_ADS_ALLOWED_CUSTOMER_IDS for this deployment.`,
        403,
      );
    }
  }

  private async headers(): Promise<Headers> {
    const [token, developerToken] = await Promise.all([
      getAccessToken(this.env),
      readSecret(this.env.GOOGLE_ADS_DEVELOPER_TOKEN),
    ]);

    if (!developerToken) {
      throw new GoogleAdsError("Missing GOOGLE_ADS_DEVELOPER_TOKEN.", 500);
    }

    const headers = new Headers({
      authorization: `Bearer ${token}`,
      "developer-token": developerToken,
      "content-type": "application/json",
    });

    // Required whenever the target account is reached through a manager account.
    const loginCustomerId = this.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/\D/g, "");
    if (loginCustomerId) headers.set("login-customer-id", loginCustomerId);

    return headers;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${API_HOST}/${apiVersion(this.env)}/${path}`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const { message, requestId } = describeApiError(response.status, await response.text());
      throw new GoogleAdsError(message, response.status, requestId);
    }
    return response.json();
  }

  private async get(path: string): Promise<unknown> {
    const headers = await this.headers();
    headers.delete("content-type");
    const response = await fetch(`${API_HOST}/${apiVersion(this.env)}/${path}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const { message, requestId } = describeApiError(response.status, await response.text());
      throw new GoogleAdsError(message, response.status, requestId);
    }
    return response.json();
  }

  /**
   * One page of a GAQL query via `googleAds:search`.
   *
   * We deliberately do NOT use `googleAds:searchStream`: it returns the entire
   * result set in one response (and, uniquely in this API, wrapped in a JSON
   * *array* of chunks), which is a poor fit for a 128 MB Worker and gives the
   * caller no way to stop early. Paging keeps each response bounded and hands
   * the model a `nextPageToken` it can choose to follow.
   */
  async search(
    customerId: string,
    query: string,
    options: { pageSize?: number; pageToken?: string } = {},
  ): Promise<SearchPage> {
    const id = normalizeCustomerId(customerId);
    this.assertAllowed(id);

    const body: Record<string, unknown> = { query };
    if (options.pageSize) body.pageSize = Math.min(options.pageSize, MAX_PAGE_SIZE);
    if (options.pageToken) body.pageToken = options.pageToken;

    const page = (await this.post(`customers/${id}/googleAds:search`, body)) as SearchPage;
    return { ...page, results: page.results ?? [] };
  }

  /** Customer ids the authenticated user can reach directly. */
  async listAccessibleCustomers(): Promise<string[]> {
    const data = (await this.get("customers:listAccessibleCustomers")) as {
      resourceNames?: string[];
    };
    return (data.resourceNames ?? []).map((name) => name.replace("customers/", ""));
  }

  /** Field metadata for a GAQL resource, so callers stop guessing column names. */
  async searchFields(query: string): Promise<unknown[]> {
    const data = (await this.post("googleAdsFields:search", { query })) as {
      results?: unknown[];
    };
    return data.results ?? [];
  }
}
