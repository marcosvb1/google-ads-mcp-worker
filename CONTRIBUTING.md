# Contributing

Thanks for considering it. This is a small project and issues are as welcome as pull requests — a well-described bug or a real usage report is worth as much as code.

## Getting set up

```bash
npm install
cp .dev.vars.example .dev.vars   # a bearer secret is enough to start
npm run dev
```

You do **not** need working Google Ads credentials to work on the protocol layer. The test suite and `./scripts/smoke.sh` both run without them — they exercise the auth gate, the handshake and the guardrails, none of which reach Google.

## Before opening a PR

```bash
npm run typecheck
npm test
```

Both run in CI, along with `wrangler deploy --dry-run` to catch anything the Workers runtime cannot bundle.

If your change touches request handling, run `npm run verify` too — it starts a server, exercises both the `2026-07-28` path and the 2025-era fallback end to end, and tears the server down.

## Scope

**Tools stay read-only.** Every tool declares `readOnlyHint: true`, and the server never calls a `mutate` endpoint. That is a deliberate safety property: someone connecting an agent to their ad account should not have to trust that the agent won't spend their money. A tool that writes to Google Ads changes what this project *is*, so please open an issue to discuss before writing the code.

Good things to add, roughly in order of usefulness:

- Convenience read tools that save the model a round trip or a class of failed query
- Better error messages, especially where the API's own message doesn't name the real cause
- Docs on gotchas you hit in practice
- Support for a version of the API or the MCP spec that this misses

## Style

- TypeScript, `strict`. `npm run typecheck` is not optional.
- Comments explain *why*, not *what*. If a line looks strange but is deliberate, say why — the API's sharp edges are the main reason this codebase has comments at all.
- Tool descriptions are prompt surface, not documentation. They are read by a model deciding whether to call the tool, so be concrete about what fails and how.

## A note on API versions

`GOOGLE_ADS_API_VERSION` is a config var precisely because Google retires versions abruptly. If you're bumping it, check the [sunset dates](https://developers.google.com/google-ads/api/docs/sunset-dates) and mention in the PR what you tested against.

## License

By contributing you agree that your contributions are licensed under [Apache-2.0](LICENSE).
