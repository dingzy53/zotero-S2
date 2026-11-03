# PLAN: let agents add PDF files

> Branch `feat/pdf-file`.

## Status (2026-11-03)

Implemented on `feat/pdf-file`. `npm run build`, `npm run lint:check` and the Zotero test run pass: the suite went from 123 to 134 tests. All Zotero APIs used were checked against Zotero 10.0.7's source (`attachments.js`, `utilities_internal.js`, `item.js`).

Where the build differs from this plan:

- **URL onto a parent item:** this still uses `addFileFromURLs(parent, [{ pageURL }])` rather than downloading to a temp file and calling `importPDFFile`. Zotero then names the file and records the source URL exactly as "Find Available PDF" does. The cost is that a URL attach isn't MD5-deduped against existing PDFs.
- **Standalone URL downloads** are named after the PDF's URL leaf when it ends in `.pdf`.
- **`filename`** (base64 only) sets the stored file name of a standalone upload.
- The `idempotentHint` assertion lives in `test/zotero.test.ts` ("tool annotations"), since `mcp.test.ts` uses fake tools.

Still to check by hand: the manual steps under Verification. They need the network, which the offline tests stub out, especially to confirm that real landing pages such as arxiv.org/abs/… resolve through `pageURL`.

## Context

Agents report that they "cannot add the PDF" when a paper's PDF isn't on S2 or arXiv. Reading the code and Zotero's `attachments.js` (main branch) turns up two gaps.

**A. The URL paths are fragile and say little when they fail**

| Path                                             | Today                                             | Problem                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `zotero_add_pdf_from_url` with `parent_item_key` | `addFileFromURLs(parent, [{ url }])`              | A `{url}` resolver is downloaded as-is. A DOI or publisher **landing page** returns HTML, the type check rejects it, and the agent gets "URL did not return a PDF". Zotero's `{pageURL}` resolver would follow the page to its PDF link (`getFileFromDocument`, meta refresh, bot-challenge handling), but we never use it. |
| `zotero_add_pdf_from_url` standalone             | `importFromURL({contentType: "application/pdf"})` | It has the same landing-page failure. `InvalidPDFException` isn't a `ToolError`, so the agent gets a raw internal message and the activity log reports it as a bug.                                                                                                                                                         |
| `zotero_add_papers` / `zotero_attach_pdf`        | `attachPDF()` → `"not_found"`                     | The result doesn't say what the agent could try next.                                                                                                                                                                                                                                                                       |
| MCP `INSTRUCTIONS` (`src/http/endpoints.ts`)     | Doesn't mention PDFs                              | Agents don't know the URL tool exists, or what to do when it fails.                                                                                                                                                                                                                                                         |

**B. Agents can't hand over a PDF they already have.** It may be a file the agent downloaded with its own browser or session (paywalled or behind a bot check), or a file the user saved. There is no tool for this today.

**Decisions (confirmed with the owner)**

- Fix both A and B.
- New tool `zotero_add_pdf_file`. It takes **either** `path`, an absolute path on the Zotero machine, **or** `content_base64`, for remote or sandboxed agents.
- **Stored copy** (`importFromFile`), never linked files.
- Safety is **PDF-only checks**: the token already gates access. No allowed-folders pref.
- Targets match the URL tool: attach to `parent_item_key`, or save standalone (optionally into a collection) and let Zotero's recognizer create the parent item.

## Zotero facts this design relies on

All of these come from `chrome/content/zotero/xpcom/attachments.js` and `server/server.js` on Zotero main. **Check each signature against the source while implementing** and record it in the `apis.ts` shim.

- `Attachments.importFromFile({ file, libraryID?, parentItemID?, collections?, title?, fileBaseName?, contentType?, moveFile? })` → `Promise<Zotero.Item>`.
  - `parentItemID` and `collections` together **throw**.
  - `parentItemID` wins over `libraryID`.
  - Without `fileBaseName` the stored name is the sanitized source leaf name. `moveFile: true` moves the file instead of copying it.
  - It does **not** sniff the content, so we check the `%PDF-` magic ourselves.
- `Attachments.downloadFirstAvailableFile(resolvers, path, { enforceFileType: true, ... })` → `{ url, props } | false`.
  - A `{pageURL}` resolver fetches the URL. A PDF response is saved directly. An HTML response is parsed for the PDF link (`getFileFromDocument`), with up to 10 redirects and bot-challenge handling.
  - Errors for each resolver are logged and skipped, and the call returns `false` when nothing worked.
- `Attachments.getFileBaseNameFromItem(item)` names files the way Zotero's own "Find Available PDF" does. `addFileFromURLs` uses it internally.
- `Zotero.Server`:
  - It has **no body-size cap**: it reads `Content-Length`.
  - A JSON body is read as text and then `JSON.parse`d. So `content_base64` is fine over both MCP and REST; we set our own cap.
- Plugin sandbox: `IOUtils` (`stat`, `read` with `maxBytes`, `write`, `remove`), `PathUtils` (`join`, `tempDir`, `filename`, `isAbsolute`) and `atob` are all available (AGENTS.md).
- `Zotero.Utilities.Internal.md5Async(path)` and `attachment.attachmentHash` give a stored file's MD5. We use them to avoid attaching the same file twice.

## Design

### 1. `src/zotero/pdf.ts`: the single home for every PDF write

AGENTS.md says that `pdf.ts` is "the only place PDFs are attached". The new code and the URL tool's logic both move here, so `tools.ts` only validates arguments and shapes results.

```ts
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

export type PdfTarget =
  | { parent: Zotero.Item }
  | { libraryID: number; collection?: Zotero.Collection; recognize: boolean };

/** Local or decoded file → stored attachment. Never deletes `path` unless `ownTemp`. */
export async function importPDFFile(
  path: string,
  target: PdfTarget,
  opts: { title?: string; ownTemp?: boolean },
): Promise<ImportResult>;

/** URL (direct PDF or landing page) → temp file → importPDFFile. */
export async function importPDFFromURL(
  url: string,
  target: PdfTarget,
): Promise<ImportResult>;

export async function checkPDFFile(path: string): Promise<number /* size */>;
export async function writeTempPDF(base64: string): Promise<string /* path */>;
```

`ImportResult = { attachmentKey, status: "attached" | "already", recognized?, parent?, collection? }`, built with the existing `describeItem` / `describeCollection`.

- **`checkPDFFile(path)`** throws `ToolError` with an actionable message when:
  - the path isn't absolute (`PathUtils.isAbsolute`);
  - the file doesn't exist, or `IOUtils.stat(path).type !== "regular"`;
  - the name doesn't end in `.pdf` (case-insensitive);
  - the size is 0 or larger than `MAX_PDF_BYTES`;
  - the first 5 bytes (`IOUtils.read(path, { maxBytes: 5 })`) aren't `%PDF-`.

  The message names the problem and never echoes the file's contents.

- **`writeTempPDF(b64)`**:
  - removes whitespace and an optional `data:application/pdf;base64,` prefix;
  - rejects the input if the decoded size estimate (`len * 3 / 4`) is over the cap, _before_ `atob`;
  - decodes into a `Uint8Array` and checks the `%PDF-` magic;
  - writes to `PathUtils.join(PathUtils.tempDir, "zotero-s2-<random hex>.pdf")`.

  Malformed base64 makes `atob` throw, which becomes `ToolError("content_base64 is not valid base64")`.

- **`importPDFFile`** runs `checkPDFFile` and then branches on the target.
  - **Parent target:**
    - Serialize on the parent with the same `inFlight`-style map `attachPDF` uses, keyed by the parent id. Two parallel calls for one parent must not race the hash check.
    - **Dedupe:** if any existing PDF child's `attachmentHash` equals `md5Async(path)`, return `{ status: "already", attachmentKey }`. This keeps a retry from adding a second copy of the same file. A _different_ PDF is still added; agents may attach a supplement or preprint on purpose.
    - Otherwise call `importFromFile({ file: path, parentItemID, fileBaseName: getFileBaseNameFromItem(parent), contentType: "application/pdf", title, moveFile: ownTemp })`.
  - **Standalone target:**
    - Call `importFromFile({ file, libraryID, collections: collection ? [collection.id] : undefined, contentType, title, moveFile: ownTemp })`.
    - Then run the existing recognize block, moved here unchanged from `tools.ts`: `canRecognize` → `recognizeItems` → re-read `parentItemID`, with a recognize failure only `Zotero.debug`'d.
  - `finally`: if `ownTemp` and the file still exists (the import failed or the move didn't happen), call `IOUtils.remove(path, { ignoreAbsent: true })`. The user's own `path` file is **never** moved or deleted.
- **`importPDFFromURL`**:
  - Allow only `http(s)`. Hold a `downloads` semaphore slot, the same `Semaphore(2)` `attachPDF` uses.
  - Call `downloadFirstAvailableFile([{ pageURL: url, accessMethod: "agent URL" }], tmp, { enforceFileType: true })`. One `pageURL` resolver covers both a direct PDF and a landing page.
  - If it returns `false`, throw `ToolError`: "Could not get a PDF from that URL (it may be paywalled, need a login, or block automated downloads). If you can download the file yourself, pass it to zotero_add_pdf_file."
  - On success: `importPDFFile(tmp, target, { ownTemp: true })`.
- `attachPDF()` doesn't change, except that it keeps sharing the `downloads` semaphore.

**Write lock:** `importFromFile` creates one attachment item, and there is no find-or-create of items or collections inside these functions. So, like `attachPDF`, they stay **outside** `libraryWrites`. `resolveCollection()` already takes the lock itself. The per-parent `inFlight` map covers the only race.

### 2. `src/zotero/apis.ts`: shims

Add `importFromFile`, `downloadFirstAvailableFile` and `getFileBaseNameFromItem` to `AttachmentsAPI`. Add `md5Async` through a small `UtilitiesInternal()` accessor. Each shim gets a source-path comment, following the existing pattern. Drop `importFromURL` from the shim if nothing uses it any more.

### 3. `src/mcp/tools.ts`

**New tool, `zotero_add_pdf_file`**, appended after `zotero_add_pdf_from_url`:

```ts
{
  name: "zotero_add_pdf_file",
  title: "Add a PDF file",
  description:
    "Import a PDF you already have into Zotero (stored copy). Give either `path` (absolute path on the computer running Zotero) or `content_base64` (the file's bytes, for agents on another machine; max 50 MB). With parent_item_key it is attached to that item (the same file twice is not duplicated); otherwise it is saved standalone, optionally into a collection, and Zotero's metadata recognizer creates a parent item. Use this when zotero_add_pdf_from_url or zotero_attach_pdf can't fetch a paywalled or bot-protected PDF but you can.",
  inputSchema: { type: "object", properties: {
    path: { type: "string" },
    content_base64: { type: "string" },
    filename: { type: "string", description: "Name for a base64 upload's title, e.g. paper.pdf" },
    title: { type: "string", description: "Attachment title (default: Zotero's)" },
    parent_item_key: { type: "string" },
    collection: collectionRef,
    create_collection: { type: "boolean", default: true },
    recognize: { type: "boolean", default: true },
    library_id: libraryID,
  } },
  annotations: { readOnlyHint: false, destructiveHint: false,
                 idempotentHint: false, openWorldHint: false },
}
```

- The handler checks that **exactly one** of `path` / `content_base64` is given, and throws a `ToolError` otherwise. The existing schema helper has no `oneOf`, so this check stays in the handler.
- `parent_item_key` together with `collection` → `ToolError`: an attachment's collections come from its parent, and Zotero throws on the combination. The URL tool gets the same check.
- `idempotentHint: false`, because a standalone import makes a new item each time. Only a parent attach is deduped.
- `openWorldHint: false`: no network, apart from the recognizer when `recognize` is on, which the description states.

**`zotero_add_pdf_from_url`**: the handler becomes `importPDFFromURL(url, target)`. The input schema and output keys stay the same: `attachmentKey`, `recognized`, `parent`, `collection`. It adds `status`. The description gains "Works with direct PDF links and with article landing pages."

**`zotero_attach_pdf` / `zotero_add_papers`**: when any result is `"not_found"`, add a top-level `hint`: "No open copy was found. If you can obtain the PDF, use zotero_add_pdf_from_url (URL) or zotero_add_pdf_file (file)." The per-row `pdf` values don't change, so the shape stays compatible.

### 4. `src/http/endpoints.ts`

Add one sentence to `INSTRUCTIONS`: "PDFs: zotero_add_papers/zotero_attach_pdf find open-access copies; for anything else, give zotero_add_pdf_from_url a PDF or landing-page URL, or give zotero_add_pdf_file a local path or base64 bytes."

There are no new endpoints or status codes, and auth doesn't change.

### 5. `src/log/activity.ts`

`summarizeArgs` currently runs `JSON.stringify` on a multi-MB base64 argument before cutting it to 160 characters. Change it to use a replacer that shortens any string over 200 characters to `"<N chars>"`. That keeps the activity log cheap, and stops PDF bytes from reaching `Zotero.debug`.

### 6. Docs

- **README:** add a row for `zotero_add_pdf_file` to the tools table, and a privacy note that the file is copied into Zotero storage and syncs like any attachment. Note that the URL tool accepts landing pages.
- **AGENTS.md:**
  - Layout: `pdf.ts` now holds every PDF write (URL, file, find-available).
  - Invariants:
    - file input must pass `checkPDFFile` (absolute, regular, `.pdf`, size cap, `%PDF-`);
    - temp files are always removed, and a user `path` is never moved or deleted;
    - a parent attach is deduped by MD5;
    - `MAX_PDF_BYTES` applies to both inputs.

## Tests (offline, real Zotero)

New `describe` blocks in `test/zotero.test.ts`:

- **Fixtures:** a tiny valid PDF written at test time (`%PDF-1.4` with a minimal body) to `PathUtils.tempDir`, a `.pdf` file with HTML content, and a `.txt` file.
- **Path import with a parent:** the item gains a PDF child, `status: "attached"`, and the file name comes from `getFileBaseNameFromItem`. The **source file still exists** afterwards.
- **The same file again:** `status: "already"` and still one child. A different valid PDF → a second child.
- **Two parallel calls for the same parent and file:** one child.
- **Base64 standalone into `PDF/Test`:**
  - the attachment is in that collection;
  - no `zotero-s2-*.pdf` is left in `tempDir`;
  - `recognize: false`, so the test stays offline.
- **Rejections, each a `ToolError` with `ok: false`:**
  - a relative path;
  - a missing file;
  - a directory;
  - a `.txt` file;
  - HTML renamed to `.pdf`;
  - a zero-byte file;
  - base64 over the cap (stub `MAX_PDF_BYTES`, or use a size estimate test);
  - invalid base64;
  - both `path` and `content_base64`;
  - neither of them;
  - `parent_item_key` together with `collection`.
- **URL tool:**
  - Stub `Attachments.downloadFirstAvailableFile`, the same way the existing `zotero_attach_pdf` test stubs `addFileFromURLs`, so it writes the fixture PDF to the given path.
  - Assert it was called with a `pageURL` resolver, and that the item gets the PDF.
  - A stub that returns `false` gives a `ToolError` whose message mentions `zotero_add_pdf_file`.
- **Hints:** `zotero_attach_pdf` with the stub returning `false` → `hint` is present.
- **Activity log:** after a base64 call, the stored `args` holds `"<N chars>"`, not the bytes.
- **`test/http.test.ts`:** a real REST `POST /s2/tools/zotero_add_pdf_file` with a small base64 body returns 200 over Zotero's server. This proves the JSON body path works end to end.
- **`test/mcp.test.ts`:** `tools/list` includes the new tool with `destructiveHint: false`, `idempotentHint: false` and `additionalProperties: false`.
- Delete every item the tests create, following the GUI-test cleanup rule.

## Implementation order (one commit each; build, lint and tests green each time)

1. Shims in `apis.ts`, and the `pdf.ts` helpers (`checkPDFFile`, `writeTempPDF`, `importPDFFile`), with tests.
2. The `zotero_add_pdf_file` tool, the activity-log redaction, and the tool, schema and HTTP tests.
3. `importPDFFromURL` and the move of `zotero_add_pdf_from_url` onto it (the `pageURL` landing-page support and the `ToolError` messages), with tests.
4. The `not_found` hints and the `INSTRUCTIONS` sentence.
5. README and AGENTS.md. `npm run lint:fix`.

## Verification

- At each step: `npm run build`, `npm run lint:check`, `npx zotero-plugin test --no-watch --exit-on-finish`.
- **Manual, against a watch-mode test Zotero on port 23129** (never the everyday profile):
  1. `curl -s -X POST http://127.0.0.1:23129/s2/tools/zotero_add_pdf_file -H "Authorization: Bearer test-token" -H "Content-Type: application/json" -d '{"path":"/abs/path/paper.pdf","collection":"PDF/Manual"}'`. The PDF appears in the collection, and the recognizer creates a parent (this needs the network).
  2. The same call with `content_base64` set to `$(base64 -w0 paper.pdf)`, through a here-doc JSON file. The temp directory has no leftovers afterwards.
  3. `zotero_add_pdf_from_url` with a landing page, e.g. `https://arxiv.org/abs/1706.03762`. It is attached through `pageURL`.
  4. A paywalled DOI landing page returns the clear `ToolError` pointing to the file tool.
  5. Real MCP client:
     - Register it: `claude mcp add --scope local --transport http zs2-test http://127.0.0.1:23129/s2/mcp --header "Authorization: Bearer test-token"`.
     - Ask: "Download <some PDF> to /tmp and add it to Zotero under PDF/Agent". Check that the agent picks `zotero_add_pdf_file` by itself.
     - Remove it afterwards with `claude mcp remove zs2-test -s local`.
