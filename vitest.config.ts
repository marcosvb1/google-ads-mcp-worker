import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // Tests exercise the protocol and guardrails, not the credential path.
          MCP_SHARED_SECRET: "test-secret",
          GOOGLE_ADS_DEVELOPER_TOKEN: "test-developer-token",
          GOOGLE_ADS_CLIENT_ID: "test-client-id",
          GOOGLE_ADS_CLIENT_SECRET: "test-client-secret",
          GOOGLE_ADS_REFRESH_TOKEN: "test-refresh-token",
        },
      },
    }),
  ],
});
