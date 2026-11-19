import { Semaphore } from "../s2/rateLimiter";
import { S2Paper } from "../s2/types";
import { ToolError, errorMessage } from "../mcp/errors";
import {
  Attachments,
  DownloadOptions,
  RecognizeDocument,
  UrlResolver,
  UtilitiesInternal,
} from "./apis";
import { describeCollection } from "./collections";
import { describeItem, hasPDF, itemArxiv } from "./dedupe";

export type PdfStatus =
  "attached" | "already" | "not_found" | "pending" | `failed: ${string}`;

/** PDF hosts aren't S2, so they skip the S2 limiter but stay polite. */
const downloads = new Semaphore(2);

/** One attempt per item at a time; two ids for one paper must not attach twice. */
const inFlight = new Map<number, Promise<PdfStatus>>();

/**
 * Tries, in order: S2's open-access PDF, arXiv, then Zotero's own
 * "Find Available PDF" resolvers (DOI landing page, URL, Unpaywall).
 * Zotero checks the file really is a PDF before keeping it.
 */
export function attachPDF(
  item: Zotero.Item,
  paper?: S2Paper | null,
): Promise<PdfStatus> {
  const pending = inFlight.get(item.id);
  if (pending) return pending;
  const attempt = attachOnce(item, paper).finally(() =>
    inFlight.delete(item.id),
  );
  inFlight.set(item.id, attempt);
  return attempt;
}

/**
 * `attachPDF()`, but answers `"pending"` at `deadline` (epoch ms). The
 * download carries on in the background; a later call for the same item joins
 * it through `inFlight`, or finds the PDF, so nothing is downloaded twice.
 */
export function attachPDFBy(
  deadline: number,
  item: Zotero.Item,
  paper?: S2Paper | null,
): Promise<PdfStatus> {
  const attempt = attachPDF(item, paper);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PdfStatus>((resolve) => {
    timer = setTimeout(
      () => resolve("pending"),
      Math.max(0, deadline - Date.now()),
    );
  });
  return Promise.race([attempt, timeout]).finally(() => clearTimeout(timer));
}

async function attachOnce(
  item: Zotero.Item,
  paper?: S2Paper | null,
): Promise<PdfStatus> {
  try {
    if (hasPDF(item)) return "already";

    const resolvers: UrlResolver[] = [];
    const oaURL = paper?.openAccessPdf?.url;
    if (oaURL) resolvers.push({ url: oaURL, accessMethod: "Semantic Scholar" });
    const arxiv = paper?.externalIds?.ArXiv || itemArxiv(item);
    if (arxiv) {
      resolvers.push({
        url: `https://arxiv.org/pdf/${arxiv}`,
        accessMethod: "arXiv",
      });
    }
    resolvers.push(...Attachments().getFileResolvers(item));

    const attachment = await downloads.run(async () =>
      // Something else may have attached one while we waited for a slot
      hasPDF(item) ? "already" : Attachments().addFileFromURLs(item, resolvers),
    );
    if (attachment === "already") return "already";
    return attachment ? "attached" : "not_found";
  } catch (e) {
    return `failed: ${errorMessage(e)}`;
  }
}

// ---------------------------------------------------------------------------
// PDFs handed over by agents: a local file, base64 bytes, or a URL

/** Applies to a local file, decoded base64 and a URL download alike. */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_MB = MAX_PDF_BYTES / 1024 / 1024;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

export type PdfTarget =
  | { parent: Zotero.Item }
  | {
      libraryID: number;
      collection?: Zotero.Collection | null;
      recognize: boolean;
    };

export interface ImportResult {
  status: "attached" | "already";
  attachmentKey: string;
  recognized?: boolean;
  parent: ReturnType<typeof describeItem> | null;
  collection?: ReturnType<typeof describeCollection> | null;
}

function isPDFBytes(bytes: Uint8Array): boolean {
  return PDF_MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * Accepts only a real, regular, non-empty PDF under the size cap. The token
 * already gates who can call us; this keeps a path from importing other files.
 */
export async function checkPDFFile(path: string): Promise<number> {
  if (!PathUtils.isAbsolute(path)) {
    throw new ToolError("path must be an absolute path on the Zotero computer");
  }
  let info: { type?: string; size?: number };
  try {
    info = await IOUtils.stat(path);
  } catch {
    throw new ToolError(`No file at ${path}`);
  }
  if (info.type !== "regular") throw new ToolError(`${path} is not a file`);
  if (!/\.pdf$/i.test(path)) throw new ToolError("path must end in .pdf");
  const size = info.size ?? 0;
  if (size === 0) throw new ToolError("The file is empty");
  if (size > MAX_PDF_BYTES) {
    throw new ToolError(`The file is larger than ${MAX_MB} MB`);
  }
  const head = await IOUtils.read(path, { maxBytes: PDF_MAGIC.length });
  if (!isPDFBytes(head)) {
    throw new ToolError("The file is not a PDF (it doesn't start with %PDF-)");
  }
  return size;
}

function tempPDFPath(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return PathUtils.join(PathUtils.tempDir, `zotero-s2-${hex}.pdf`);
}

/** Decodes base64 PDF bytes into a temp file, which the caller must remove. */
export async function writeTempPDF(base64: string): Promise<string> {
  const b64 = base64.replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "");
  // Check the size before decoding, so an oversized upload costs no memory
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  if (Math.floor((b64.length * 3) / 4) - padding > MAX_PDF_BYTES) {
    throw new ToolError(`content_base64 is larger than ${MAX_MB} MB`);
  }
  let binary: string;
  try {
    binary = atob(b64);
  } catch {
    throw new ToolError("content_base64 is not valid base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (!bytes.length) throw new ToolError("content_base64 is empty");
  if (!isPDFBytes(bytes)) {
    throw new ToolError("content_base64 is not a PDF (no %PDF- header)");
  }
  const path = tempPDFPath();
  await IOUtils.write(path, bytes);
  return path;
}

/** One import per parent at a time, so the duplicate check can't race. */
const parentQueue = new Map<number, Promise<unknown>>();

function serializeOnParent<T>(parentID: number, fn: () => Promise<T>) {
  const prev = parentQueue.get(parentID) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  parentQueue.set(parentID, next);
  next
    .finally(() => {
      if (parentQueue.get(parentID) === next) parentQueue.delete(parentID);
    })
    .catch(() => undefined);
  return next;
}

async function samePDFChild(
  parent: Zotero.Item,
  md5: string | false,
): Promise<Zotero.Item | null> {
  if (!md5) return null;
  for (const id of parent.getAttachments()) {
    const att = Zotero.Items.get(id) as Zotero.Item;
    if (att.isPDFAttachment() && (await att.attachmentHash) === md5) {
      return att;
    }
  }
  return null;
}

async function recognizeParent(att: Zotero.Item): Promise<Zotero.Item | null> {
  if (!RecognizeDocument().canRecognize(att)) return null;
  try {
    await RecognizeDocument().recognizeItems([att]);
    const parentID = (Zotero.Items.get(att.id) as Zotero.Item).parentItemID;
    return parentID ? (Zotero.Items.get(parentID) as Zotero.Item) : null;
  } catch (e) {
    Zotero.debug(`[Zotero S2] recognize failed: ${e}`);
    return null;
  }
}

/**
 * Stores a local PDF as an attachment (a copy; the source stays). With
 * `ownTemp` the file is our temp file: it is moved in, and removed on failure.
 */
export async function importPDFFile(
  path: string,
  target: PdfTarget,
  opts: { title?: string; fileBaseName?: string; ownTemp?: boolean } = {},
): Promise<ImportResult> {
  try {
    await checkPDFFile(path);
    const common = {
      file: path,
      contentType: "application/pdf",
      title: opts.title,
      moveFile: !!opts.ownTemp,
    };

    if ("parent" in target) {
      const { parent } = target;
      return await serializeOnParent(parent.id, async () => {
        // A retried call must not attach a second copy of the same file
        const same = await samePDFChild(
          parent,
          await UtilitiesInternal().md5Async(path),
        );
        if (same) {
          return {
            status: "already",
            attachmentKey: same.key,
            parent: describeItem(parent),
          } as const;
        }
        const att = await Attachments().importFromFile({
          ...common,
          parentItemID: parent.id,
          fileBaseName: Attachments().getFileBaseNameFromItem(parent),
        });
        return {
          status: "attached",
          attachmentKey: att.key,
          parent: describeItem(parent),
        } as const;
      });
    }

    const att = await Attachments().importFromFile({
      ...common,
      libraryID: target.libraryID,
      fileBaseName: opts.fileBaseName,
      collections: target.collection ? [target.collection.id] : undefined,
    });
    const parent = target.recognize ? await recognizeParent(att) : null;
    return {
      status: "attached",
      attachmentKey: att.key,
      recognized: !!parent,
      parent: parent ? describeItem(parent) : null,
      collection: target.collection
        ? describeCollection(target.collection)
        : null,
    };
  } finally {
    if (opts.ownTemp) await IOUtils.remove(path, { ignoreAbsent: true });
  }
}

/** A sanitized base name from the URL's last path segment, if it names a PDF. */
function baseNameFromURL(url: string): string | undefined {
  try {
    const leaf = decodeURIComponent(new URL(url).pathname.split("/").pop()!);
    const m = /^(.+)\.pdf$/i.exec(leaf);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/** One request failure from Zotero's resolver, in words an agent can act on. */
function describeRequestError(e: unknown): string {
  const err = e as { status?: number; url?: string; message?: string };
  let host = "the site";
  try {
    if (err?.url) host = new URL(err.url).host;
  } catch {
    // Keep the generic name
  }
  if (e instanceof Attachments().InvalidPDFException) {
    return "the download was not a PDF (usually an HTML login, cookie or bot-check page)";
  }
  switch (err?.status) {
    case undefined:
      return errorMessage(e);
    case 0:
      return `could not connect to ${host}`;
    case 401:
    case 403:
      return `${host} refused the download (HTTP ${err.status}): it needs a login or blocks automated downloads`;
    case 404:
    case 410:
      return `${host} has nothing at that address (HTTP ${err.status})`;
    case 429:
      return `${host} is rate-limiting downloads (HTTP 429)`;
    default:
      return `${host} answered HTTP ${err.status}`;
  }
}

const BOT_CHECK =
  /not a (ro)?bot|just a moment|captcha|are you (a )?(human|robot)|verif(y|ying) (you|that)|access denied|attention required|security check|checking your browser/i;

function fromCodePointSafe(raw: string, code: number): string {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : raw;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (raw, hex) =>
      fromCodePointSafe(raw, parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (raw, n) => fromCodePointSafe(raw, Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Zotero found no PDF and no request failed, so the site answered with a web
 * page. One extra GET tells a bot check from an ordinary page without a PDF
 * link, and both from a file sent with a type Zotero's page handling skips
 * (`file`). Best effort: `null` when that can't be told.
 */
async function probePage(
  url: string,
): Promise<{ reason: string; file: boolean } | null> {
  try {
    const xhr = await Zotero.HTTP.request("GET", url, {
      responseType: "text",
      successCodes: false,
      errorDelayMax: 0,
      timeout: 15_000,
    } as any);
    if (!xhr.status) return null;
    const host = new URL(xhr.responseURL || url).host;
    const type = xhr.getResponseHeader("Content-Type") ?? "";
    if (!/html/i.test(type)) {
      return {
        reason: `${host} answered HTTP ${xhr.status}${type ? ` (${type.split(";")[0]})` : ""}, but not with a PDF`,
        file: xhr.status >= 200 && xhr.status < 300,
      };
    }
    const html = String(xhr.response ?? "").slice(0, 20_000);
    const title = decodeEntities(
      /<title[^>]*>([^<]{1,120})/i.exec(html)?.[1] ?? "",
    )
      .replace(/\s+/g, " ")
      .trim();
    const named = title ? ` ("${title}")` : "";
    return {
      reason: BOT_CHECK.test(title)
        ? `${host} answered with a bot check${named} that Zotero can't pass`
        : `${host} answered with a web page${named} on which Zotero found no PDF link; it may need a login`,
      file: false,
    };
  } catch {
    return null;
  }
}

/** Test seam: the probe is a real request, and unit tests stay offline. */
export const pdfDeps = { probePage };

/**
 * Records why Zotero's resolver gave up. Without this the reason only
 * reaches the debug log, and every failure reads the same to the agent.
 */
function failureLog() {
  const reasons: string[] = [];
  const add = (reason: string) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  return {
    add,
    reasons,
    options: {
      onRequestError(e: unknown) {
        add(describeRequestError(e));
        // false: don't retry. Same as Zotero without a handler
        return false;
      },
    },
    error(): ToolError {
      const why = reasons.length
        ? reasons.join("; ")
        : "the page loaded, but no PDF link was found on it (it may be paywalled, need a login, or show a bot check)";
      return new ToolError(
        `Could not get a PDF from that URL: ${why}. If this was a direct PDF link, the article's landing page sometimes works instead. If you can download the file yourself, pass it to zotero_add_pdf_file.`,
      );
    },
  };
}

/** Zotero downloads over http(s) only; a local file needs the other tool. */
function checkDownloadURL(url: string): void {
  if (/^file:\/\//i.test(url)) {
    let path = "";
    try {
      path = decodeURIComponent(new URL(url).pathname).replace(
        /^\/([A-Za-z]:\/)/,
        "$1",
      );
    } catch {
      // Leave the path out of the message
    }
    throw new ToolError(
      `That is a local file, not a download. Use zotero_add_pdf_file${path ? ` with path "${path}"` : " with its path"}.`,
    );
  }
  if (!/^https?:\/\//i.test(url)) throw new ToolError("url must be http(s)");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ToolError("url must be a valid http(s) URL");
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback =
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    host === "0:0:0:0:0:0:0:1" ||
    host === "[0:0:0:0:0:0:0:1]" ||
    /^127\./.test(host);
  if (isLoopback) {
    throw new ToolError(
      "Zotero can't download from a server on this computer. For a PDF that is already on disk, use zotero_add_pdf_file with its path.",
    );
  }
}

/**
 * Runs Zotero's resolver on the URL and explains a failure. `download` gets
 * the resolvers and Zotero's options, and returns false when nothing came.
 *
 * A `pageURL` resolver handles a direct PDF and an article page alike: Zotero
 * keeps a PDF response and otherwise looks for the PDF link in the page
 * (redirects, meta refresh, bot challenges). It only skips a file sent with
 * another content type (MDPI sends `application/octet-stream`), so when a
 * look at the URL shows that, a plain file download is tried as well.
 */
async function resolveFromURL<T>(
  url: string,
  download: (
    resolvers: UrlResolver[],
    options: Pick<DownloadOptions, "onRequestError">,
  ) => Promise<T | false>,
): Promise<T> {
  const failure = failureLog();
  const attempt = async (resolver: UrlResolver) => {
    try {
      return await downloads.run(() => download([resolver], failure.options));
    } catch (e) {
      failure.add(errorMessage(e));
      return false;
    }
  };
  let got = await attempt({ pageURL: url, accessMethod: "URL" });
  // No request failed, yet no PDF: see what the site sent instead
  if (!got && !failure.reasons.length) {
    const seen = await pdfDeps.probePage(url);
    if (seen?.file) got = await attempt({ url, accessMethod: "URL" });
    if (!got && seen && !failure.reasons.length) failure.add(seen.reason);
  }
  if (!got) throw failure.error();
  return got;
}

/** Downloads a direct PDF link or an article landing page into Zotero. */
export async function importPDFFromURL(
  url: string,
  target: PdfTarget,
): Promise<ImportResult> {
  checkDownloadURL(url);

  if ("parent" in target) {
    // Zotero names, records and saves the attachment the same way as Find Available PDF
    const att = await resolveFromURL(url, (resolvers, options) =>
      Attachments().addFileFromURLs(target.parent, resolvers, options),
    );
    return {
      status: "attached",
      attachmentKey: att.key,
      parent: describeItem(target.parent),
    };
  }

  const tmp = tempPDFPath();
  try {
    const got = await resolveFromURL(url, (resolvers, options) =>
      Attachments().downloadFirstAvailableFile(resolvers, tmp, {
        enforceFileType: true,
        ...options,
      }),
    );
    return await importPDFFile(tmp, target, {
      ownTemp: true,
      fileBaseName: baseNameFromURL(got.url) ?? baseNameFromURL(url),
    });
  } finally {
    // importPDFFile moves the file in; this covers a failed download
    await IOUtils.remove(tmp, { ignoreAbsent: true });
  }
}
