# Zotero S2

[![CI](https://github.com/dingzy53/zotero-S2/actions/workflows/ci.yml/badge.svg)](https://github.com/dingzy53/zotero-S2/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/dingzy53/zotero-S2)](https://github.com/dingzy53/zotero-S2/releases/latest)
[![Zotero 10](https://img.shields.io/badge/Zotero-10-cc2936)](https://www.zotero.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A Zotero 10 plugin that lets AI agents search [Semantic Scholar](https://www.semanticscholar.org/product/api) and file papers, with PDFs, into your Zotero collections.

The plugin serves an **MCP endpoint from inside Zotero**, on Zotero's own local server, so there is no separate process to run. The same tools are also available as plain REST endpoints for scripts and `curl`.

- **Search and explore:** relevance and boolean search, title matching, full-text snippets, citations and references, recommendations, authors.
- **File papers:** add up to 25 papers per call to a collection, given by key or by slash path (`Project/Reading`). Missing collections are created. Papers already in your library are matched by DOI, arXiv id, S2 id or title + year, then reused rather than duplicated.
- **Attach PDFs:** sources are tried in order: the S2 open-access PDF, then arXiv, then Zotero's own "Find Available PDF" resolvers. Zotero rejects anything that isn't really a PDF.
- **Fill in metadata:** enrich existing items with abstracts, dates, venues, DOIs and authors from Semantic Scholar.
- **Polite to Semantic Scholar:** keyed requests only, at most 1 per second across all callers, with exponential backoff.

## Requirements

- [Zotero 10](https://www.zotero.org/download/).
- A Semantic Scholar API key. It's free: [request one here](https://www.semanticscholar.org/product/api#api-key-form). The plugin never sends unkeyed requests.

## Install

1. Download `zotero-s2.xpi` from the [latest release](https://github.com/dingzy53/zotero-S2/releases/latest).
2. In Zotero, open **Tools → Plugins**, click the gear icon, choose **Install Plugin From File…** and pick the downloaded file.
3. Open **Zotero → Settings → Zotero S2**. Paste your API key and click **Test**.
4. Connect your agent (below).

Zotero checks for plugin updates automatically.

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
| `zotero_add_pdf_from_url`                                                               | Download a PDF and attach it to an item, or save it standalone and let Zotero recognize its metadata                                                      |
| `zotero_enrich_items`                                                                   | Fill missing metadata on up to 25 existing items from S2                                                                                                  |

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

Failed requests (429, 5xx and network errors) are retried up to 6 times with exponential backoff: 1 s, 2 s, 4 s … capped at 60 s, plus up to 500 ms of jitter, or longer if the server sends `Retry-After`. Retries go back through the same queue. A 429 pauses the whole queue, not just the request that received it.

## Security and privacy

- The endpoints answer only on Zotero's local server, which accepts `Host: 127.0.0.1`, `localhost` or `[::1]`.
- Every request needs the bearer token. You can regenerate it in settings, which disconnects existing clients.
- Requests that carry an `Origin` header, which is to say requests made from web pages, get `403`. Browser-based MCP clients therefore can't connect directly. MCP Inspector works in proxy mode.
- Your API key and the token are stored in plain text in Zotero's preferences, inside your Zotero profile.
- When Zotero's debug output is enabled, it logs request headers, including the bearer token. Don't share debug logs without removing it.

What leaves your machine:

- Requests to `api.semanticscholar.org`, with your API key.
- PDF downloads from the open-access URL that S2 reports and from arXiv. After those, Zotero's own "Find Available PDF" resolvers run, the same ones Zotero uses when you click it: the DOI landing page, the item's URL, and Zotero's open-access lookup service.
- `zotero_add_pdf_from_url` downloads the URL it's given. With `recognize` on (the default), Zotero's metadata recognizer sends text from the PDF to Zotero's recognition service, just as **Retrieve Metadata for PDF** does.
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

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, tests and the release process.

## License

[MIT](LICENSE). Built on [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template).

This is an independent project. It is not affiliated with or endorsed by Semantic Scholar, the Allen Institute for AI, Zotero, or the Corporation for Digital Scholarship.
