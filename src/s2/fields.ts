import { S2Paper } from "./types";

/** Enough to choose papers and file them. Kept small: agents pay per token. */
export const SEARCH_FIELDS = [
  "paperId",
  "externalIds",
  "title",
  "year",
  "venue",
  "authors",
  "citationCount",
  "isOpenAccess",
  "openAccessPdf",
  "publicationTypes",
].join(",");

/** Everything the Zotero importer maps. */
export const FULL_FIELDS = [
  SEARCH_FIELDS,
  "corpusId",
  "url",
  "abstract",
  "publicationDate",
  "journal",
  "publicationVenue",
  "fieldsOfStudy",
].join(",");

export const AUTHOR_FIELDS =
  "authorId,name,affiliations,paperCount,citationCount,hIndex";

const MAX_AUTHORS = 8;

/** Compact, agent-friendly view of a paper. */
export function compactPaper(p: S2Paper | null) {
  if (!p) return null;
  const authors = p.authors?.map((a) => a.name) ?? [];
  return {
    paperId: p.paperId,
    title: p.title,
    year: p.year ?? undefined,
    venue: p.venue || p.journal?.name || undefined,
    authors:
      authors.length > MAX_AUTHORS
        ? [
            ...authors.slice(0, MAX_AUTHORS),
            `+${authors.length - MAX_AUTHORS} more`,
          ]
        : authors,
    doi: p.externalIds?.DOI,
    arxiv: p.externalIds?.ArXiv,
    citationCount: p.citationCount,
    publicationTypes: p.publicationTypes ?? undefined,
    openAccessPdf: p.openAccessPdf?.url || undefined,
    abstract: p.abstract ?? undefined,
    tldr: p.tldr?.text,
  };
}
