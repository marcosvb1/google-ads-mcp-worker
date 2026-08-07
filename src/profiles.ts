import { type Env, readSecret } from "./env";

/**
 * One set of Google Ads credentials: an application (developer token), an
 * identity (OAuth) and optionally the manager account to authenticate through.
 *
 * A deployment usually needs more than one. Developer tokens are issued per
 * manager account and carry their own daily operation quota, and a client's MCC
 * generally comes with its own token and its own login — so "which credentials"
 * is a property of the account being queried, not of the deployment.
 *
 * Configuration is by env suffix:
 *
 *   GOOGLE_ADS_DEVELOPER_TOKEN            ← the default profile
 *   GOOGLE_ADS_CLIENT_ID
 *   …
 *   GOOGLE_ADS_DEVELOPER_TOKEN_GLOBEX      ← profile "globex"
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID_GLOBEX
 *
 * Anything a profile leaves unset falls back to the default profile, so sharing
 * one OAuth identity across several managers costs one variable per profile.
 */
export interface Profile {
  name: string;
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Manager (MCC) account, digits only. Sent as `login-customer-id`. */
  loginCustomerId?: string;
}

export const DEFAULT_PROFILE = "default";

const PROFILE_FIELDS = [
  "DEVELOPER_TOKEN",
  "CLIENT_ID",
  "CLIENT_SECRET",
  "REFRESH_TOKEN",
  "LOGIN_CUSTOMER_ID",
] as const;

// Anchored and restricted to the five known field names, so unrelated variables
// (GOOGLE_ADS_API_VERSION, GOOGLE_ADS_ALLOWED_CUSTOMER_IDS) never look like profiles.
const SUFFIXED = new RegExp(`^GOOGLE_ADS_(?:${PROFILE_FIELDS.join("|")})_(.+)$`);

export class ProfileError extends Error {}

/** Profile names configured on this deployment, default first. */
export function listProfiles(env: Env): string[] {
  const found = new Set<string>();
  for (const key of Object.keys(env)) {
    const match = SUFFIXED.exec(key);
    if (match?.[1]) found.add(match[1].toLowerCase());
  }

  const named = [...found].sort();
  return env.GOOGLE_ADS_DEVELOPER_TOKEN ? [DEFAULT_PROFILE, ...named] : named;
}

/** Read `GOOGLE_ADS_<field>[_<SUFFIX>]`, falling back to the default profile. */
async function field(
  env: Env,
  name: string,
  fieldName: (typeof PROFILE_FIELDS)[number],
): Promise<string | undefined> {
  const base = `GOOGLE_ADS_${fieldName}`;
  if (name !== DEFAULT_PROFILE) {
    const scoped = await readSecret(env[`${base}_${name.toUpperCase()}`]);
    if (scoped) return scoped;
  }
  return readSecret(env[base]);
}

export async function resolveProfile(env: Env, requested?: string): Promise<Profile> {
  const available = listProfiles(env);
  const name = (requested ?? available[0] ?? DEFAULT_PROFILE).toLowerCase();

  if (requested && !available.includes(name)) {
    throw new ProfileError(
      available.length
        ? `Unknown profile ${JSON.stringify(requested)}. Configured profiles: ${available.join(", ")}.`
        : `Unknown profile ${JSON.stringify(requested)}. This deployment has no profiles configured.`,
    );
  }

  const [developerToken, clientId, clientSecret, refreshToken, loginCustomerId] = await Promise.all([
    field(env, name, "DEVELOPER_TOKEN"),
    field(env, name, "CLIENT_ID"),
    field(env, name, "CLIENT_SECRET"),
    field(env, name, "REFRESH_TOKEN"),
    field(env, name, "LOGIN_CUSTOMER_ID"),
  ]);

  const missing = [
    ["DEVELOPER_TOKEN", developerToken],
    ["CLIENT_ID", clientId],
    ["CLIENT_SECRET", clientSecret],
    ["REFRESH_TOKEN", refreshToken],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => `GOOGLE_ADS_${key}${name === DEFAULT_PROFILE ? "" : `_${name.toUpperCase()}`}`);

  if (missing.length) {
    throw new ProfileError(
      `Profile ${JSON.stringify(name)} is incomplete. Missing: ${missing.join(", ")}. ` +
        `A profile inherits anything it does not set from the default profile.`,
    );
  }

  return {
    name,
    developerToken: developerToken!,
    clientId: clientId!,
    clientSecret: clientSecret!,
    refreshToken: refreshToken!,
    loginCustomerId: loginCustomerId?.replace(/\D/g, "") || undefined,
  };
}
