# Zotero S2

[![Release](https://img.shields.io/github/v/release/dingzy53/zotero-S2)](https://github.com/dingzy53/zotero-S2/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/dingzy53/zotero-S2/total)](https://github.com/dingzy53/zotero-S2/releases)
[![Zotero 10](https://img.shields.io/badge/Zotero-10-cc2936)](https://www.zotero.org/)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)

A Zotero 10 plugin that lets AI agents, and you, search [Semantic Scholar](https://www.semanticscholar.org/product/api) and file papers, with PDFs, into your Zotero collections.

The plugin serves an **MCP endpoint from inside Zotero**, on Zotero's own local server, so there is no separate process to run. The same tools are also available as plain REST endpoints for scripts and `curl`.

<!-- Screenshot: docs/images/hero.png -->

## Features

- **Search and explore:** relevance and boolean search, title matching, full-text snippets, citations and references, recommendations, authors.
- **File papers:** add up to 25 papers per call to a collection, given by key or by slash path (`Project/Reading`). Missing collections are created. Papers already in your library are matched by DOI, arXiv id, S2 id or title + year, then reused rather than duplicated.
- **Attach PDFs:** sources are tried in order: the S2 open-access PDF, then arXiv, then Zotero's own "Find Available PDF" resolvers. Zotero rejects anything that isn't really a PDF. When there's no open copy, an agent can pass a PDF URL or article page, or hand over a PDF it downloaded itself (a local path, or the bytes as base64).
- **Fill in metadata:** enrich existing items with abstracts, dates, venues, DOIs and authors from Semantic Scholar.
- **A search window for people:** **Tools → Search Semantic Scholar…** offers simple, advanced and boolean search, authors, citations and recommendations, and adds what you pick straight into a collection.
- **Polite to Semantic Scholar:** keyed requests only, at most 1 per second across all callers, with exponential backoff.

## Requirements

- [Zotero 10](https://www.zotero.org/download/).
- A Semantic Scholar API key. It's free: [request one here](https://www.semanticscholar.org/product/api#api-key-form). The plugin never sends unkeyed requests.

## Installation

1. Download `zotero-s2.xpi` from the [latest release](https://github.com/dingzy53/zotero-S2/releases/latest). In Firefox, right-click the link and choose **Save Link As…**, or Firefox tries to install it as a browser add-on.
2. In Zotero, open **Tools → Plugins**.
3. Click the gear icon, choose **Install Plugin From File…** and select the downloaded file.
4. Restart Zotero if it asks you to.

**Update or remove:** Zotero updates the plugin on its own. To check now, or to remove the plugin, use **Tools → Plugins**.

**Set up:** open **Edit → Settings** (**Zotero → Settings** on macOS) → **Zotero S2**, paste your API key and click **Test**. Then [connect your agent](#connect-an-agent).

## Connect an agent

Zotero has to be running while the agent uses the tools. The settings pane shows the endpoint, a bearer token, and a ready-made Claude Code command:

```sh
claude mcp add --transport http zotero-s2 http://127.0.0.1:23119/s2/mcp \
  --header "Authorization: Bearer <token from settings>"
```

Any MCP client that supports Streamable HTTP can connect the same way. A typical JSON configuration looks like this:

```json
{
  "mcpServers": {
    "zotero-s2": {
      "type": "http",
      "url": "http://127.0.0.1:23119/s2/mcp",
      "headers": { "Authorization": "Bearer <token from settings>" }
    }
  }
}
```

The server speaks both the stateless MCP 2026-07-28 protocol and the `initialize`-based 2025-03-26 … 2025-11-25 revisions. Responses are plain JSON: there is no SSE and no session.

Then just ask, for example: _"Find the most-cited papers on retrieval-augmented generation since 2023 and add the top ten to Reading/RAG with PDFs."_

## Search window

Open **Tools → Search Semantic Scholar…** (or **Open search window** in settings). The window uses your API key and the same request queue as agents. It works even when the agent server is switched off.

**Modes**

- **Simple:** type keywords or a title. Paste a DOI, arXiv id, `CorpusId:…`, `PMID:…`, S2 id or a doi.org/arxiv.org link and the window looks up that paper instead. Semantic Scholar's relevance search matches nothing for hyphenated words, so hyphens become spaces (a note says so).
- **Advanced:** relevance search with filters: year range or exact dates, venues, fields of study, publication types, minimum citations and open-access PDF only. Relevance search stops at 1,000 results.
- **Boolean:** S2's bulk search, with sorting by citations or date, up to 1,000 papers per page and **Load more** for the next page. Syntax: `+must` `-not` `a | b` `"exact phrase"` `prefix*` `( grouping )` `word~2` `"a b"~3`, for example `((cloud computing) | virtualization) +security -privacy`.
- **Authors:** find an author, then click them to list their papers.

**Results** show as a **table with a detail pane** (sortable columns; Ctrl/Cmd-click and Shift-click to select several) or as **cards** with abstracts. Choose in the window or in settings. Papers already in the target library get a ✓. From any paper you can open its **Citations**, **References** or **Similar papers**. A breadcrumb and **Back** return to where you were without new requests.

**Adding.** Pick a library and collection (it starts on the collection selected in Zotero's main window), or choose **New collection…** and type a path like `Reading/2026`. Optional: tags, the metadata source (S2, or Zotero's DOI/arXiv translators) and **Attach PDF**. Up to 25 papers per add, the same limit agents have. Papers already in your library are reused, not duplicated.

**Export** the selected papers, or all loaded ones if none are selected, as BibTeX (copy or save), RIS or CSV. **Recent** reruns one of your last 20 searches, and the window reopens with your last search and options. Its calls show up in the activity table as `gui`.

## Tools

| Tool                                                                                    | What it does                                                                                                                                              |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `s2_search_papers`                                                                      | Relevance search with year/date, field, type, venue, citation and open-access filters                                                                     |
| `s2_search_papers_bulk`                                                                 | Boolean bulk search with sort and a continuation token                                                                                                    |
| `s2_match_title`                                                                        | Best match for a title                                                                                                                                    |
| `s2_get_papers`                                                                         | Details for 1–500 ids in one request: S2 id, `DOI:`, `ARXIV:`, `CorpusId:`, `PMID:`, `PMCID:`, `URL:`, a bare DOI or arXiv id, or a doi.org/arxiv.org URL |
| `s2_get_citations` / `s2_get_references`                                                | The citation graph, optionally with citation contexts and intents                                                                                         |
| `s2_recommend`                                                                          | Recommendations from one paper, or from lists of positive and negative examples                                                                           |
| `s2_search_authors` / `s2_get_author_papers`                                            | Authors and their papers                                                                                                                                  |
| `s2_snippet_search`                                                                     | Search text passages inside papers, to find who states a claim or uses a method                                                                           |
| `zotero_list_collections` / `zotero_create_collection` / `zotero_list_collection_items` | Library structure                                                                                                                                         |
| `zotero_find_in_library`                                                                | Which papers are already in Zotero, plus their collections and PDF status                                                                                 |
| `zotero_add_papers`                                                                     | Add up to 25 papers to a collection, with PDFs, tags and a note. Metadata comes from S2 or from Zotero's DOI/arXiv translators                            |
| `zotero_attach_pdf`                                                                     | Find and attach PDFs for up to 25 existing items                                                                                                          |
| `zotero_add_pdf_from_url`                                                               | Download a PDF, from a direct link or an article page, and attach it to an item, or save it standalone and let Zotero recognize its metadata              |
| `zotero_add_pdf_file`                                                                   | Import a PDF the agent already has (an absolute path on this computer, or base64 bytes, up to 50 MB) onto an item or standalone                           |
| `zotero_enrich_items`                                                                   | Fill missing metadata on up to 25 existing items from S2; items without ids need an exact title (and no conflicting year)                                 |

Every call appears in the **Activity** table in settings, with its duration, number of S2 requests, retries and any error.

## REST interface

Every path lives on Zotero's local server (`127.0.0.1:23119` by default), and every request needs `Authorization: Bearer <token>`.

- `GET /s2/tools` lists the tools with their JSON Schemas.
- `POST /s2/tools/<name>` takes the tool's arguments as a JSON body and returns its JSON result. Errors come back as `400 {"error": …}`, and unknown tools as `404`.

```sh
curl -s -X POST http://127.0.0.1:23119/s2/tools/zotero_add_papers \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"ids":["ARXIV:1706.03762","DOI:10.1038/nature14539"],"collection":"Agent/Inbox"}'
```

## Rate limits

Semantic Scholar allows an API key 1 request per second. Every caller shares one queue that starts requests at least 1050 ms apart, so batch tools are much faster than many small calls. `s2_get_papers` takes up to 500 ids in a single request.

Failed requests (429, 5xx and network errors) are retried up to 6 times with exponential backoff: 1 s, 2 s, 4 s … capped at 60 s, plus up to 500 ms of jitter. If the server sends `Retry-After`, the plugin waits that long instead, up to 60 s; if it asks for longer, the call fails at once with a message saying how long to wait. Retries go back through the same queue. A 429 pauses the whole queue, not just the request that received it.

## Privacy and security

- The endpoints answer only on Zotero's local server, which accepts `Host: 127.0.0.1`, `localhost` or `[::1]`.
- Every request needs the bearer token. You can regenerate it in settings, which disconnects existing clients.
- Requests that carry an `Origin` header, which is to say requests made from web pages, get `403`. Browser-based MCP clients therefore can't connect directly. MCP Inspector works in proxy mode.
- Your API key and the token are stored in plain text in Zotero's preferences, inside your Zotero profile.
- When Zotero's debug output is enabled, it logs request headers, including the bearer token. Don't share debug logs without removing it.

What leaves your machine:

- Requests to `api.semanticscholar.org`, with your API key.
- PDF downloads from the open-access URL that S2 reports and from arXiv. After those, Zotero's own "Find Available PDF" resolvers run, the same ones Zotero uses when you click it: the DOI landing page, the item's URL, and Zotero's open-access lookup service.
- `zotero_add_pdf_from_url` downloads the URL it's given; for an article page, it follows the page's PDF link. With `recognize` on (the default), Zotero's metadata recognizer sends text from the PDF to Zotero's recognition service, just as **Retrieve Metadata for PDF** does.
- `zotero_add_pdf_file` reads only the `.pdf` file it's given (it must start with `%PDF-`), and stores a copy in Zotero. The copy syncs like any attachment, and the original file is never moved or deleted. Standalone imports are recognized the same way as above.
- With `metadata_source: "translator"`, the DOI or arXiv lookups that Zotero's translators perform.

The plugin itself contacts nothing else, and it collects no telemetry. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Troubleshooting

| Symptom                                    | Fix                                                                                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection refused                         | Zotero isn't running, or the client uses the wrong port. The settings pane shows the actual endpoint.                                              |
| `401`                                      | The token is missing or stale. Copy it again from settings, especially after clicking **Regenerate**.                                              |
| `403 Origin not allowed`                   | The client runs in a browser. Use a desktop or CLI client, or a proxy.                                                                             |
| `503`                                      | **Enable the MCP / REST server** is unchecked in settings.                                                                                         |
| "No Semantic Scholar API key set"          | Paste a key in settings and click **Test**. `zotero_find_in_library` still works without a key, matching only on the ids you give it.              |
| Slow calls, or retries in the Activity log | Another program may be using the same API key, or S2 is busy. The plugin backs off on its own. Prefer batch tools, which use one request per call. |

## Development

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, tests and the release process.

## License

Copyright (C) 2026 Ding Zheng Yuan. Licensed under [AGPL-3.0-or-later](LICENSE). Built on [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template).

This is an independent project. It is not affiliated with or endorsed by Semantic Scholar, the Allen Institute for AI, Zotero, or the Corporation for Digital Scholarship.
