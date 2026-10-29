# PLAN: Semantic Scholar search window for humans

> Branch `feat/search-gui`. This file is also committed as `PLAN.md` at the repo root.

## Status (2026-10-29)

All eight steps are implemented on `feat/search-gui`, one commit each. `npm run build`, `npm run lint:check` and the Zotero test run pass after every step: the suite went from 88 to 122 tests.

Where the build differs from this plan:

- **Results table:** a plain HTML table, not `VirtualizedTableHelper`. A result set holds at most 1,000 rows, so it doesn't need virtualization. A plain table also leaves selection fully under our control: one `Set` that the table and card views share, with click, Ctrl/Cmd-click, Shift-click, arrow keys and Ctrl/Cmd+A. And it avoids React rendering that runs out of step with the tests.
- **Search history:** a **Recent** menu button next to the query box, not a `<datalist>`, because datalist popups aren't reliable in chrome windows.
- **Test hooks:** `addon.api` exposes `openSearchWindow`, `closeSearchWindows`, `searchWindows`, `controllerFor`, `guiDeps` and `getActivity`. The test bundle has its own copies of every module, so this is how it reaches the running plugin.
- **Default target:** when the main window has a single library selected and there's no remembered target, the add bar starts on that library's root.

Still to check by hand, since automated tests can't cover it: a real API key against live S2 (manual steps 1–8 below), and the save dialogs for BibTeX, RIS and CSV.

## Context

Today, Zotero S2 is agent-only. MCP and REST endpoints let AI agents search
Semantic Scholar (S2) and file papers into Zotero, and humans only get a
settings pane. This change adds a **search window for people**, opened from
Zotero's main window (**Tools → Search Semantic Scholar…**). In it you can:

- run a simple search or an advanced one (filters, boolean/bulk syntax);
- browse authors, citations, references and recommendations;
- add selected papers (with PDFs) to a chosen collection;
- export results.

It reuses the existing tool layer, so S2 traffic stays behind the one shared
client, its rate limiter (1 request/s) and its retries. Adds use the same
dedupe, import, PDF and write-lock code as agents.

### Requirements (confirmed with the owner)

| Topic           | Decision                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry point     | Tools menu item only, through the official `Zotero.MenuManager` API                                                                                                                                           |
| Form            | A separate, resizable window, one instance only (opening it again focuses it)                                                                                                                                 |
| Search features | Simple keyword search, advanced filters, boolean/bulk search, citations/references/recommendations, author search                                                                                             |
| Results view    | Both **table + detail pane** and **card list**. Chosen in Settings (and with a toggle in the window, which writes the same pref)                                                                              |
| Add             | Library/collection picker (defaults described below), **Attach PDF on by default**, tags, metadata source (S2 / translator), create a new collection by `A/B/C` path. **At most 25 per add** (same as agents) |
| TLDR            | Not shown. No extra requests per paper                                                                                                                                                                        |
| Export          | BibTeX (copy or save), RIS and CSV files                                                                                                                                                                      |
| Behaviour       | Works when the MCP server is disabled (it still needs the API key). GUI calls are logged in the activity log as `via: "gui"`. The last search is remembered, and so is a history of recent queries            |
| Git             | Create branch `feat/search-gui`, commit `PLAN.md`, push to origin                                                                                                                                             |

## Facts from the docs that shape the design

**Zotero 10** (zotero.org/support/dev/zotero_{7,8,10}_for_developers, and `chrome/content/zotero/xpcom/pluginAPI/menuManager.js`):

- `Zotero.MenuManager.registerMenu({ menuID, pluginID, target: "main/menubar/tools", menus: [{ menuType: "menuitem", l10nID, icon, onCommand }] })` returns an id. `unregisterMenu(id)` removes it. Zotero 10 also removes plugin menus automatically on shutdown.
- Singular selection getters throw in Zotero 10. Use `getSelectedLibraryIDs()` / `getSelectedCollections()` instead.
- Windows: `win.openDialog("chrome://zoteros2/content/search.xhtml", name, "chrome,resizable,centerscreen,dialog=no", args)`. The content chrome root is already registered in `addon/bootstrap.js`.
  - Root element is `<window>`, loading `chrome://zotero/content/include.js`, `customElements.js`, `zotero.css` and `<html:link rel="localization">`.
- To localize the main window, call `win.MozXULElement.insertFTLIfNeeded("zoteros2-mainWindow.ftl")` in `onMainWindowLoad`, and remove the link on shutdown.
- Saving files: Zotero 8+ needs Zotero's `FilePicker` module, because `nsIFilePicker` requires a BrowsingContext. Write the file with `IOUtils`.
- Theme tokens such as `--material-background`, `--material-border`, `--fill-secondary`, `--accent-blue` and `--color-stripe` follow light/dark mode automatically.
- zotero-plugin-toolkit 6 still ships `VirtualizedTableHelper` (it wraps Zotero's own `components/virtualized-table`) and `ClipboardHelper`. Its own `MenuManager` was removed, so use `Zotero.MenuManager`.

**Semantic Scholar** (api.semanticscholar.org/graph/v1/swagger.json, recommendations swagger, /product/api/tutorial):

- `/paper/search` (relevance):
  - plain text only, and **hyphenated terms match nothing**;
  - `limit` ≤ 100, at most 1,000 results in total;
  - filters: `year` (`2019`, `2016-2020`, `2010-`, `-2015`), `publicationDateOrYear` (`2016-03-05:2020-06`), `venue`, `fieldsOfStudy`, `publicationTypes`, `minCitationCount`, and `openAccessPdf` (a flag).
- `/paper/search/bulk`:
  - boolean syntax: `+` `|` `-` `"phrase"` `prefix*` `( )` `~N`;
  - `sort` = `paperId|publicationDate|citationCount` followed by `:asc|:desc`;
  - up to 1,000 papers per page, paged with `token`;
  - takes the same filters, but no nested fields;
  - S2 recommends it as cheaper than relevance search.
- `publicationTypes` values: Review, JournalArticle, CaseReport, ClinicalTrial, Conference, Dataset, Editorial, LettersAndComments, MetaAnalysis, News, Study, Book, BookSection.
- `fieldsOfStudy`: 23 fixed values (Computer Science … Linguistics).
- `/author/search` (plain text, no hyphens). `/author/{id}/papers` takes `limit` ≤ 1000.
- Recommendations: `forpaper/{id}` (`from=recent|all-cs`, `limit` ≤ 500). `abstract` may be missing for legal reasons.

## Architecture

```
Tools menu ──► openSearchWindow() ──► search.xhtml (one window, windowtype "zoteros2:search")
                                         │ onload → hooks.onSearchWindowEvent("load", {window})
                                         ▼
                              src/gui/searchWindow.ts  (controller: DOM wiring, state)
                                 │            │                     │
                pure, unit-tested│            │ Zotero-local only   │ all S2 + writes
                                 ▼            ▼                     ▼
                     src/gui/model.ts   findExisting()/      runTool(TOOLS_BY_NAME.get(…),
                     src/gui/export.ts  collections.ts        args, deps.s2(), "gui")
                     src/gui/state.ts                         └─► the shared S2Client, rate limiter,
                                                                  activity log, validation
```

**Key rule: the GUI never calls `S2Client` methods directly.** Every S2 call
and every library write goes through `runTool` with an existing tool, so the GUI
gets argument validation, the 25-item cap, `libraryWrites`, PDF handling and
logging for free. The local "already in library" checks are the exception: they
call `findExisting(lib, idsFromPaper(p))` directly, with no S2 call.

## Changes by file

### New files

| File                                | Purpose                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addon/content/search.xhtml`        | Window markup: a toolbar (mode tabs, query box with history dropdown, Search button, view toggle), a collapsible filter panel, a results area, a detail pane, a breadcrumb/back bar, a status/paging bar, an add bar and an export menu. IDs follow `zoteros2-search-<suffix>`. The root has `windowtype="zoteros2:search"` and `persist="width height screenX screenY"`. |
| `addon/content/search.css`          | Layout (CSS grid/flex) using only Zotero theme tokens, so dark mode works. Card styles. Line-clamped abstracts.                                                                                                                                                                                                                                                           |
| `addon/content/icons/menu.svg`      | A 16×16 menu icon (light/dark through `context-fill`, or a separate `darkIcon`).                                                                                                                                                                                                                                                                                          |
| `addon/locale/en-US/search.ftl`     | All window strings (labels, placeholders, syntax help, status messages). Written unprefixed; the scaffold adds `zoteros2-`.                                                                                                                                                                                                                                               |
| `addon/locale/en-US/mainWindow.ftl` | `menu-search = ` followed by `.label = Search Semantic Scholar…`.                                                                                                                                                                                                                                                                                                         |
| `src/gui/menu.ts`                   | `registerMenu()` / `unregisterMenu()`, called once from startup and shutdown, not per window. `l10nID` must be written **with the prefix** (`` `${config.addonRef}-menu-search` ``), because the scaffold only rewrites FTL files and xhtml `data-l10n-id`. `addFTL(win)` / `removeFTL(win)` load the strings into the main window.                                       |
| `src/gui/searchWindow.ts`           | `openSearchWindow()`: focus the window if it exists (`Services.wm.getMostRecentWindow("zoteros2:search")`), otherwise `openDialog`. `onSearchWindowLoad(win)` wires the controller. `closeSearchWindows()` runs on shutdown so no window keeps dead plugin code.                                                                                                          |
| `src/gui/model.ts`                  | **Pure** form-state → tool-args builders, validation, identifier detection, paging state machine. No Zotero globals.                                                                                                                                                                                                                                                      |
| `src/gui/resultsTable.ts`           | Table view through `VirtualizedTableHelper`: multi-select, sortable columns, keyboard navigation, double-click opens details/S2.                                                                                                                                                                                                                                          |
| `src/gui/resultsCards.ts`           | Card view built with plain DOM (the existing `el()` style from `preferences.ts`): a checkbox on each card, rendered in batches of 100 with a "Show more" button.                                                                                                                                                                                                          |
| `src/gui/export.ts`                 | **Pure** RIS and CSV serializers from `S2Paper`, and a BibTeX joiner. File saving goes through `FilePicker` + `IOUtils` (the exact module path is to be checked against Zotero source: `chrome://zotero/content/modules/filePicker.mjs`). Copying uses `ClipboardHelper`.                                                                                                 |
| `src/gui/state.ts`                  | Reads and writes the last-state and history prefs as JSON, tolerating bad JSON or a missing pref. History keeps up to 20 queries, deduplicated case-insensitively, newest first.                                                                                                                                                                                          |
| `src/gui/deps.ts`                   | Test seam: `guiDeps = { s2: () => getS2Client() }`. Tests swap in a fixture client.                                                                                                                                                                                                                                                                                       |

### Modified files

| File                                                                               | Change                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/hooks.ts`                                                                     | Startup: `registerMenu()`. `onMainWindowLoad`: `addFTL(win)`. Shutdown: `closeSearchWindows()`, `unregisterMenu()`, and `removeFTL` for each main window. New dispatcher `onSearchWindowEvent("load"\|"unload", {window})`, following the `onPrefsEvent` pattern. Hooks stay dispatch-only.                                                                                                    |
| `src/mcp/runTool.ts`, `src/log/activity.ts`                                        | Widen `via` to `"mcp" \| "rest" \| "prefs" \| "gui"`. The prefs log already prints `e.via` as raw text, so no new string is needed.                                                                                                                                                                                                                                                            |
| `src/mcp/tools.ts`                                                                 | Add the optional `fields: fieldsOverride` to `s2_recommend` and `s2_get_author_papers`. As in the other tools, raw S2 JSON is returned when `fields` is set, and the compact default doesn't change. **This adds to the agent-facing schema; nothing is removed.** The GUI needs raw `externalIds` and `abstract` for dedupe badges and export. Export `MAX_ADD` so the GUI uses the same cap. |
| `src/s2/fields.ts`                                                                 | `GUI_FIELDS = SEARCH_FIELDS + corpusId,url,abstract,publicationDate,journal,fieldsOfStudy`. No `tldr`. `citationStyles` is requested only by the BibTeX export call.                                                                                                                                                                                                                           |
| `addon/prefs.js` (+ the regenerated `typings/prefs.d.ts`)                          | `resultsView = "table"`, `gui.lastState = ""`, `gui.history = ""`, `gui.pageSize = 25`.                                                                                                                                                                                                                                                                                                        |
| `addon/content/preferences.xhtml`, `preferences.ftl`, `src/modules/preferences.ts` | A new **"Search window"** group: a results view radio (Table + details / Cards), a page-size menulist, a "Clear search history" button, and an "Open search window" button.                                                                                                                                                                                                                    |
| `README.md`                                                                        | A "Search window" section: how to open it, the modes, the boolean syntax, adding and exporting.                                                                                                                                                                                                                                                                                                |
| `AGENTS.md`                                                                        | Layout rows for `src/gui/*`, `search.xhtml` and the new FTL files. Invariants listed under "Changes to the invariants" below.                                                                                                                                                                                                                                                                  |
| `test/helpers.ts`                                                                  | Extend `fixtureClient` to answer `/paper/search`, `/paper/search/bulk` (with a `token` across two pages), `/author/search`, `/author/{id}/papers`, `/paper/{id}/citations\|references` and `recommendations/.../forpaper`, all from `fixtures.ts`.                                                                                                                                             |

## The window, in detail

### Search modes (tabs above the query box)

1. **Papers: Simple.** One box and a Search button.
   - **Identifier auto-detect:** if `model.detectIdentifier(q)` recognizes a DOI, arXiv id, CorpusId, S2 sha, a known S2 prefix (PMID/PMCID/ACL/MAG/DBLP) or an http(s) URL, the window runs a lookup with `s2_get_papers` and opens that paper's details instead of searching.
   - Detection must check the _recognized_ fields of `ParsedId` (`doi`, `arxiv`, `corpusId`, `s2Id`, a URL, or a prefix in `S2_PREFIXES`). `parseIdentifier` falls back to `{s2Query: input}` for any text, and `"Transformers: a survey"` matches its prefix regex.
   - Otherwise it calls `s2_search_papers` (relevance) with **hyphens turned into spaces** and a small hint explaining why.
2. **Papers: Advanced.** The same box plus the filter panel:
   - Year from/to (builds `year`, e.g. `2016-2020`, `2010-`, `-2015`), or an exact date range (`publicationDateOrYear`).
   - Venue(s): comma-separated.
   - Fields of study: a checkbox grid of the 23 S2 values.
   - Publication types: a checkbox grid of the 13 values.
   - Min citations, and an "Open-access PDF only" checkbox.
   - Inline validation: from > to, malformed dates, non-numeric citations. The Search button is disabled with the reason shown.
   - A "Reset filters" button. A filter-chip summary shows while the panel is collapsed.
3. **Papers: Boolean (bulk).** Raw query passed through unchanged (no hyphen rewriting), the same filters, a **Sort** menulist (Relevance order is not available here: paperId ↑, citations ↓/↑, publication date ↓/↑) and a collapsible syntax cheat-sheet with the examples from the S2 tutorial. It calls `s2_search_papers_bulk` with `max_results: 1000`, so the continuation token never skips trimmed rows.
4. **Authors.** `s2_search_authors` lists authors (name, affiliations, papers, citations, h-index). Selecting one runs `s2_get_author_papers` (with `fields: GUI_FIELDS`) and fills the results area.

### Related navigation (citations, references, recommendations)

The detail pane, and each card, has **Citations**, **References** and **Similar
papers** buttons. They call `s2_get_citations` / `s2_get_references` (with
`fields: GUI_FIELDS`, unwrapping `citingPaper` / `citedPaper`) or `s2_recommend`
(single paper, `pool` menulist recent/all-cs, `fields: GUI_FIELDS`). Each one
pushes a new **result set** onto a navigation stack. A breadcrumb (`Search
"x" › Citations of "Attention is…"`) with a Back button restores the previous set
along with its selection and scroll position, without calling S2 again.

### Results views (pref `resultsView`, toggle in the window toolbar)

- **Table + details**:
  - Columns: in-library ✓, title, first author et al., year, venue, citations, OA (PDF icon). Sortable on the client within the loaded set.
  - The detail pane shows the full title, all authors (clicking one starts an author search), venue/journal, date, types, fields of study, abstract (or "Abstract unavailable from S2"), DOI/arXiv/CorpusId links, "Open on Semantic Scholar", "Open PDF", and "Show in Zotero" when the paper is already in the library (`ZoteroPane.selectItem`).
- **Cards**:
  - Each card has a title link, an authors line, `venue · year · N citations · OA`, the abstract clamped to 3 lines with a "more" toggle, a checkbox, an in-library badge and the related-navigation buttons.
- Both views share one selection model (`Set<paperId>`) in the controller, so switching views keeps the selection.

### Paging and state

- **Relevance search:** the page size comes from a pref (25/50/100). Prev/Next use `offset`, and Next is disabled once `offset + limit` reaches 1000. The status line reads "Showing 26–50 of ~12,345 (S2 caps relevance results at 1,000; use Boolean mode for more)".
- **Bulk search:** each request returns up to 1000 papers. "Load more" appends the next `token` page.
- **Citations, references, author papers:** use offset paging with the same controls.
- **Pure state machine** (`model.ts`): `{ kind, offset, total, next, token }` → `canPrev`, `canNext`, `nextArgs`.
- **Stale responses:** a request-generation counter drops results from searches that a newer one has superseded.
- **While a request runs:**
  - The Search button becomes disabled and a spinner shows.
  - If the request takes longer than 1.5 s, the status reads "Waiting for Semantic Scholar (requests are limited to 1/s and shared with agents)…".
  - There is **no search-as-you-type**. Requests start only on Enter or a click.
- **Errors:**
  - A `ToolOutcome` with `ok: false` shows its message in an inline error banner.
  - With no API key, the banner says so and has an "Open settings" button (`Zotero.Utilities.Internal.openPreferences(getPrefsPaneID())`). The search controls stay usable for editing.

### "In library" badges

- After each result set renders, the controller checks the rows **currently loaded or visible**: chunks of 25, async, yielding between chunks.
- Each check is `findExisting(targetLib, idsFromPaper(p))`, cached by `paperId` for each library.
- The cache is cleared after an add, or when the target library changes. 1,000 bulk rows are never checked all at once.

### Add bar (bottom)

- **Library** menulist: the editable libraries (`Zotero.Libraries.getAll().filter(l => l.editable)`).
- **Collection** menulist: the library root plus the collection tree, flattened and indented, built from `listCollections` / `collectionPath`. A "New collection…" entry shows an `A/B/C` path text box (`create_collection: true`).
- **Default target, in order:**
  1. the collection selected in the main window, **only if exactly one** collection is selected (using the plural getters `getSelectedLibraryIDs()` / `getSelectedCollections()`);
  2. otherwise, the last-used target from `gui.lastState`;
  3. otherwise, My Library root.
  - ⚠ This is a **deliberate, GUI-only exception** to AGENTS.md's "Never read the UI selection". AGENTS.md will be updated to say so.
  - The add call still passes `library_id` and a collection key explicitly.
- **Other controls:** a Tags text box (comma-separated), a Metadata menulist (S2 fast / Zotero translator, richer), and **Attach PDF** (checked by default).
- **"Add N selected" button:**
  - Disabled when nothing is selected. If more than 25 are selected (`MAX_ADD`), it's disabled with the hint "Select at most 25 papers per add".
  - It calls `zotero_add_papers` with `ids` (paperIds), `collection`, `create_collection`, `attach_pdf`, `tags`, `metadata_source` and `library_id`.
  - While running: the button is disabled and the status reads "Adding 12 papers… (PDF downloads may take a while)".
  - Afterwards: a summary ("8 added, 3 already in library, 1 failed · 7 PDFs attached"). Each row/card shows its outcome (added / existing / error message / PDF status), the badges refresh, and the collection list reloads if a new collection was created.

### Export (toolbar menu, acting on the selection or on all loaded results)

- **Copy BibTeX** / **Save BibTeX…**: one `s2_get_papers` call with `fields: "citationStyles"` (up to 500 ids, so one request). The entries are joined, and papers without BibTeX are reported.
- **Save RIS…** / **Save CSV…**: built from the data already loaded, with no S2 call. Serializers are pure and RFC 4180 CSV quoting is applied. Columns: title, authors, year, venue, DOI, arXiv, S2 id, URL, citations, abstract.

### Remembered state and history

- `gui.lastState` records: mode, query, filters, sort, page size, view, collapsed panels, target library/collection, tags, metadata source and attach-PDF. It is restored on open, and saved on each search and on window unload.
- `gui.history` keeps up to 20 recent queries per mode. They show in a dropdown on the query box, and the prefs pane has a "Clear" button for them.

## Changes to the invariants (to add to AGENTS.md)

- The GUI talks to S2 and writes to the library **only through `runTool(…, "gui")`** with existing tools. Do not create another `S2Client` or `RateLimiter`, and do not call `S2Client` methods directly from `src/gui`. The local `findExisting` badge checks are the only exception.
- GUI searches run only on an explicit Enter or click: no search-as-you-type, no automatic prefetch. Every request competes with agents for the same 1/s budget.
- The GUI may read the main-window selection, **plural getters only**, and only to _preselect_ a default target. Tool handlers must still never read it.
- The GUI does not check the `enable` pref, which gates only HTTP. It still needs the API key.
- Menus come only from `Zotero.MenuManager`, registered once in `onStartup` and removed in `onShutdown`. Search windows are closed on shutdown.

## Implementation order (one commit each, all checks green each time)

1. **Plumbing:**
   - menu, main-window FTL, window shell, open/focus/close, the `via: "gui"` widening, `deps.ts`;
   - test: the Tools menu item exists with a non-empty label, and opening twice gives one window.
2. **Model + simple/advanced search + table view + paging + errors:**
   - `model.ts` unit tests;
   - fixture-backed test: query → rows rendered.
3. **Bulk mode** with sort, token "Load more", and the syntax help.
4. **Detail pane, card view**, the view pref (prefs pane plus in-window toggle).
5. **Add bar:**
   - library/collection picker, new collection, tags, metadata source, PDF;
   - badges, the 25 cap;
   - test: select → add → item is in the collection; 26 selected → button disabled.
6. **Related navigation and author mode;** `fields` added to `s2_recommend` / `s2_get_author_papers`, with schema tests.
7. **Export** (BibTeX/RIS/CSV) with pure serializer tests, plus **history and last state** with round-trip tests.
8. **Docs:** README and AGENTS.md updates. `npm run lint:fix`.

## Verification

- At every step: `npm run build`, `npm run lint:check`, `npx zotero-plugin test --no-watch --exit-on-finish`. All must pass, as AGENTS.md requires.
- **Unit tests (offline):** `test/gui.model.test.ts`, covering:
  - filter → args (year ranges, the `openAccessPdf` flag, comma lists);
  - hyphen rewriting in relevance/author modes only;
  - `detectIdentifier` positives (DOI, arXiv, URL, CorpusId, sha, PMID) and negatives (`"Transformers: a survey"`, plain text);
  - the paging state machine, including the 1,000 cap and token paging;
  - history dedupe and cap; state JSON tolerant of garbage.
- **Unit tests (offline):** `test/gui.export.test.ts`, covering RIS and CSV escaping (quotes, commas, newlines, missing fields) and the BibTeX join.
- **Integration (real Zotero, fixture S2 through `guiDeps`):** `test/gui.test.ts`, covering:
  - the menu is registered and labeled;
  - `openSearchWindow()` opens one window, and a second call focuses it;
  - search fills the table, and switching to cards keeps the selection;
  - adding to a new `GUI/Test` collection creates the items, and a second add reports "already in library";
  - more than 25 selected disables Add;
  - the activity log has `via: "gui"` entries;
  - closing and reopening restores the last state;
  - after `closeSearchWindows()`, no windows remain.
  - Poll by re-querying `win.document`, as `prefs.test.ts` does.
- **Manual check with a real key:** run `npm start` (dev Zotero, not the everyday profile), then:
  1. Tools → Search Semantic Scholar…;
  2. search "attention is all you need", filter 2017 and CS, and add with a PDF to `Test/GUI`;
  3. run a boolean query `"graph neural" +survey -quantum`, sorted by citations ↓, and use Load more;
  4. on one result, open Citations → Back;
  5. search the author "Yoshua Bengio" and open their papers;
  6. export the selection to RIS and CSV and open the files;
  7. try dark mode;
  8. with MCP disabled in Settings, check that the window still works.

## Sources

- Zotero 7/8/10 for developers: https://www.zotero.org/support/dev/zotero_7_for_developers, https://www.zotero.org/support/dev/zotero_8_for_developers, https://www.zotero.org/support/dev/zotero_10_for_developers
- MenuManager source: https://github.com/zotero/zotero/blob/main/chrome/content/zotero/xpcom/pluginAPI/menuManager.js
- Zotero theme tokens: https://github.com/zotero/zotero/blob/main/scss/themes/_light.scss, `_mixins.scss`
- zotero-plugin-toolkit 6: https://github.com/windingwind/zotero-plugin-toolkit
- S2 Graph API: https://api.semanticscholar.org/graph/v1/swagger.json, recommendations: https://api.semanticscholar.org/recommendations/v1/swagger.json, tutorial: https://www.semanticscholar.org/product/api/tutorial
