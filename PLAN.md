# PLAN: 2026-11-20 test report fixes (BibTeX export `@Article` with `booktitle` and missing DOI)

> Branch: `fix/bibtex-export` (from `main` at `c56b7b9`, tag `v0.2.0`) · Date: 2026-11-20 · Status: Item 1 fixed on this branch; item 2 is an operational note, not implemented.
>
> Earlier plans and deferred testing notes are preserved below the separator.

## Context

In the 2026-11-20 hands-on test report on macOS 14 (Zotero 10.0.9):

- Auto-update to `0.2.0`, all MCP tools (`s2_match_title`, `s2_get_papers`, `zotero_find_in_library` with rate-limit fallback, `zotero_add_papers`, `zotero_list_collection_items`, `s2_recommend`, `s2_snippet_search`, `s2_get_citations`), HTTP 401/403 checks, and the Search window (query restore, advanced filters, ✓ In library marks, cards/table views, detail pane, Similar papers with breadcrumb, API key Test) **passed**.
- One minor bug and one operational note were reported:
  1. **Minor bug:** in the Search window, **Export → Copy BibTeX** produces an `@Article` entry with a `booktitle` field and no `doi`.
  2. **Operational note:** parallel calls hit S2 429s; the plugin backed off and returned a clear error. Four `zotero-s2-mcp.mjs` bridge processes from other agent sessions were running on the machine and sharing the API key.

---

## 1. BibTeX export has `@Article` with `booktitle` and no `doi`

**Done.** `normalizeBibtexEntry` and `bibtexFromPaper` in `src/gui/export.ts`; `joinBibtex(rows, papers)` from `exportText`. Tested in `test/gui.export.test.ts` and `test/gui.test.ts`. The optional arXiv `eprint` is added only to synthesized entries.

### Symptom

Clicking **Export → Copy BibTeX** (or **Save BibTeX…**) in the Semantic Scholar search window copies a BibTeX entry such as:

```bibtex
@Article{Vaswani2017AttentionIA,
  author = {Ashish Vaswani and ...},
  booktitle = {Neural Information Processing Systems},
  title = {Attention is All you Need},
  year = {2017}
}
```

Notice two problems:

1. `@Article` with `booktitle` (and no `journal`) is invalid in standard BibTeX styles (`@article` requires `journal`; a conference proceedings paper with `booktitle` must be `@inproceedings`, or `@article` must use `journal`).
2. `doi` (and `url` / `eprint`) is missing even when the paper in the search results already has `externalIds.DOI` (or `externalIds.ArXiv`).

### Cause (verified in `src/gui/controller.ts:558-576` and `src/gui/export.ts:87-99`)

1. `SearchController.exportText("bibtex")` (`src/gui/controller.ts:558-571`) fetches only `fields: "citationStyles"` from `s2_get_papers` and passes the raw S2 response to `joinBibtex(rows)` (`src/gui/export.ts:87-99`).
2. `joinBibtex(rows)` outputs `row.paper?.citationStyles?.bibtex` verbatim.
3. Semantic Scholar's upstream `citationStyles.bibtex` generator is known to emit `@Article` with `booktitle = {...}` for conference papers (including NeurIPS, ICML, ACL, CVPR) and frequently omits `doi = {...}` even when `externalIds.DOI` is known on the paper!
4. Furthermore, the search window **already holds** the full `S2Paper` objects in `this.exportPapers()` (`src/gui/controller.ts:536-539`), complete with `publicationTypes`, `externalIds.DOI`, `externalIds.ArXiv`, `journal`, `venue`, `publicationVenue`, `year`, `title`, and `authors` (because `GUI_FIELDS` in `src/s2/fields.ts` includes all of them!).

### Fix

In `src/gui/export.ts` (and `src/gui/controller.ts:558-571`):

1. **Pass the known `S2Paper` metadata into `joinBibtex` (or normalize each BibTeX entry with `normalizeBibtexEntry(rawBibtex: string, paper?: S2Paper)` in `src/gui/export.ts`):**
   - **Fix entry type vs `booktitle` / `journal` mismatch:**
     - If the entry header is `@Article{...}` (case-insensitive) and the body contains `booktitle =` with no `journal =`:
       - If the paper is a conference paper (`paper?.publicationTypes?.includes("Conference")` or `paper?.publicationVenue?.type === "conference"`, or `booktitle` is present with no `journal` and not a journal article), rewrite `@Article{` → `@inproceedings{`.
       - Conversely, if `paper?.publicationTypes?.includes("JournalArticle")` (and not `"Conference"`), rewrite `booktitle =` → `journal =`.
   - **Inject missing `doi` (and `eprint` / `archivePrefix` for arXiv-only preprints when missing):**
     - If `paper?.externalIds?.DOI` is present and the BibTeX entry has no `\bdoi\s*=` field (case-insensitive), insert `  doi = {${paper.externalIds.DOI}},` before the closing `}`.
     - Optional: if the paper has no DOI and no `journal`/`booktitle`, or is an arXiv preprint with `paper?.externalIds?.ArXiv` and no `eprint` / `journal`, include `eprint = {${paper.externalIds.ArXiv}}, archivePrefix = {arXiv}`.
   - **Fallback BibTeX synthesis when S2's `citationStyles.bibtex` is missing (`row.paper?.citationStyles?.bibtex` is null/empty):**
     - Build a clean BibTeX entry directly from `S2Paper` (`@inproceedings`, `@article`, or `@misc`) so `missing` drops to 0 for any paper in the table!

---

## 2. Multiple `zotero-s2-mcp.mjs` bridge processes from concurrent sessions

### Investigation (verified in `addon/content/bridge/zotero-s2-mcp.mjs:342, 377-390` and `src/s2/rateLimiter.ts`)

- In `addon/content/bridge/zotero-s2-mcp.mjs`:
  - Line 342: the offline watch `setInterval` timer calls `timer.unref()`, so it never keeps Node alive after stdin closes.
  - Lines 385-390: `lines.on("close", ...)` waits for in-flight requests and cache writes, then calls `process.exit(0)`.
- In `src/s2/client.ts` and `src/s2/rateLimiter.ts`:
  - All stdio bridge processes forward to the single HTTP endpoint inside Zotero (`http://127.0.0.1:23119/s2/mcp`), so all requests pass through the plugin's single in-process `RateLimiter` queue.
- **Why 4 bridge processes existed:** MCP clients (such as 4 open Claude Code / IDE windows or subagents on the host) each spawn their own stdio child process for the duration of their session. When one session issues parallel tool calls (or several sessions call S2 at the same time), requests queue behind the 1 RPS limit; if the key is also used outside Zotero or S2 returns 429, the plugin backs off and surfaces the `"wait and retry"` message as designed.
- **Optional hardening in `zotero-s2-mcp.mjs`:** also listen to `process.stdin.on("end", ...)` and check parent liveness (`process.ppid === 1` poll or `SIGHUP`/`SIGTERM` handler) in case a crashed client leaves a pipe descriptor open without closing stdin.

---

## Order of work

1. [x] `Normalize exported BibTeX entries (@inproceedings for booktitle and add missing DOI)` (`src/gui/export.ts`, `src/gui/controller.ts`, `test/gui.export.test.ts`).
2. [x] Run `npx prettier --write` on touched files and verify `npm run lint:check` and `npm run build`.

## Verification

- `npm run build`, `npm run lint:check`, `npx prettier --check .`.
- Unit tests in `test/gui.export.test.ts`:
  - `@Article` with `booktitle` and `ATTENTION` (`externalIds.DOI`) → `@inproceedings` with `booktitle` and `doi = {10.48550/arXiv.1706.03762}` (or the paper's DOI).
  - `@Article` with `journal` and `DEEP_LEARNING` (`externalIds.DOI: "10.1038/nature14539"`) lacking `doi` in S2's raw BibTeX → keeps `@article` and adds `doi = {10.1038/nature14539}`.
  - Entry that already has `doi = {...}` → not duplicated.

## Open questions for the owner

1. When S2 returns `citationStyles.bibtex: null` for a paper that is present in the search results table, should `joinBibtex` synthesize a BibTeX entry from the `S2Paper` metadata we already have instead of skipping the paper as "missing"?
   - Answered: yes. `bibtexFromPaper` builds it; only papers with no metadata are still missing.

---

# PLAN: install the stdio bridge from a packed .xpi

> Branch `fix/agent-usage-findings`. Written 2026-11-15. Fixed on this branch (`src/modules/bridge.ts` now uses `Zotero.File.getResourceAsync`, tested in `test/startup.test.ts`).

## Symptom

After installing the built `zotero-s2.xpi` (0.1.0) in Zotero 10.0.9 and restarting, `<data dir>/zotero-s2/zotero-s2-mcp.mjs` does not exist, so the bridge command from the settings pane (`claude mcp add zotero-s2 … -- node "<data dir>/zotero-s2/zotero-s2-mcp.mjs"`) points at a missing file. The direct HTTP endpoint works.

## Cause

`installBridge()` in `src/modules/bridge.ts` reads the packaged script with `Zotero.File.getContentsFromURLAsync(`${rootURI}content/bridge/${FILE}`)`. That goes through `Zotero.HTTP.request`, whose `_parseURI` reads `uri.username`. For an installed plugin `rootURI` is `jar:file://…/zotero-s2@dingzy53.github.io.xpi!/`, and `nsIURI.username` throws on a `jar:` URI. Debug log (`zotero -ZoteroDebugText`):

```
NS_ERROR_FAILURE Exception: Component returned failure code: 0x80004005 (NS_ERROR_FAILURE) [nsIURI.username]
    _parseURI@chrome://zotero/content/xpcom/http.js:33:20
    Zotero.HTTP</this._requestInternal@chrome://zotero/content/xpcom/http.js:235:72
    ...
    getContentsFromURLAsync@chrome://zotero/content/xpcom/file.js:383:24
    installBridge@jar:file:///…/zotero-s2@dingzy53.github.io.xpi!/content/scripts/zoteros2.js:5123:38
    onStartup@…/zoteros2.js:5343:5
```

The scaffold test profile loads the plugin unpacked (`file://` rootURI), which is presumably why the tests never hit this. mineru-for-zotero copied this code and has the same bug.

## Fix

1. In `installBridge()`, read the source with `Zotero.File.getResourceAsync(url)` instead (it opens a channel with the system principal and skips the HTTP layer; works for `jar:` and `file:`).
2. Test: call `installBridge()` against a temp data directory and assert the file is written and equals `addon/content/bridge/zotero-s2-mcp.mjs`.
3. Manual check with the built .xpi in a normal profile: delete `<data dir>/zotero-s2/`, restart Zotero, confirm the file is recreated.

## Workaround in use

The bridge was copied by hand from `addon/content/bridge/` to `~/Zotero/zotero-s2/`. Until the fix ships, that copy is not refreshed on plugin updates.

# Findings from install, human and agent testing (2026-11-15)

> Critical bugs fixed on this branch: #1 (`<token>` help text), #3 (Cmd/Ctrl+W closes search window), #4 (error shown in empty results pane instead of stale placeholder), #6 (empty-key Test button message), #9 (Abstract heading & prefix cleanup), #10 (`s2_recommend` empty-result note & CS pool docs), #11 (unknown-argument error lists valid names & closest match), #13 (`year` accepts integers), #14 (`zotero_find_in_library` title hint). Remaining items (#2, #5, #7, #8, #12, #15, #16) are tracked below for follow-up PRs.

Tested with the 0.1.0 build in Zotero 10.0.9 on macOS: settings pane, search window and MCP over HTTP and through the stdio bridge, with no API key set at first. Screenshots are in `.screenshots/` (untracked, listed in `.git/info/exclude`).

## Bugs

1. **The settings help text loses `<token>`.** `pref-mcp-help` in `addon/locale/en-US/preferences.ftl:29` contains `"Authorization: Bearer <token>"`; Fluent/XHTML treats `<token>` as markup and drops it, so the pane reads `Send the token as "Authorization: Bearer ". ` (`.screenshots/03-settings-bearer-blank-and-token-in-stdio-cmd.jpg`). Use `&lt;token&gt;`, `{"<"}token{">"}`, or plain words ("Bearer followed by the token").
2. **The token is masked in one field and shown in another.** The Bearer token field is a password field with an eye toggle, but the "Claude Code (stdio)" command next to it shows `ZOTERO_S2_TOKEN=0b…` in clear text (same screenshot). Either mask the token inside both command fields until the eye is toggled, or drop the masking.
3. **Cmd+W does not close the search window.** Tools → Search Semantic Scholar… opens a window that ignores Cmd+W (the shortcut went to nothing; the red close button works). Add a `<key>` for `cmd_close` / `Escape`.
4. **Stale placeholder after an error.** After a search fails (for example "No Semantic Scholar API key set."), the results pane and the status bar still say "Enter a query and press Search." although a query was entered (`.screenshots/04-search-no-key-stale-placeholder.jpg`). Show the error state in the results pane instead.

## Improvements

5. **Nothing works without an API key.** Every MCP tool and the search window refuse to run with no key (`No Semantic Scholar API key set…`), but the Semantic Scholar Graph API accepts unauthenticated requests at a shared, lower rate limit. Consider allowing keyless use with a clear "shared rate limit, add a key for reliable use" notice, so a fresh install can be tried at once.
6. **The empty-key Test message points to where the user already is.** Clicking Test with an empty key in Settings → Zotero S2 says "Add one in Zotero → Settings → Zotero S2." (`.screenshots/02-test-empty-key.jpg`). In the pane, "Enter an API key first" is enough; keep the path for MCP and the search window.
7. **Warn before searching.** The search window could show the missing-key banner as soon as it opens, rather than after the first search.

## With the API key set (2026-11-15)

Test in settings: "OK: Semantic Scholar accepted the API key." The search window and `s2_match_title` work; one `s2_match_title` call took ~6 s because it hit two `429`s right after the Test click and the window search, and the backoff recovered as designed.

8. **"Add 1 paper" for a paper already in the library.** Selecting a result marked "✓ In library" still offers an enabled "Add 1 paper" button (`.screenshots/06-in-library-but-add-button-enabled.jpg`). Adding is deduplicated (the add bar reports "existing"), but the button could say so up front, for example "Add to MIMMC (already in library)" or "Show in Zotero".
9. **Abstract heading runs into the text.** The details pane shows "Abstract The range anxiety has…" on one line; give "Abstract" its own heading or a line break.

# Findings round 2: GUI and MCP errors (2026-11-15, not fixed)

## MCP errors an agent hits

10. **`s2_recommend` returns `{"papers": []}` with the default pool.** The tool defaults to `pool: "recent"`; Semantic Scholar's `forpaper` endpoint returned `[]` for every paper tried with `from=recent` (including "Attention Is All You Need"), but three results with `from=all-cs`. Non-CS papers (all of MIMMC) get nothing from `all-cs` either. An empty list with no explanation reads as "no related work". Return a note when the result is empty ("no recent recommendations; try pool all-cs, which only covers computer science"), consider `all-cs` as the default, and say in the description that recommendations only cover CS papers.
11. **Unknown-argument errors do not list the accepted names.** `s2_search_papers {"max_results": 3}` → `Unknown argument "max_results"` (and `{"q": …}`), while `s2_search_papers_bulk` does take `max_results`. Include the valid argument names and the closest match.
12. **Inconsistent argument naming.** Tools mix camelCase and snake_case: `publicationDateOrYear`, `fieldsOfStudy`, `minCitationCount`, `paperIds` next to `paper_id`, `positive_ids`, `max_results`, `item_keys`; `limit` in one search tool and `max_results` in the other. Pick one style (snake_case, as the zotero_* tools use) and accept the other as an alias.
13. **`year` must be a string.** `{"year": 2020}` → `year must be string, got integer`. Accept integers (and `[2020, 2024]`).
14. **`zotero_find_in_library` cannot find by title.** Given a title it reports `inLibrary: false` with a warning that Semantic Scholar rejected it as an id (`400 … No valid paper ids given`). Agents will try titles; either resolve titles through `s2_match_title` or say "ids only; use s2_match_title first" in the error.
15. **Rate limiting makes some calls slow.** One `s2_search_papers` with a year filter took 20.8 s and one `s2_match_title` 6 s, waiting out `429`s after earlier calls. It works as designed, but the time is invisible to the agent; mention in the result when the call waited for rate limiting.

## GUI

16. **Reopened window restores the query but not the results.** Reopening the search window shows the last query in the box (and the last mode) but an empty results pane saying "Enter a query and press Search." Either restore the results too or start with an empty box, so the window does not look as if the query had no results.
17. Things that work well and are worth keeping: the rate-limit status line ("Waiting for Semantic Scholar (requests are limited to 1 per second and shared with agents)…"), the Citations view with a breadcrumb and Back, ✓ In library marks, Cards view, the Advanced filters (year, citations, venues, fields) and the Export menu (BibTeX/RIS/CSV).
