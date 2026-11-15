# PLAN: install the stdio bridge from a packed .xpi

> Branch `fix/agent-usage-findings`. Written 2026-11-15. Not fixed yet.

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

# Findings from install, human and agent testing (2026-11-15, not fixed)

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
