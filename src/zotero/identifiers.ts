import { S2Paper } from "../s2/types";

/** Identifiers we can match against a Zotero library. */
export interface PaperIds {
  doi?: string;
  arxiv?: string;
  s2Id?: string;
  corpusId?: string;
  title?: string;
  year?: number;
}

export interface ParsedId extends PaperIds {
  /** Form accepted by the S2 Graph API, e.g. `DOI:10.1/x`, `ARXIV:2101.00001`. */
  s2Query: string;
}

const DOI_RE = /\b(10\.\d{4,9}\/\S+)/;
const ARXIV_NEW_RE = /^(\d{4}\.\d{4,5})(v\d+)?$/;
const ARXIV_OLD_RE = /^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?$/i;
const S2_SHA_RE = /^[0-9a-f]{40}$/i;

export function normalizeDOI(doi: string): string {
  return doi
    .trim()
    .replace(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .toLowerCase();
}

export function normalizeArxiv(id: string): string {
  return id
    .trim()
    .replace(/^arxiv:\s*/i, "")
    .replace(/v\d+$/i, "")
    .toLowerCase();
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Accepts S2 ids, `DOI:`/`ARXIV:`/`CorpusId:` prefixes, bare DOIs/arXiv ids, and doi.org / arxiv.org URLs. */
export function parseIdentifier(raw: string): ParsedId {
  const input = raw.trim();
  const prefixed = /^([A-Za-z]+):(.+)$/.exec(input);
  if (prefixed && !/^https?$/i.test(prefixed[1])) {
    const [, prefix, rest] = prefixed;
    switch (prefix.toLowerCase()) {
      case "doi": {
        const doi = normalizeDOI(rest);
        return { doi, s2Query: `DOI:${doi}` };
      }
      case "arxiv": {
        const arxiv = normalizeArxiv(rest);
        return { arxiv, s2Query: `ARXIV:${arxiv}` };
      }
      case "corpusid":
        return { corpusId: rest.trim(), s2Query: `CorpusId:${rest.trim()}` };
      default:
        // PMID:, PMCID:, ACL:, MAG:, URL: — only S2 can resolve these
        return { s2Query: input };
    }
  }
  const arxivURL =
    /arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?(?:[?#]|$)/i.exec(input);
  if (arxivURL) {
    const arxiv = normalizeArxiv(arxivURL[1]);
    return { arxiv, s2Query: `ARXIV:${arxiv}` };
  }
  if (/^https?:\/\//i.test(input) && !/doi\.org\//i.test(input)) {
    return { s2Query: `URL:${input}` };
  }
  const doiMatch = DOI_RE.exec(input);
  if (doiMatch) {
    const doi = normalizeDOI(doiMatch[1]);
    return { doi, s2Query: `DOI:${doi}` };
  }
  if (ARXIV_NEW_RE.test(input) || ARXIV_OLD_RE.test(input)) {
    const arxiv = normalizeArxiv(input);
    return { arxiv, s2Query: `ARXIV:${arxiv}` };
  }
  if (S2_SHA_RE.test(input)) {
    return { s2Id: input.toLowerCase(), s2Query: input.toLowerCase() };
  }
  return { s2Query: input };
}

export function idsFromPaper(paper: S2Paper): PaperIds {
  const ext = paper.externalIds ?? {};
  return {
    doi: ext.DOI ? normalizeDOI(ext.DOI) : undefined,
    arxiv: ext.ArXiv ? normalizeArxiv(ext.ArXiv) : undefined,
    s2Id: paper.paperId?.toLowerCase(),
    corpusId:
      paper.corpusId != null
        ? String(paper.corpusId)
        : ext.CorpusId != null
          ? String(ext.CorpusId)
          : undefined,
    title: paper.title,
    year: paper.year ?? undefined,
  };
}

/** Reads `Key: value` lines from a Zotero Extra field. */
export function extraLines(extra: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of extra.split(/\r?\n/)) {
    const m = /^\s*([^:]+?)\s*:\s*(.+?)\s*$/.exec(line);
    if (m) map.set(m[1].toLowerCase(), m[2]);
  }
  return map;
}

export const EXTRA_S2_ID = "S2 Paper ID";
export const EXTRA_CORPUS_ID = "CorpusID";
