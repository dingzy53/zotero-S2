# AGENTS.md

Guidance for coding agents working in this repo. User-facing docs live in `README.md`.

## What this is

A Zotero **10** plugin (TypeScript, built with `zotero-plugin-scaffold`). It lets AI agents search Semantic Scholar (S2) and add papers and PDFs to Zotero collections. It registers endpoints on Zotero's built-in local HTTP server (`127.0.0.1:23119`):

- `POST /s2/mcp`: an MCP server (Streamable HTTP, JSON responses only, no SSE).
- `GET /s2/tools` and `POST /s2/tools/<name>`: a REST mirror of the same tools.

Hard requirements. Don't change these without the user agreeing:

- **S2 API-key auth only.** Never send unkeyed S2 requests.
- **At most 1 S2 request per second, globally**, with exponential backoff.
- **Zotero 10 only.** `addon/manifest.json` sets `strict_min_version: "10.0"` and `strict_max_version: "10.0.*"`.

## Commands

```sh
npm install
npm run build        # scaffold build + tsc --noEmit → .scaffold/build/zotero-s2.xpi
npm run lint:check   # prettier + eslint (lint:fix to apply)
npm test             # mocha inside a real Zotero (see Testing)
npm start            # dev Zotero with hot reload (needs .env)
npm run release      # maintainers only: bump, tag, push; CI publishes (CONTRIBUTING.md)
```

Before you report work as done, run `npm run build`, `npm run lint:check`, and `npx zotero-plugin test --no-watch --exit-on-finish`. All three must pass.

## Layout

| Path                                                             | Role                                                                                                                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/hooks.ts`                                                   | Lifecycle: startup registers the prefs pane, the token and the endpoints. Shutdown unregisters the endpoints. Hooks only dispatch.                           |
| `src/http/endpoints.ts`                                          | Registers `Zotero.Server.Endpoints`. Handles auth (bearer token, rejects `Origin`) and the enable pref. Owns the single `S2Client`.                          |
| `src/mcp/server.ts`                                              | Dual-era MCP JSON-RPC dispatcher. Pure and unit-tested.                                                                                                      |
| `src/mcp/tools.ts`                                               | **All tools**: name, description, JSON Schema, annotations, handler.                                                                                         |
| `src/mcp/schema.ts`                                              | Argument validation. Drops empty strings, rejects unknown args, fills defaults, enforces min/max/maxItems.                                                   |
| `src/mcp/runTool.ts`                                             | The only way tools run. Validates args, collects stats, writes the activity log, and never throws.                                                           |
| `src/s2/client.ts`                                               | S2 HTTP client: rate limiter, retries/backoff, endpoint wrappers.                                                                                            |
| `src/s2/rateLimiter.ts`                                          | `RateLimiter` (start-spacing FIFO) and `Semaphore` (PDF download concurrency).                                                                               |
| `src/s2/fields.ts`                                               | Default `fields` strings and `compactPaper()`, the agent-facing paper shape.                                                                                 |
| `src/zotero/identifiers.ts`                                      | Parses any id form (DOI/arXiv/CorpusId/S2 sha/URLs) and normalizes ids.                                                                                      |
| `src/zotero/s2ToZotero.ts`                                       | Pure S2 → Zotero mapping (item type, fields, creators, Extra lines).                                                                                         |
| `src/zotero/importer.ts`                                         | Creates items (S2 mapping or Zotero translators), applies mapped fields, tags and notes.                                                                     |
| `src/zotero/dedupe.ts`                                           | Finds existing items (DOI → arXiv → S2 id → CorpusId → title + year). Item describers.                                                                       |
| `src/zotero/pdf.ts`                                              | **The only place PDFs are attached.** Order: S2 OA → arXiv → Zotero resolvers.                                                                               |
| `src/zotero/collections.ts`                                      | Resolves libraries and collections by key or `A/B/C` path, creating them if needed.                                                                          |
| `src/zotero/apis.ts`                                             | Typed shims for Zotero APIs that `zotero-types` lacks or mistypes.                                                                                           |
| `src/modules/preferences.ts` + `addon/content/preferences.xhtml` | Settings pane: API key, token, copy command, activity log.                                                                                                   |
| `src/log/activity.ts`                                            | Ring buffer of recent calls, shown in the prefs pane.                                                                                                        |
| `addon/locale/en-US/*.ftl`                                       | Fluent strings. Scaffold prefixes the IDs with `zoteros2-`, so write them unprefixed.                                                                        |
| `test/`                                                          | Mocha suites, `fixtures.ts` (hand-written S2 responses), and `helpers.ts` (fake clock, fixture S2 client). `http.test.ts` goes through Zotero's real server. |

## Invariants: keep these true

**S2 traffic**

- Every S2 request goes through `S2Client.request()`. It is the only code that enforces the API key, the shared `RateLimiter(1050 ms)`, and retries.
- Don't create a second `S2Client` or `RateLimiter` for production traffic. One instance lives in `http/endpoints.ts`.
- Retries go back through the limiter. A 429 also calls `RateLimiter.pause()` for the backoff delay, so every queued caller waits, not just the one that got it.
- `Zotero.HTTP.request` is called with `successCodes: false` and `errorDelayMax: 0`. Zotero's own retry loop would otherwise retry 429/5xx outside our rate limit.
- Retry on 429, 500, 502, 503, 504, status 0 and thrown errors. Other 4xx responses fail immediately.
- Prefer batch endpoints. One `paperBatch` per tool call where possible; `zotero_add_papers` resolves every id in a single request.

**Tools**

- Add a tool by appending a `ToolDef` to `TOOLS` in `src/mcp/tools.ts`. MCP and REST both pick it up automatically.
- Use snake_case names prefixed `s2_` or `zotero_`.
- Give every tool accurate `annotations` (`readOnlyHint` etc.).
- Throw `ToolError` for mistakes the agent can fix. The message is shown to the agent as `isError: true`. `S2Error` is shown the same way. Any other error is a bug and is also logged with `Zotero.logError`.
- `S2Client.matchTitle()` returns `null` for S2's "no match" 404 and throws on anything else. Don't swallow S2 errors as "not found".
- `zotero_add_papers`, `zotero_attach_pdf` and `zotero_enrich_items` cap input at 25 items (`MAX_ADD`). Long PDF runs or per-item title matches (1/s) inside one JSON response would hit client timeouts.
- Every input schema gets `additionalProperties: false` automatically, because `prepareArgs()` rejects unknown arguments. Keep the two consistent.
- Tools marked `idempotentHint` must stay idempotent. Re-running must not duplicate items, collections or notes.

**MCP (`src/mcp/server.ts`)**

- A request is **modern** only if the body has `params._meta["io.modelcontextprotocol/protocolVersion"]`. Only modern requests get these checks:
  - header/body validation of `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` (error `-32020`, HTTP 400);
  - the unsupported-version error `-32022`;
  - 404 for unknown methods, including `initialize` and `ping`, which 2026-07-28 removed;
  - `_meta["io.modelcontextprotocol/serverInfo"]` on every result.
- Legacy clients (`initialize`, later calls with only `MCP-Protocol-Version: 2025-xx-xx`) must never be rejected for missing modern headers.
- Every result includes `resultType: "complete"`. `tools/list` and `server/discover` also carry `ttlMs` and `cacheScope`.
- Notifications get 202 with an empty body. GET and DELETE get 405. No session IDs, no SSE.

**HTTP endpoints**

- Endpoint classes must keep a **one-argument** `init(req)`. Zotero picks the calling convention from `init.length`. The return value is `[status, headers, body]`.
- `allowRequestsFromUnsafeWebContent = true` is intentional. `checkAccess()` itself rejects any request with an `Origin` header (403), and requires the bearer token (401) and the `enable` pref (503). Don't loosen these checks.
- Zotero's server only knows some reason phrases. `registerEndpoints()` adds 202, 401 and 405. If you return a new status code, add it there.

**Zotero data**

- Item metadata from S2 always writes `S2 Paper ID:` and `CorpusID:` lines into Extra, using `mergeExtra`, which never overwrites existing keys. Dedupe depends on these lines.
- `zotero_enrich_items` defaults to filling **only empty** fields. Writing a field the item type doesn't support is skipped (`isValidField`).
- Translator imports must use `saveAttachments: false` and run through the 3 s `translatorLimiter` (arXiv's policy). PDFs come only from `pdf.ts`.
- `attachPDF()` runs at most one attempt per item at a time and re-checks `hasPDF()` once it holds a download slot. Two ids for one paper (e.g. its DOI and arXiv id) or a repeated item key must not attach two PDFs.
- Target `libraryID` and collections explicitly. Never read the UI selection. In Zotero 10 the singular selection getters throw.

## Zotero 10 / toolchain gotchas (learned the hard way)

- **zotero-types lags the real API.** For missing or wrong signatures (e.g. `Attachments.addFileFromURLs`, `getFileResolvers`, `RecognizeDocument`), add a shim to `src/zotero/apis.ts` rather than scattering `as any`. Check signatures against Zotero's source: `chrome/content/zotero/xpcom/*.js` on GitHub.
- **zotero-plugin-toolkit 6** has no `ZoteroToolkit`. `src/utils/ztoolkit.ts` wraps `BasicTool` only. Don't reintroduce the template's examples.
- **XUL button labels** are a property in Zotero 8+ (`btn.label = …`), not an attribute.
- **Plugin sandbox globals:**
  - Available: `fetch`, `crypto`, `TextDecoder`, `atob`, `URL`, `URLSearchParams`, `setTimeout`, `Zotero`, `Services`, `IOUtils`, `PathUtils`, `Localization`.
  - Not available: DOM window globals, unless you get them from a window.
- **`update_url` is mandatory.** Zotero rejects an empty `update_url` with "Extension is invalid". Scaffold builds it from `package.json` `repository`, which must parse as `https://github.com/<owner>/<repo>.git`.
- **Scaffold's CI test mode downloads Zotero's _beta_ channel** unless `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` is set. `ci.yml` pins a release via `ZOTERO_VERSION`; keep it within the manifest's version range.
- **Zotero's server RFC 2047-decodes header values.** The MCP `=?base64?…?=` sentinel doesn't match its pattern, so `decodeHeaderValue()` still sees it raw.
- **The prefs window replaces its document after opening.** Tests must re-query `win.document` on each poll, never cache it.
- **Zotero's debug log prints request headers**, including the bearer token, when debug output is on.

## Testing

- Tests run **inside a real Zotero 10** through `zotero-plugin test`. `.env` (gitignored) sets `ZOTERO_PLUGIN_ZOTERO_BIN_PATH`; see `.env.example`.
- On Linux, use the official tarball (`https://www.zotero.org/download/client/dl?channel=release&platform=linux-x86_64`). Unpack it somewhere outside the repo, such as a scratch directory.
- The test profile and data directory are fresh on every run. `zotero-plugin.config.ts` → `test.prefs` sets:
  - `httpServer.port = 23129`, so tests don't clash with a running everyday Zotero on 23119;
  - `mcpToken = "test-token"`.
- `npm test` keeps Zotero open in watch mode. For CI-style runs, use `npx zotero-plugin test --no-watch --exit-on-finish`.
- Unit tests must stay **offline**:
  - S2 logic uses `fixtureClient()` / `fakeClock()` from `test/helpers.ts`.
  - The fake clock is fine for sequential timing. For anything concurrent, use real timers at a reduced scale, as in the "keeps request spacing across retries" test.
- `test/http.test.ts` sends real requests to port 23129 with `Zotero.HTTP.request`. Extend it when you touch auth, status codes or headers.
- Manual HTTP checks: keep a watch-mode run alive and `curl` `http://127.0.0.1:23129/s2/...` with `Authorization: Bearer test-token`.
- To try a real MCP client, run `claude mcp add --scope local --transport http zs2-test http://127.0.0.1:23129/s2/mcp --header "Authorization: Bearer test-token"`. **Remove it afterwards** with `claude mcp remove zs2-test -s local`.
- To stop a test Zotero, don't run `pkill -f <pattern>` from a shell whose own command line contains the pattern: it kills the shell. Use `pgrep -f "[z]otero-bin"`-style bracket patterns and target only the test binary's path.
- **Never** install the dev build into, or point tests at, the user's everyday Zotero profile or data directory.
- Live S2 calls need a real API key. Don't hard-code keys or commit them anywhere.

## Release identity (confirmed by the owner; don't change)

- Addon ID `zotero-s2@dingzy53.github.io`. Changing it after release orphans installs and their prefs.
- Repository `github.com/dingzy53/zotero-S2`. `update_url` points at its `release` tag's `update.json`. Moving the repo means every installed copy stops getting updates, and a wrong owner would let a third party serve them.
- Releases run only from the tag-push workflow (`release.yml`), which uses first-party GitHub actions only. Don't add third-party actions to a job that holds `contents: write`.

## Conventions

- Match the existing style: small modules, pure functions where possible (mapping, identifiers and MCP dispatch stay Zotero-free so they're easy to test), and comments that explain _why_.
- Strings shown in the UI go in Fluent (`addon/locale/en-US/*.ftl`). Messages returned to agents stay in plain English in code.
- Prettier settings come from `package.json` (80 columns, 2 spaces). Run `npm run lint:fix` before finishing.
- Commit or push only when the user asks.
