import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { normalizeCustomerId, GoogleAdsError } from "../src/google-ads";

const PROTOCOL = "2026-07-28";
const TOKEN = "test-secret";

const meta = {
  "io.modelcontextprotocol/protocolVersion": PROTOCOL,
  "io.modelcontextprotocol/clientCapabilities": {},
};

/** One modern-revision JSON-RPC call, with the headers this revision requires. */
async function rpc(method: string, params: Record<string, unknown> = {}, toolName?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${TOKEN}`,
    "MCP-Protocol-Version": PROTOCOL,
    "Mcp-Method": method,
  };
  if (toolName) headers["Mcp-Name"] = toolName;

  const response = await SELF.fetch("https://example.com/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }),
  });
  return { response, body: (await response.json()) as Record<string, any> };
}

async function callTool(name: string, args: Record<string, unknown>) {
  const { body } = await rpc("tools/call", { name, arguments: args }, name);
  return body.result ?? body.error;
}

describe("customer id normalization", () => {
  it("strips the hyphens the Ads UI displays", () => {
    expect(normalizeCustomerId("123-456-7890")).toBe("1234567890");
  });

  it("accepts a bare 10-digit id", () => {
    expect(normalizeCustomerId("1234567890")).toBe("1234567890");
  });

  it.each(["123", "", "12345678901", "abc"])("rejects %o", (input) => {
    expect(() => normalizeCustomerId(input)).toThrow(GoogleAdsError);
  });
});

describe("auth gate", () => {
  it("refuses a request with no credentials", async () => {
    const response = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });

  it("refuses a wrong bearer token", async () => {
    const response = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer nope" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });

  it("serves the liveness probe without credentials", async () => {
    const response = await SELF.fetch("https://example.com/");
    expect(response.status).toBe(200);
  });

  it("404s an unknown path rather than leaking the MCP surface", async () => {
    const response = await SELF.fetch("https://example.com/admin");
    expect(response.status).toBe(404);
  });
});

describe("protocol", () => {
  it("advertises the 2026-07-28 revision via server/discover", async () => {
    const { body } = await rpc("server/discover");
    expect(body.result.supportedVersions).toContain(PROTOCOL);
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("rejects a modern request missing the capabilities envelope", async () => {
    const response = await SELF.fetch("https://example.com/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKEN}`,
        "MCP-Protocol-Version": PROTOCOL,
        "Mcp-Method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": PROTOCOL } },
      }),
    });
    const body = (await response.json()) as Record<string, any>;
    expect(body.error.message).toContain("clientCapabilities");
  });

  it("answers GET /mcp with 405 — this revision has no sessions", async () => {
    const response = await SELF.fetch("https://example.com/mcp", {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(405);
  });
});

describe("tool surface", () => {
  it("exposes exactly the four read-only tools", async () => {
    const { body } = await rpc("tools/list");
    const names = body.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      "get_resource_metadata",
      "list_accessible_customers",
      "list_customer_clients",
      "search",
    ]);
  });

  it("marks every tool read-only, so no client can mutate an account", async () => {
    const { body } = await rpc("tools/list");
    for (const tool of body.result.tools) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.annotations.destructiveHint).toBe(false);
    }
  });
});

describe("query guardrails", () => {
  it("refuses anything that is not a SELECT", async () => {
    const result = await callTool("search", {
      customer_id: "1234567890",
      query: "DELETE FROM campaign",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Only SELECT queries are supported");
  });

  it("refuses a malformed customer id before calling Google", async () => {
    const result = await callTool("search", {
      customer_id: "123",
      query: "SELECT campaign.id FROM campaign",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("expected 10 digits");
  });

  it("rejects a page_size above the API maximum at the schema layer", async () => {
    const result = await callTool("search", {
      customer_id: "1234567890",
      query: "SELECT campaign.id FROM campaign",
      page_size: 99_999,
    });
    expect(JSON.stringify(result)).toContain("Too big");
  });
});
