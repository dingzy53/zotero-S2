import { Semaphore } from "../s2/rateLimiter";
import { S2Paper } from "../s2/types";
import { errorMessage } from "../mcp/errors";
import { Attachments, UrlResolver } from "./apis";
import { hasPDF, itemArxiv } from "./dedupe";

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
