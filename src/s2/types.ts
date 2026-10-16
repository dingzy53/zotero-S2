export interface S2Author {
  authorId: string | null;
  name: string;
}

export interface S2ExternalIds {
  DOI?: string;
  ArXiv?: string;
  PubMed?: string;
  PubMedCentral?: string;
  ACL?: string;
  DBLP?: string;
  MAG?: string;
  CorpusId?: number | string;
}

export interface S2Paper {
  paperId: string;
  corpusId?: number;
  externalIds?: S2ExternalIds | null;
  url?: string;
  title?: string;
  abstract?: string | null;
  venue?: string | null;
  publicationVenue?: { name?: string; type?: string } | null;
  year?: number | null;
  publicationDate?: string | null;
  journal?: { name?: string; volume?: string; pages?: string } | null;
  authors?: S2Author[];
  citationCount?: number;
  referenceCount?: number;
  influentialCitationCount?: number;
  isOpenAccess?: boolean;
  openAccessPdf?: { url?: string | null; status?: string | null } | null;
  fieldsOfStudy?: string[] | null;
  publicationTypes?: string[] | null;
  tldr?: { text?: string } | null;
}

/** A `/snippet/search` result row (only the fields we read). */
export interface S2SnippetMatch {
  score?: number;
  snippet?: { text?: string; snippetKind?: string; section?: string };
  paper?: { corpusId?: string; title?: string; authors?: string[] };
}

/** Per-tool-call counters, surfaced in the activity log. */
export interface CallStats {
  s2Calls: number;
  retries: number;
}

export function newStats(): CallStats {
  return { s2Calls: 0, retries: 0 };
}
