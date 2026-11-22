# PLAN: 2026-11-21 retest findings (zotero-S2)

Branch: `fix/bibtex-article-booktitle` (from `main` @ `8857d08`, after PR #3).
Source: the 2026-11-21 retest.

PR #3 passed the retest:

- The Zotero suite: 179 passed.
- `@inproceedings` for Vaswani 2017.
- A DOI on every entry.

`biber --tool --validate-datamodel` still warns 4 times, so two problems are left.

## Status

- [x] 1. Drop `booktitle` from `@Article` entries that also have `journal`
- [x] 2. Fix arXiv `volume = {abs/…}`

---

## 1. `@Article` entries that have both `journal` and `booktitle`

**Seen:** biber warns about `booktitle` on 3 `@Article` entries: journal papers and arXiv preprints. Semantic Scholar's BibTeX often has **both** fields, for example:

```bibtex
@Article{X,
  booktitle = {arXiv.org},
  journal = {ArXiv},
  volume = {abs/2604.21816},
}
```

**Code:** `src/gui/export.ts:93-113` (`normalizeBibtexEntry`). It only acts when `booktitle` is present **and `journal` is missing**, so entries with both fields pass through unchanged.

**Fix:** for `@article` (any case) with both `journal =` and `booktitle =`:

- If S2 says `Conference` and not `JournalArticle`, rewrite the entry to `@inproceedings`, keep `booktitle` and drop `journal`. Confirm against real S2 output in tests or fixtures.
- Otherwise remove the `booktitle = {…}` field line.
  - Match a braced value with nested braces, or a quoted value, and the trailing comma.
  - Don't break the next field.
  - Write a small field-removal helper rather than a one-off regex, and test it on multi-line values.

---

## 2. arXiv `volume = {abs/2604.21816}`

**Seen:** biber warns that `volume` is not an integer. S2 encodes arXiv ids as `journal = {ArXiv}, volume = {abs/<id>}`.

**Fix:** in `normalizeBibtexEntry`, when `volume` matches `^abs/(.+)$`:

- Remove `volume`.
- Add `eprint = {<id>}` and `archivePrefix = {arXiv}` if they are missing. `bibtexFromPaper` already writes these for built entries, so reuse that code.
- Prefer `paper.externalIds.ArXiv` as the id when it is present.
- Keep `journal = {ArXiv}`, which biber accepts. Keep `doi` handling as it is: arXiv DOIs look like `10.48550/arXiv.<id>`.

**Tests:** extend `test/gui.export.test.ts` with:

- an arXiv entry: no `volume`, has `eprint` and `archivePrefix`;
- a journal entry with both fields: `booktitle` dropped;
- a conference entry with both fields: becomes `@inproceedings`;
- an entry with neither field: unchanged.

Use realistic S2 output. If possible, add a script check that runs `biber --tool --validate-datamodel` on a generated `.bib`, but only if biber is installed. Skip it otherwise; don't add biber as a dependency.

---

## Verification

- `npm ci && npx prettier --write . && npm run lint:check && npm run build`.
- `node --test bridge/bridge.test.mjs`.
- Run `test/gui.export.test.ts` outside Zotero: bundle it with esbuild and run plain mocha, as the previous agent did.
- **Run the Zotero-hosted suite** (`npx zotero-plugin test --no-watch --exit-on-finish`) if the environment allows launching Zotero. If it is blocked, say so in the PR; the owner runs it on the Mac.
- Run the Zotero suite from a short path. In a very long scratch path, 8 file-import tests fail with `NS_ERROR_FILE_UNRECOGNIZED_PATH`, which is an environment problem, not the code.

## Commits

1. `fix(export): drop booktitle from S2 @Article entries that have a journal`
2. `fix(export): turn S2 arXiv volume into eprint fields`
3. `docs(plan): mark retest fixes done`. Run `npx prettier --write PLAN.md`: PLAN.md is tracked and CI runs `prettier --check`.
