import { Semaphore } from "../s2/rateLimiter";
import { S2Paper } from "../s2/types";
import { ToolError, errorMessage } from "../mcp/errors";
import {
  Attachments,
  RecognizeDocument,
  UrlResolver,
  UtilitiesInternal,
} from "./apis";
import { describeCollection } from "./collections";
import { describeItem, hasPDF, itemArxiv } from "./dedupe";

export type PdfStatus =
  "attached" | "already" | "not_found" | `failed: ${string}`;

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

async function attachOnce(
  item: Zotero.Item,
  paper?: S2Paper | null,
): Promise<PdfStatus> {
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

  try {
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

/**
 * Downloads a direct PDF link or an article landing page. A `pageURL`
 * resolver does both: Zotero keeps a PDF response and otherwise looks for
 * the PDF link in the page (redirects, meta refresh, bot challenges).
 */
export async function importPDFFromURL(
  url: string,
  target: PdfTarget,
): Promise<ImportResult> {
  if (!/^https?:\/\//i.test(url)) throw new ToolError("url must be http(s)");
  const resolvers: UrlResolver[] = [{ pageURL: url, accessMethod: "URL" }];
  const failed = new ToolError(
    "Could not get a PDF from that URL (it may be paywalled, need a login, or block automated downloads). " +
      "If you can download the file yourself, pass it to zotero_add_pdf_file.",
  );

  if ("parent" in target) {
    // Zotero names, records and saves the attachment the same way as Find Available PDF
    let att: Zotero.Item | false;
    try {
      att = await downloads.run(() =>
        Attachments().addFileFromURLs(target.parent, resolvers),
      );
    } catch (e) {
      Zotero.debug(`[Zotero S2] PDF download failed: ${errorMessage(e)}`);
      throw failed;
    }
    if (!att) throw failed;
    return {
      status: "attached",
      attachmentKey: att.key,
      parent: describeItem(target.parent),
    };
  }

  const tmp = tempPDFPath();
  let got: Awaited<
    ReturnType<ReturnType<typeof Attachments>["downloadFirstAvailableFile"]>
  >;
  try {
    got = await downloads.run(() =>
      Attachments().downloadFirstAvailableFile(resolvers, tmp, {
        enforceFileType: true,
      }),
    );
  } catch (e) {
    await IOUtils.remove(tmp, { ignoreAbsent: true });
    Zotero.debug(`[Zotero S2] PDF download failed: ${errorMessage(e)}`);
    throw failed;
  }
  if (!got) {
    await IOUtils.remove(tmp, { ignoreAbsent: true });
    throw failed;
  }
  return importPDFFile(tmp, target, {
    ownTemp: true,
    fileBaseName: baseNameFromURL(got.url) ?? baseNameFromURL(url),
  });
}
