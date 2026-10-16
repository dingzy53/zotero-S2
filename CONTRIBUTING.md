# Contributing

Thanks for helping. Bug reports should include your Zotero version, the plugin version, the tool call (arguments are listed in the **Activity** table in settings), and what you expected to happen.

Coding agents: read [AGENTS.md](AGENTS.md) first. It lists the invariants (S2 rate limits, MCP behavior, Zotero data rules) that changes must keep true.

## Setup

You need Node.js (current LTS) and a Zotero 10 binary that is **not** your everyday installation's profile or data directory.

```sh
npm install
cp .env.example .env   # set ZOTERO_PLUGIN_ZOTERO_BIN_PATH, plus a dev profile and data dir
```

On Linux, unpack the [official tarball](https://www.zotero.org/download/client/dl?channel=release&platform=linux-x86_64) anywhere outside the repo.

## Commands

```sh
npm start            # dev Zotero with hot reload (uses .env)
npm run build        # .scaffold/build/zotero-s2.xpi, then tsc --noEmit
npm run lint:check   # prettier + eslint (lint:fix to apply)
npm test             # mocha inside a real Zotero, in watch mode
npx zotero-plugin test --no-watch --exit-on-finish   # one CI-style run
```

Before opening a pull request, run `npm run build`, `npm run lint:check` and the CI-style test run. All three must pass.

## Tests

The tests run inside a real Zotero 10 with a fresh profile and data directory on every run. The test profile sets its local server to port 23129 and its token to `test-token`, so a running everyday Zotero on 23119 is unaffected.

- Unit tests stay offline. S2 responses come from `test/fixtures.ts` through `fixtureClient()` in `test/helpers.ts`.
- `test/http.test.ts` sends real requests through Zotero's server: auth, Origin rejection, MCP in both protocol eras, and the REST mirror.
- To poke at a running test instance, keep `npm test` open and `curl http://127.0.0.1:23129/s2/...` with `Authorization: Bearer test-token`.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:` …). The release notes are generated from them.

## Releasing

1. On an up-to-date `main` with a clean tree, run `npm run release`. It prompts for the new version, then commits `chore(publish): release vX.Y.Z`, tags it and pushes.
2. The tag push runs `.github/workflows/release.yml`. That workflow builds the `.xpi`, creates the GitHub release with generated notes, and updates `update.json` under the `release` tag. Installed copies poll that file for updates.

Versions with a prerelease suffix (`1.2.0-beta.1`) go to `update-beta.json` instead, so only beta testers receive them.

The addon ID (`zotero-s2@dingzy53.github.io`) and the repository must never change after a release. Installed copies identify the plugin by that ID and find updates through the repository's release URL.

## Supporting a new Zotero version

1. Test against the new version: point `.env` at it and run the suite.
2. Raise `strict_max_version` in `addon/manifest.json`.
3. Update `ZOTERO_VERSION` in `.github/workflows/ci.yml`.

If the current release already works unchanged, Zotero also accepts a raised `strict_max_version` in the update manifest without a new release. Edit `update.json` in the `release` tag's assets. The next `npm run release` regenerates that file from the manifest, so make the same change there too.
