# Security policy

Zotero S2 opens HTTP endpoints on Zotero's local server that can read your library, change it, and spend your Semantic Scholar API quota. Security reports are taken seriously.

## Reporting a vulnerability

Please report privately through [GitHub's vulnerability reporting](https://github.com/dingzy53/zotero-S2/security/advisories/new) rather than in a public issue. Include the plugin and Zotero versions and the steps to reproduce.

Relevant examples include:

- reaching the endpoints from a web page, another host, or without the bearer token;
- leaking the token or the S2 API key;
- a tool writing outside the library or collection it was given.

## Supported versions

Only the latest release receives fixes.

## Design notes

- Zotero's server accepts only loopback `Host` headers.
- The plugin rejects any request with an `Origin` header (403) and requires a 256-bit bearer token, compared in constant time.
- The token and API key are stored in plain text in Zotero's preferences, in your Zotero profile.
