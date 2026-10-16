# Zotero S2

A Zotero 10 plugin that lets AI agents search [Semantic Scholar](https://www.semanticscholar.org/product/api) and add papers and PDFs to Zotero collections.

The plugin serves an **MCP endpoint from inside Zotero** on Zotero's local server, so no separate process is needed. The same tools are also exposed as plain REST endpoints for scripts and `curl`.

- **Semantic Scholar API key only.** Unkeyed requests are never sent.
- **1 request/second**, shared by every caller. One FIFO queue spaces request starts at least 1050 ms apart.
- **Exponential backoff** on 429, 5xx and network errors: 1 s, 2 s, 4 s … capped at 60 s, plus up to 500 ms of jitter. `Retry-After` is honored. A request gives up after 6 retries. Retries go back through the same queue, so the rate limit still holds.
- **Adds entries or PDFs to a collection.** Collections can be given by key or by slash path (`Project/Reading`), and missing ones are created. Papers already in the library are matched by DOI, arXiv id, S2 id or title + year, then reused rather than duplicated.
- **PDFs** are stored as files. Sources are tried in order: S2 open-access PDF, then arXiv, then Zotero's own "Find Available PDF" resolvers. Zotero rejects anything that isn't really a PDF.

## Install

1. Build with `npm install && npm run build`, or download a release `.xpi`.
2. In Zotero 10, go to **Tools → Plugins → ⚙ → Install Plugin From File…** and pick `.scaffold/build/zotero-s-2.xpi`.
3. Open **Settings → Zotero S2**. Paste your Semantic Scholar API key and click **Test**.
4. Copy the **Claude Code** command shown there, or set up any MCP client that speaks Streamable HTTP:

```sh
claude mcp add --transport http zotero-s2 http://127.0.0.1:23119/s2/mcp \
  --header "Authorization: Bearer <token from settings>"
```

## Tools

| Tool                                                                                    | What it does                                                                                                                                                             |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `s2_search_papers`                                                                      | Relevance search with year, field, type, venue, citation and open-access filters                                                                                         |
| `s2_search_papers_bulk`                                                                 | Boolean bulk search with sort and continuation token                                                                                                                     |
| `s2_match_title`                                                                        | Best match for a title                                                                                                                                                   |
| `s2_get_papers`                                                                         | Details for 1–500 ids in one request (S2 id, `DOI:`, `ARXIV:`, `CorpusId:`, `PMID:`, `URL:`, bare DOI or arXiv id, doi.org or arxiv.org URLs)                            |
| `s2_get_citations` / `s2_get_references`                                                | Citation graph, optionally with contexts and intents                                                                                                                     |
| `s2_recommend`                                                                          | Recommendations from one paper or from positive/negative lists                                                                                                           |
| `s2_search_authors` / `s2_get_author_papers`                                            | Authors                                                                                                                                                                  |
| `s2_snippet_search`                                                                     | Full-text snippet search                                                                                                                                                 |
| `zotero_list_collections` / `zotero_create_collection` / `zotero_list_collection_items` | Library structure                                                                                                                                                        |
| `zotero_find_in_library`                                                                | Which papers are already in Zotero, plus their collections and PDF status                                                                                                |
| `zotero_add_papers`                                                                     | Add ≤25 papers to a collection, with optional PDFs, tags and a note. Metadata comes from S2 (`metadata_source: "s2"`) or Zotero's DOI/arXiv translators (`"translator"`) |
| `zotero_attach_pdf`                                                                     | Find and attach PDFs for existing items                                                                                                                                  |
| `zotero_add_pdf_from_url`                                                               | Download a PDF, attach it to an item or save it standalone (Zotero recognizes the metadata)                                                                              |
| `zotero_enrich_items`                                                                   | Fill missing metadata on existing items from S2                                                                                                                          |

Every call appears in the **Activity** table in settings, with duration, S2 call count, retries and errors.

## HTTP interface

All paths live on Zotero's local server (`127.0.0.1:23119` by default). Every request needs `Authorization: Bearer <token>`.

- `POST /s2/mcp` serves MCP over Streamable HTTP with JSON responses. It is **dual-era**: the stateless 2026-07-28 protocol (`server/discover`, mirrored-header validation) and the `initialize`-based 2025-03-26 … 2025-11-25 revisions.
- `GET /s2/tools` lists the tools and their JSON Schemas.
- `POST /s2/tools/<name>` takes the tool's arguments as the JSON body and returns its JSON result. Errors come back as `400 {"error": …}`.

```sh
curl -s -X POST http://127.0.0.1:23119/s2/tools/zotero_add_papers \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"ids":["ARXIV:1706.03762","DOI:10.1038/nature14539"],"collection":"Agent/Inbox"}'
```

**Security:**

- Zotero only accepts `Host: 127.0.0.1` or `localhost`.
- Any request carrying an `Origin` header (that is, from a web page) gets `403`.
- Every request needs the bearer token. You can regenerate it in settings.
- MCP Inspector works in proxy mode. Its direct-from-browser mode sends an `Origin` header and is refused.

## Before publishing

`package.json` → `repository` is a placeholder (`OWNER/zotero-S2`). Zotero requires `update_url`, so the build currently points it at an inert `https://localhost/…` URL in `zotero-plugin.config.ts`. Set the real GitHub repo in `package.json`, then switch `updateURL` back to the `{{owner}}/{{repo}}` release URL before running `npm run release`. The addon ID (`zotero-s2@dingzhengyuan.dev`) should be final before the first public release, because changing it later orphans installed copies and their settings.

## Development

```sh
cp .env.example .env   # point ZOTERO_PLUGIN_ZOTERO_BIN_PATH at a Zotero 10 binary
npm start              # Zotero with hot reload
npm test               # mocha suite inside Zotero (fresh profile, server on port 23129)
npm run build          # .xpi + tsc --noEmit
npm run lint:check
```

The source is laid out like this:

- `src/s2/` holds the rate limiter and the S2 client.
- `src/zotero/` covers the S2 → Zotero mapping, dedupe, collections and PDFs.
- `src/mcp/` contains the tools, argument validation and the MCP dispatcher.
- `src/http/endpoints.ts` registers the endpoints and handles auth.
