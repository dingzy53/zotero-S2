import { S2Paper, S2SnippetMatch } from "./types";

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

/** Skips the default offsets and sentence/reference annotations. */
export const SNIPPET_FIELDS =
  "snippet.text,snippet.snippetKind,snippet.section";

const MAX_AUTHORS = 8;

function shortAuthors(names: string[]): string[] {
  return names.length > MAX_AUTHORS
    ? [...names.slice(0, MAX_AUTHORS), `+${names.length - MAX_AUTHORS} more`]
    : names;
}

/** Compact, agent-friendly view of a paper. */
export function compactPaper(p: S2Paper | null) {
  if (!p) return null;
  return {
    paperId: p.paperId,
    title: p.title,
    year: p.year ?? undefined,
    venue: p.venue || p.journal?.name || undefined,
    authors: shortAuthors(p.authors?.map((a) => a.name) ?? []),
    doi: p.externalIds?.DOI,
    arxiv: p.externalIds?.ArXiv,
    citationCount: p.citationCount,
    publicationTypes: p.publicationTypes ?? undefined,
    openAccessPdf: p.openAccessPdf?.url || undefined,
    abstract: p.abstract ?? undefined,
    tldr: p.tldr?.text,
  };
}

/**
 * One `/snippet/search` row. Its paper block always carries an open-access
 * disclaimer, so keep only what's needed to cite or add the paper.
 */
export function compactSnippet(row: S2SnippetMatch) {
  const corpusId = row.paper?.corpusId;
  return {
    score: row.score,
    text: row.snippet?.text,
    section: row.snippet?.section || undefined,
    kind: row.snippet?.snippetKind,
    paper: {
      id: corpusId ? `CorpusId:${corpusId}` : undefined,
      title: row.paper?.title,
      authors: shortAuthors(row.paper?.authors ?? []),
    },
  };
}
