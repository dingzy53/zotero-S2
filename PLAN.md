# PLAN: fix what agents ran into when using the MCP

> Branch `fix/agent-usage-findings`. Written 2026-11-14.
>
> **Status (2026-11-14):** steps 1 to 8 are implemented on this branch, one commit each, except the release itself (step 1.1). Still to do by the owner: merge, run `npm run release` on `main` and choose `0.2.0`, then the "After Step 1" and "After Step 3" checks under Verification. Differences from the text below:
>
> - Step 1.1: `package.json` still says `0.1.0`. `npm run release` does the bump; a hand-edited version would leave it nothing to bump and nothing to tag.
> - Step 3: the bridge lives in `addon/content/bridge/` so it ships in the XPI; the plugin copies it into the Zotero data directory, which gives the settings pane a real path for its command.
> - Step 5: the IEEE conference DOI shape also overrules a `JournalArticle` label from S2. The venue-name rule leaves out "proceedings" (PNAS and "Proceedings of the IEEE" are journals).
> - Step 7.2: only the disclaimer is dropped; `openAccessPdf` stays `{ url, status }` because the search window reads that shape.
> - Step 8: the owner chose add and remove for `zotero_move_items`, and attachment paths included.
>
> This replaces the earlier "let agents add PDF files" plan, which shipped in `da2377e` (see git history for its text).

## Where this comes from

I read every Claude Code transcript under `~/.claude/projects` that called the `zotero-s2` MCP tools (2026-10-16 to 2026-11-10): 90 tool calls in 7 sessions (UGRP, MIMMC, SSCU3622 and one test in this repo), plus the shell commands around them. 20 calls returned an error. Two more sessions reached the same endpoint through hand-written clients (finding 2); their calls aren't in the table. I then read the code paths behind each failure.

| Tool                           | Calls | Errors | What went wrong                                    |
| ------------------------------ | ----: | -----: | -------------------------------------------------- |
| `zotero_add_pdf_from_url`      |    19 |     15 | Local files and publisher pages (finding 1)        |
| `s2_search_papers`             |    17 |      1 | Client timeout (finding 3)                         |
| `zotero_list_collection_items` |    16 |      0 |                                                    |
| `zotero_add_papers`            |     8 |      1 | `URL:https://doi.org/…` rejected by S2 (finding 4) |
| `s2_match_title`               |     6 |      2 | "No title match" reported as an error (finding 8)  |
| `zotero_attach_pdf`            |     3 |      1 | Client timeout with 15 items (finding 3)           |
| Others                         |    21 |      0 |                                                    |

## Findings

### 1. The installed plugin never got the PDF-file fix (highest impact)

- 7 of the 15 `zotero_add_pdf_from_url` errors are agents trying to attach a PDF the user had already downloaded: `file://` URLs ("url must be http(s)"), then a local `python -m http.server` ("URL did not return a PDF"). It happened on 10-31 and 11-04, and again on 11-08 through a hand-written client. Two sessions ended with "I couldn't add the PDFs to Zotero"; one created duplicate items as a workaround. The other 8 errors are publisher URLs (finding 6).
- `zotero_add_pdf_file` fixes exactly this and was committed on 11-03 (`da2377e`). But the everyday Zotero profile still runs the build from **10-29**: its XPI contains no `zotero_add_pdf_file`, and the old error text ("URL did not return a PDF") appears in the 11-04 and 11-08 sessions.
- Cause: the fix was released as **`v0.1.0` again**. The installed build is also `0.1.0`, so Zotero's updater sees nothing newer. `update.json` lists only `0.1.0`.

### 2. The MCP server is unusable for a whole session when Zotero starts late

- Claude Code connects to `http://127.0.0.1:23119/s2/mcp` once at session start. If Zotero isn't open yet, the tools never appear (`ECONNREFUSED`), even after Zotero is started.
- The connection fails this way at the start of most sessions on this machine (about 230 transcripts), which is harmless until a session needs Zotero. It mattered in at least 4 sessions (10-24, 10-31, 11-04, 11-07). In 2 of them the agent wrote its own JSON-RPC client (`zmcp.sh`, `zotero_s2.py`) and read the bearer token out of `~/.claude.json` to keep working. One of those scripts was copied into a coursework repo's `tools/` folder. On 11-04 the agent gave up on Zotero and used a local folder of PDFs.
- This is a client limitation, but the plugin can make it a non-event (step 3 below).

### 3. Tool calls have no time budget, so the client gives up first

- `s2_search_papers` and `zotero_attach_pdf` (15 items) both ended in the client's "The operation timed out." after about 60 s. Successful calls took up to 140 s (`zotero_add_papers` with 11 ids).
- `S2Client.request()` can spend `MAX_RETRIES = 6` backoffs (1+2+4+8+16+32 s) plus seven 30 s transport timeouts. `attachPDF` runs 2 downloads at a time with no per-item limit. Nothing bounds the whole call.
- When the client times out, the work continues in Zotero, but the agent gets no result and can't tell what was done. The 15-item `zotero_attach_pdf` had to be re-run in batches of 4.

### 4. Identifiers S2 can't resolve fail hard

- `ids: ["URL:https://doi.org/10.1016/j.tra.2023.103774"]` → `parseIdentifier()` takes the `url` prefix branch and sends the string to S2 as-is. S2 answers 400 "No valid paper ids given", and the **whole call** fails instead of one row.
- The same DOI without the prefix gave "not found on Semantic Scholar", even with `metadata_source: "translator"`. S2 only had the SSRN version. `zotero_add_papers` returns early at `if (!paper)` (`src/mcp/tools.ts:776`), so Zotero's own DOI lookup (Crossref) is never tried. The agent couldn't add a paper with a valid DOI.

### 5. Wrong item types from S2 metadata

- IEEE conference papers (e.g. `10.1109/ICPSAsia55496.2022.9949832`, `10.1109/PESGM58988.2026.11693499`) were saved as `journalArticle`. A later session had to flag them "Journal article (wrong)" and fix the BibTeX by hand.
- `chooseItemType()` trusts `publicationTypes` and `publicationVenue.type`, which S2 often leaves empty for proceedings. One item also carried a fourth author that isn't on the paper (S2 data).

### 6. Publisher downloads mostly fail, and the reason is hidden

- HAL, PeerJ, ACM, Cell and Wiley URLs all failed with the same generic message; only MDPI and OSTI worked. Some of these are open access (HAL, PeerJ), so a bot check or redirect is the likely cause, but the real error only goes to `Zotero.debug`.
- With finding 1 fixed, agents have a fallback (`zotero_add_pdf_file`). The message should still say what happened (HTTP status, "got HTML", "bot challenge").

### 7. Missing tools pushed agents around the plugin

- **Remove or move:** the user asked to "move / add" entries into a subcollection; agents could only add. "I can't delete collections with the tools I have."
- **Attachments:** to find or verify an item's PDF, agents called Zotero's local API (`/api/users/0/items/<key>/children`) or copied `zotero.sqlite`. `describeItem()` reports only `hasPDF`.
- **Fixing metadata:** there is no way to correct an item type or field (finding 5), only `zotero_enrich_items` from S2.

### 8. Smaller things

- `s2_match_title` throws `ToolError("No title match")`. A miss is a normal answer, and `isError` makes agents treat it as a failure.
- Passing `fields` to `s2_search_papers` / `s2_get_papers` returns raw S2 rows, including the long Unpaywall disclaimer in every `openAccessPdf` (about 300 characters per paper). Agents passed `fields` in most searches.
- The bearer token was pasted into a chat on 10-31 and is now in transcripts. It only works from this machine, but it should be regenerated once.

## Steps

Ordered by value. Each step is one commit with its tests.

### Step 1: make fixes reach the installed plugin

1. Bump to `0.2.0` and release from `main` (owner runs `npm run release`). Confirm `update.json` lists `0.2.0` and that the everyday Zotero updates to it.
2. `AGENTS.md` → add under Conventions: every change to `src/` or `addon/` that is released needs a version bump; never re-release an existing version number.
3. `serverInfo` already carries `version`, but it is the same string for both builds. Add the build date (scaffold's build time) next to it in `serverInfo`, in `GET /s2/tools` and in the prefs pane, so "which build is running?" has a one-line answer.

### Step 2: bound every tool call (finding 3)

1. `src/mcp/runTool.ts`: give each call a deadline (default 50 s, constant `TOOL_BUDGET_MS`) exposed as `ctx.deadline`.
2. `S2Client.request()`: accept the deadline. Before a backoff sleep, if the sleep would pass the deadline, throw an `S2Error` that says S2 is rate-limiting and to retry. Keep the limiter and `pause()` behaviour unchanged (AGENTS.md invariants).
3. `zotero_attach_pdf` and the PDF phase of `zotero_add_papers`: race each `attachPDF()` against the deadline. Items still running are reported as `pdf: "pending"` and keep downloading in the background; `inFlight` already prevents double attaches. Add a hint: "call zotero_attach_pdf again with the pending keys to see the result".
4. Tests: fake-clock test that a 429 storm returns an error before the budget; a slow fake resolver yields `"pending"` and a second call returns `"attached"` without a second download.

### Step 3: survive Zotero starting late (finding 2)

1. Add `bridge/zotero-s2-mcp.mjs`: a zero-dependency Node stdio MCP server that forwards every JSON-RPC message to `/s2/mcp`. It answers `initialize` and `tools/list` itself when Zotero is down (from a tool list cached on disk at the last successful call), and returns a clear tool error ("Zotero isn't running; start it and retry") for `tools/call`. It reads the token from an env var.
2. Prefs pane: a second "Copy command" for the stdio form (`claude mcp add zotero-s2 -e ZOTERO_S2_TOKEN=… -- node …/zotero-s2-mcp.mjs`).
3. README: a "Zotero wasn't running" troubleshooting entry (`/mcp` → reconnect for the HTTP form).
4. Tests: a Node test for the bridge with a stub HTTP server (up, down, down-then-up).

Decision for the owner: ship the bridge, or only document `/mcp` reconnect. I recommend the bridge, because agents hand-rolling clients with the token is the worse outcome.

### Step 4: identifiers and the translator fallback (finding 4)

1. `parseIdentifier()`: for a `URL:` prefix, re-parse the rest as a plain URL first, so `URL:https://doi.org/…` and `URL:https://arxiv.org/abs/…` become DOI/arXiv ids.
2. `zotero_add_papers`: if `paperBatch` fails with a 400, retry once per id form that is safe (DOI, arXiv, sha, CorpusId) and mark the rest `error: "not a paper id S2 accepts"`. One bad id must not fail the other 24.
3. When S2 has no paper but the id is a DOI or arXiv id, look for an existing item by that id, then create through `createFromTranslator()` (already rate-limited) regardless of `metadata_source`. Row gets `metadataSource: "translator"` and a note that S2 doesn't know the paper. Refactor `createFromTranslator()` to take `{ doi?, arxiv? }` instead of an `S2Paper`.
4. Tests: `test/mapping.test.ts` for the parser; `test/zotero.test.ts` for the partial-failure and no-S2-record paths (translator stubbed, offline).

### Step 5: item types (finding 5)

1. `chooseItemType()`: when S2 gives no type, use `conferencePaper` if the venue name matches `/\b(conference|symposium|workshop|proceedings|congress|meeting)\b/i` or the DOI has the IEEE conference shape (`10.1109/<LETTERS+digits>.<year>.<n>`). Table-driven tests with the real cases from the transcripts.
2. `zotero_enrich_items`: add optional `fix_item_type` (default `false`). When set and the S2/heuristic type differs, change the type with `item.setType()` and report it in the row.

### Step 6: clearer download failures (finding 6)

1. `importPDFFromURL()`: capture why the resolver failed (wrap `downloadFirstAvailableFile` and read the logged per-resolver error, or do one `HEAD`/small `GET` to classify: HTTP status, HTML, challenge page). Append it to the `ToolError`.
2. Manually test HAL, PeerJ and one ACM open-access URL against a watch-mode Zotero and record the outcome in this file. If Zotero's resolver is the limit, say so in the tool description rather than adding our own scraper.

Outcome of the manual test (2026-11-14, Zotero 10.0.6 test profile, URLs from the transcripts):

| URL                                          | Result                                                                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hal.science/hal-04257315/document` (HAL)    | Fails. HAL answers every request with an Anubis bot check ("Making sure you're not a bot!", HTTP 200). Zotero can't pass it. The error now says so.           |
| `peerj.com/articles/cs-844.pdf` (PeerJ)      | Failed with HTTP 400 on a fresh profile; the landing page `peerj.com/articles/cs-844/` worked, and after it the direct link worked too (Cloudflare cookie).   |
| `dl.acm.org/doi/pdf/10.1145/3679240.3735104` | Fails with HTTP 403. Same for `cell.com` and Wiley `pdfdirect`. These block automated downloads.                                                              |
| `mdpi.com/1996-1073/19/10/2485/pdf` (MDPI)   | Failed, which was a regression from `da2377e`: MDPI sends the PDF as `application/octet-stream`, and a `pageURL` resolver skips that. Fixed; it attaches now. |
| `osti.gov/servlets/purl/1848851` (OSTI)      | Works.                                                                                                                                                        |

So Zotero's resolver is the limit for HAL, ACM, Cell and Wiley. We don't add a scraper; the tool description and the error point to `zotero_add_pdf_file`.

### Step 7: small fixes (finding 8)

1. `s2_match_title`: return `{ match: null }` instead of throwing.
2. Strip `openAccessPdf.disclaimer` (and reduce `openAccessPdf` to its URL) on the raw-`fields` path too.
3. README: "regenerate the token if it ever lands in a chat or a repo".

### Step 8 (needs the owner's decision): library-edit tools (finding 7)

Proposed, smallest useful set:

- `describeItem()` gains `attachments: [{ key, filename, contentType, path }]` behind an `include_attachments` argument on `zotero_list_collection_items` and `zotero_find_in_library`.
- `zotero_move_items`: add to and/or remove from collections (never deletes items). `destructiveHint: false`, idempotent.

Not proposed: deleting items or collections. That stays in the Zotero UI.

Questions: is removing an item from a collection acceptable for an agent tool? Should attachment paths be exposed (they reveal the data directory)?

## Verification

- `npm run build`, `npm run lint:check`, `npx zotero-plugin test --no-watch --exit-on-finish` all pass after each step.
- After Step 1: the everyday Zotero shows 0.2.0 and `tools/list` includes `zotero_add_pdf_file`. Attach one PDF from `~/Downloads` by path to an existing item.
- After Step 3: start a Claude Code session with Zotero closed, open Zotero, call `zotero_list_collections` without reconnecting.
- Replay the failing calls from the transcripts: `URL:https://doi.org/10.1016/j.tra.2023.103774`, DOI `10.1016/j.tra.2023.103774` with `metadata_source: "translator"`, `zotero_attach_pdf` with 15 keys, and the IEEE DOIs above (expect `conferencePaper`).

## Out of scope

- `strict_max_version: "10.0.*"`, API-key-only auth and the 1 request/second limit stay as they are (AGENTS.md hard requirements).
- S2's own data errors (wrong author lists) beyond the translator option.
