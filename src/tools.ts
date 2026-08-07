import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Env } from "./env";
import { GoogleAdsClient, GoogleAdsError, MAX_PAGE_SIZE } from "./google-ads";
import { listProfiles, ProfileError, resolveProfile } from "./profiles";

/**
 * Tool results share the model's context window, so cap what we ever return
 * inline. Truncating JSON would hand back something invalid; we'd rather tell
 * the caller to narrow the query.
 */
const CHARACTER_LIMIT = 60_000;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

function ok(data: unknown, structured?: Record<string, unknown>) {
  const text = JSON.stringify(data, null, 2);
  if (text.length > CHARACTER_LIMIT) {
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Result too large to return inline (${text.length} chars, limit ${CHARACTER_LIMIT}). ` +
            `Re-run with a smaller page_size, a narrower date range in the WHERE clause, or fewer SELECT columns.`,
        },
      ],
      isError: true,
    };
  }
  return structured
    ? { content: [{ type: "text" as const, text }], structuredContent: structured }
    : { content: [{ type: "text" as const, text }] };
}

function fail(error: unknown) {
  const message =
    error instanceof ProfileError
      ? error.message
      : error instanceof GoogleAdsError
      ? error.requestId
        ? `${error.message} (request id: ${error.requestId})`
        : error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

const customerIdField = z
  .string()
  .describe("Customer id of the Google Ads account, digits only (hyphens are stripped).");

/**
 * Selecting credentials. Modelled as an enum of the profiles this deployment
 * actually has, so a wrong value fails at schema validation with the real list
 * in the message rather than as a puzzling permission error from Google.
 */
function profileField(profiles: string[]) {
  if (profiles.length < 2) return undefined;
  return z
    .enum(profiles as [string, ...string[]])
    .optional()
    .describe(
      `Which credentials to use. Configured: ${profiles.join(", ")}. ` +
        `Each profile is a separate developer token, manager account and login. ` +
        `Defaults to "${profiles[0]}".`,
    );
}

/** Per-call override for the manager account, within whichever profile is used. */
const loginCustomerIdField = z
  .string()
  .optional()
  .describe(
    "Manager (MCC) account id to authenticate through, digits only. Only needed when the " +
      "target account sits under a different manager than the profile's own — getting it " +
      "wrong shows up as USER_PERMISSION_DENIED.",
  );

/** GAQL is read-only by construction, but reject anything that isn't a SELECT early and clearly. */
function assertSelectQuery(query: string): void {
  if (!/^\s*SELECT\s/i.test(query)) {
    throw new GoogleAdsError(
      "Only SELECT queries are supported. GAQL has no INSERT/UPDATE/DELETE — mutations go through the mutate endpoints, which this server does not expose.",
      400,
    );
  }
}

export function registerGoogleAdsTools(server: McpServer, env: Env): void {
  const profiles = listProfiles(env);
  const profile = profileField(profiles);

  /** Credentials are resolved per call, because the caller chooses the profile. */
  const clientFor = async (name?: string) =>
    new GoogleAdsClient(env, await resolveProfile(env, name));

  /** Only advertise the profile argument when there is a choice to make. */
  const withProfile = <T extends z.ZodRawShape>(shape: T) =>
    z.object(profile ? { ...shape, profile } : shape);

  server.registerTool(
    "list_accessible_customers",
    {
      title: "List accessible customers",
      description:
        "List the Google Ads customer ids the configured credentials can reach directly. " +
        "Call this first when the user has not named an account. Note that a manager (MCC) " +
        "account returns only itself here — use list_customer_clients to expand it.",
      inputSchema: withProfile({ login_customer_id: loginCustomerIdField }),
      outputSchema: z.object({
        profile: z.string(),
        customerIds: z.array(z.string()),
        count: z.number(),
      }),
      annotations: READ_ONLY,
    },
    async (args: { profile?: string; login_customer_id?: string }) => {
      try {
        const client = await clientFor(args.profile);
        const customerIds = await client.listAccessibleCustomers(args.login_customer_id);
        const payload = { profile: client.profileName, customerIds, count: customerIds.length };
        return ok(payload, payload);
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "list_customer_clients",
    {
      title: "List client accounts under a manager",
      description:
        "Expand a manager (MCC) account into the client accounts beneath it, with name, " +
        "currency, time zone and whether each one is itself a manager. Metrics are not " +
        "available on manager accounts, so use this to find the client account to query.",
      inputSchema: withProfile({
        manager_customer_id: customerIdField.describe(
          "Manager (MCC) customer id to expand, digits only.",
        ),
        include_managers: z
          .boolean()
          .optional()
          .describe("Include nested manager accounts in the result. Defaults to false."),
        levels: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("How many levels deep to descend. Defaults to 1 (direct children only)."),
      }),
      annotations: READ_ONLY,
    },
    async (args: {
      manager_customer_id: string;
      include_managers?: boolean;
      levels?: number;
      profile?: string;
    }) => {
      const { manager_customer_id, include_managers, levels } = args;
      try {
        const client = await clientFor(args.profile);
        const conditions = [`customer_client.level <= ${levels ?? 1}`, "customer_client.status = 'ENABLED'"];
        if (!include_managers) conditions.push("customer_client.manager = false");

        const page = await client.search(
          manager_customer_id,
          `SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code,
                  customer_client.time_zone, customer_client.manager, customer_client.level,
                  customer_client.status
           FROM customer_client
           WHERE ${conditions.join(" AND ")}`,
          // A manager account is queried through itself unless told otherwise.
          { pageSize: 1000, loginCustomerId: manager_customer_id },
        );
        return ok({
          profile: client.profileName,
          clients: page.results,
          count: page.results.length,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "search",
    {
      title: "Run a GAQL query",
      description:
        "Run a Google Ads Query Language (GAQL) query against one account and return one page " +
        "of rows.\n\n" +
        "Rules that matter:\n" +
        "• Field names in the query are snake_case (campaign.name), but the JSON response is " +
        "camelCase (campaign.name -> campaign.name inside a camelCased object graph). Read the " +
        "returned fieldMask to see exactly what came back.\n" +
        "• Metrics are unavailable on manager (MCC) accounts — query a client account.\n" +
        "• Dates are 'YYYY-MM-DD'. Prefer segments.date with an explicit range over broad queries.\n" +
        "• Money fields are micros: divide cost_micros by 1,000,000.\n" +
        "• Do not guess column names — call get_resource_metadata first if unsure.\n" +
        "• A page holds at most 10,000 rows; follow next_page_token to continue.",
      inputSchema: withProfile({
        customer_id: customerIdField,
        login_customer_id: loginCustomerIdField,
        query: z
          .string()
          .describe(
            "The full GAQL query, e.g. \"SELECT campaign.name, metrics.cost_micros FROM campaign WHERE segments.date DURING LAST_7_DAYS\".",
          ),
        page_size: z
          .number()
          .int()
          .min(1)
          .max(MAX_PAGE_SIZE)
          .optional()
          .describe(`Rows per page (max ${MAX_PAGE_SIZE}). Start small while exploring.`),
        page_token: z
          .string()
          .optional()
          .describe("next_page_token from a previous call, to fetch the following page."),
      }),
      annotations: READ_ONLY,
    },
    async (args: {
      customer_id: string;
      query: string;
      page_size?: number;
      page_token?: string;
      login_customer_id?: string;
      profile?: string;
    }) => {
      try {
        assertSelectQuery(args.query);
        const client = await clientFor(args.profile);
        const page = await client.search(args.customer_id, args.query, {
          pageSize: args.page_size,
          pageToken: args.page_token,
          loginCustomerId: args.login_customer_id,
        });
        return ok({
          profile: client.profileName,
          results: page.results,
          rowCount: page.results.length,
          fieldMask: page.fieldMask,
          nextPageToken: page.nextPageToken,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "get_resource_metadata",
    {
      title: "Describe a GAQL resource",
      description:
        "List the selectable, filterable and sortable fields of a Google Ads resource (for " +
        "example 'campaign', 'ad_group', 'customer_client'), plus which metrics and segments " +
        "can be selected alongside it. Use this before writing a query instead of guessing " +
        "field names — a wrong field name fails the whole query.",
      inputSchema: withProfile({
        resource: z
          .string()
          .describe("GAQL resource name in snake_case, e.g. 'campaign' or 'ad_group_criterion'."),
        include_compatible: z
          .boolean()
          .optional()
          .describe(
            "Also list metrics and segments selectable with this resource. Defaults to true; " +
              "set false for a much smaller response.",
          ),
      }),
      annotations: READ_ONLY,
    },
    async (args: { resource: string; include_compatible?: boolean; profile?: string }) => {
      const { resource, include_compatible } = args;
      try {
        const client = await clientFor(args.profile);
        const name = resource.trim().replace(/[^a-z0-9_]/gi, "");
        if (!name) throw new GoogleAdsError(`Invalid resource name ${JSON.stringify(resource)}.`, 400);

        const attributes = await client.searchFields(
          `SELECT name, category, data_type, selectable, filterable, sortable, repeated, type_url, enum_values, is_repeated
           WHERE name LIKE '${name}.%'`,
        );

        if (!attributes.length) {
          return ok({
            resource: name,
            fields: [],
            note: `No fields found for '${name}'. Check the resource name — it must be snake_case, e.g. 'campaign' or 'ad_group_ad'.`,
          });
        }

        if (include_compatible === false) {
          return ok({ resource: name, fields: attributes });
        }

        const compatible = await client.searchFields(
          `SELECT name, category, data_type, selectable, filterable, sortable
           WHERE selectable_with CONTAINS ANY ('${name}') AND category IN ('METRIC','SEGMENT')`,
        );

        return ok({ resource: name, fields: attributes, compatibleMetricsAndSegments: compatible });
      } catch (error) {
        return fail(error);
      }
    },
  );
}
