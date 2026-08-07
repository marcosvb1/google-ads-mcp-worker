#!/usr/bin/env node
// Mint a Google Ads refresh token through a loopback OAuth flow.
//
//   node scripts/get-refresh-token.mjs                       # prompts for client id/secret
//   node scripts/get-refresh-token.mjs path/to/client.json   # reads them from a file
//   node scripts/get-refresh-token.mjs client.json --print   # print instead of writing
//   node scripts/get-refresh-token.mjs client.json --profile globex
//
// --profile suffixes the variables it writes (GOOGLE_ADS_CLIENT_ID_GLOBEX, …), so
// one deployment can hold separate credentials per manager account.
//
// By default the token is written into .dev.vars (gitignored) rather than
// printed, so it does not end up in your scrollback or shell history.
//
// The OAuth client must allow a loopback redirect. A *Desktop* client does by
// default. A *Web* client only allows redirect URIs you registered in the Cloud
// Console — add `http://localhost:8976/callback` there, or create a Desktop
// client instead, which is the simpler path.

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, exit } from "node:process";
import { spawn } from "node:child_process";

const PORT = 8976;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = "https://www.googleapis.com/auth/adwords";

const args = argv.slice(2);
const printOnly = args.includes("--print");

const profileArg = args[args.indexOf("--profile") + 1];
const profile = args.includes("--profile") && profileArg && !profileArg.startsWith("--")
  ? profileArg.toUpperCase().replace(/[^A-Z0-9]+/g, "_")
  : "";
const suffix = profile ? `_${profile}` : "";

const file = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--profile");

async function credentials() {
  if (file) {
    if (!existsSync(file)) {
      console.error(`No such file: ${file}`);
      exit(1);
    }
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const node = parsed.installed ?? parsed.web ?? parsed;
    if (node.client_id && node.client_secret) {
      return { clientId: node.client_id, clientSecret: node.client_secret };
    }
    console.error(`No client_id/client_secret found in ${file}.`);
    exit(1);
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const clientId = (await rl.question("OAuth client id: ")).trim();
  const clientSecret = (await rl.question("OAuth client secret: ")).trim();
  rl.close();
  if (!clientId || !clientSecret) {
    console.error("Both values are required.");
    exit(1);
  }
  return { clientId, clientSecret };
}

/** Serve the loopback redirect once and resolve with the authorization code. */
function awaitCode() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }

      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Google Ads MCP</title>` +
          `<body style="font:16px system-ui;padding:3rem;max-width:32rem">` +
          (code
            ? `<h1>Authorized</h1><p>You can close this tab and return to the terminal.</p>`
            : `<h1>Authorization failed</h1><p>${error ?? "No code returned."}</p>`) +
          `</body>`,
      );

      server.close();
      code ? resolve(code) : reject(new Error(error ?? "no code returned"));
    });

    server.on("error", (err) =>
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`Port ${PORT} is in use — free it and retry.`)
          : err,
      ),
    );
    server.listen(PORT);
    setTimeout(() => {
      server.close();
      reject(new Error("Timed out after 5 minutes waiting for authorization."));
    }, 300_000).unref();
  });
}

const { clientId, clientSecret } = await credentials();

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT_URI,
  response_type: "code",
  scope: SCOPE,
  // Both are required to get a refresh token back: offline access asks for one,
  // and forcing the consent screen makes Google re-issue it even if you have
  // already authorized this client before.
  access_type: "offline",
  prompt: "consent",
}).toString();

console.log("\nOpen this URL and authorize with the account that can see your Ads accounts:\n");
console.log(`  ${authUrl}\n`);

// Best-effort: nudge the browser open. Harmless if it fails.
const opener = { darwin: "open", win32: "start", linux: "xdg-open" }[process.platform];
if (opener) spawn(opener, [authUrl.toString()], { stdio: "ignore", detached: true }).unref();

console.log(`Waiting for the redirect on ${REDIRECT_URI} …`);
const code = await awaitCode();

const response = await fetch("https://www.googleapis.com/oauth2/v3/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  }),
});

if (!response.ok) {
  console.error(`\nToken exchange failed (HTTP ${response.status}):`);
  console.error(await response.text());
  exit(1);
}

const { refresh_token: refreshToken } = await response.json();
if (!refreshToken) {
  console.error(
    "\nGoogle returned no refresh token. That usually means this client was already " +
      "authorized without prompt=consent — revoke it at " +
      "https://myaccount.google.com/permissions and run this again.",
  );
  exit(1);
}

if (printOnly) {
  console.log(`\nGOOGLE_ADS_REFRESH_TOKEN${suffix}="${refreshToken}"`);
  exit(0);
}

const stale = new RegExp(`^GOOGLE_ADS_(REFRESH_TOKEN|CLIENT_ID|CLIENT_SECRET)${suffix}=`);
const lines = existsSync(".dev.vars")
  ? readFileSync(".dev.vars", "utf8")
      .split("\n")
      .filter((l) => l.trim() && !stale.test(l))
  : [];

lines.push(`GOOGLE_ADS_CLIENT_ID${suffix}="${clientId}"`);
lines.push(`GOOGLE_ADS_CLIENT_SECRET${suffix}="${clientSecret}"`);
lines.push(`GOOGLE_ADS_REFRESH_TOKEN${suffix}="${refreshToken}"`);

writeFileSync(".dev.vars", lines.join("\n") + "\n", { mode: 0o600 });

console.log(
  `\nWrote client id, client secret and refresh token to .dev.vars (gitignored)` +
    `${profile ? ` for profile ${profile.toLowerCase()}` : ""}.`,
);
console.log(`Still needed there: GOOGLE_ADS_DEVELOPER_TOKEN${suffix} and an auth gate (MCP_SHARED_SECRET).`);
console.log("\nHeads up: if your OAuth consent screen is still in Testing, this refresh token");
console.log("expires in 7 days. Publish the app before relying on it for a deployed server.");
