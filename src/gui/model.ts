/**
 * Pure search-window logic: form state → tool calls, filter validation,
 * identifier detection and paging. No Zotero globals, so it's unit-tested.
 */
import { GUI_FIELDS } from "../s2/fields";
import type { S2Paper } from "../s2/types";
import { S2_PREFIXES, parseIdentifier } from "../zotero/identifiers";

export type Mode = "simple" | "advanced" | "bulk" | "authors";
export const MODES: readonly Mode[] = ["simple", "advanced", "bulk", "authors"];

/** S2's documented `fieldsOfStudy` values. */
export const FIELDS_OF_STUDY = [
  "Computer Science",
  "Medicine",
  "Chemistry",
  "Biology",
  "Materials Science",
  "Physics",
  "Geology",
  "Psychology",
  "Art",
  "History",
  "Geography",
  "Sociology",
  "Business",
  "Political Science",
  "Economics",
  "Philosophy",
  "Mathematics",
  "Engineering",
  "Environmental Science",
  "Agricultural and Food Sciences",
  "Education",
  "Law",
  "Linguistics",
] as const;

/** S2's documented `publicationTypes` values. */
export const PUBLICATION_TYPES = [
  "JournalArticle",
  "Conference",
  "Review",
  "MetaAnalysis",
  "Study",
  "Book",
  "BookSection",
  "CaseReport",
  "ClinicalTrial",
  "Dataset",
  "Editorial",
  "LettersAndComments",
  "News",
] as const;

/** Bulk search sorts. Bulk search has no relevance order. */
export const BULK_SORTS = [
  "paperId:asc",
  "citationCount:desc",
  "citationCount:asc",
  "publicationDate:desc",
  "publicationDate:asc",
] as const;

/** S2 returns at most this many relevance-ranked results per query. */
export const RELEVANCE_CAP = 1000;
export const PAGE_SIZES = [25, 50, 100] as const;

export interface Filters {
  yearFrom: string;
  yearTo: string;
  dateFrom: string;
  dateTo: string;
  venue: string;
  fieldsOfStudy: string[];
  publicationTypes: string[];
  minCitations: string;
  openAccess: boolean;
}

export function emptyFilters(): Filters {
  return {
    yearFrom: "",
    yearTo: "",
    dateFrom: "",
    dateTo: "",
    venue: "",
    fieldsOfStudy: [],
    publicationTypes: [],
    minCitations: "",
    openAccess: false,
  };
}

export type FilterError =
  "year-format" | "year-order" | "date-format" | "date-order" | "citations";

const YEAR_RE = /^\d{4}$/;
// S2 accepts a year, a month or a day at either end of a date range
const DATE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

export function validateFilters(f: Filters): FilterError | null {
  const yf = f.yearFrom.trim();
  const yt = f.yearTo.trim();
  if ((yf && !YEAR_RE.test(yf)) || (yt && !YEAR_RE.test(yt)))
    return "year-format";
  if (yf && yt && Number(yf) > Number(yt)) return "year-order";
  const df = f.dateFrom.trim();
  const dt = f.dateTo.trim();
  if ((df && !DATE_RE.test(df)) || (dt && !DATE_RE.test(dt)))
    return "date-format";
  // Prefixes compare correctly as strings: "2019" < "2019-03" < "2020"
  if (df && dt && df.slice(0, dt.length) > dt.slice(0, df.length))
    return "date-order";
  const mc = f.minCitations.trim();
  if (mc && !/^\d+$/.test(mc)) return "citations";
  return null;
}

/** S2's `year` syntax: "2019", "2016-2020", "2010-", "-2015". */
export function yearParam(from: string, to: string): string | undefined {
  const f = from.trim();
  const t = to.trim();
  if (!f && !t) return undefined;
  if (f && f === t) return f;
  return `${f}-${t}`;
}

/** S2's `publicationDateOrYear` syntax: "start:end", either end optional. */
export function dateParam(from: string, to: string): string | undefined {
  const f = from.trim();
  const t = to.trim();
  if (!f && !t) return undefined;
  return `${f}:${t}`;
}

/** Filter arguments in the shape of the tools' `s2Filters` schema. */
export function filterArgs(f: Filters): Record<string, unknown> {
  const venue = f.venue
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .join(",");
  return {
    year: yearParam(f.yearFrom, f.yearTo),
    publicationDateOrYear: dateParam(f.dateFrom, f.dateTo),
    venue: venue || undefined,
    fieldsOfStudy: f.fieldsOfStudy.length
      ? f.fieldsOfStudy.join(",")
      : undefined,
    publicationTypes: f.publicationTypes.length
      ? f.publicationTypes.join(",")
      : undefined,
    minCitationCount: f.minCitations.trim()
      ? Number(f.minCitations.trim())
      : undefined,
    openAccessPdf: f.openAccess || undefined,
  };
}

/** How many filters are set, for the collapsed-panel summary. */
export function activeFilterCount(f: Filters): number {
  return Object.values(filterArgs(f)).filter((v) => v !== undefined).length;
}

/**
 * Relevance and author search match nothing for hyphenated terms (S2 docs),
 * so hyphens become spaces. Bulk search keeps `-` as its NOT operator.
 */
export function relevanceQuery(q: string): string {
  return q.replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The paper id the user typed, or null for an ordinary query. `parseIdentifier`
 * falls back to `{s2Query: input}` for any text (and "Transformers: a survey"
 * matches its prefix pattern), so only recognized id forms count here.
 */
export function detectIdentifier(raw: string): string | null {
  const input = raw.trim();
  if (!input || /\s/.test(input)) return null;
  const parsed = parseIdentifier(input);
  if (parsed.doi || parsed.arxiv || parsed.corpusId || parsed.s2Id)
    return parsed.s2Query;
  const prefix = /^([A-Za-z]+):/.exec(parsed.s2Query)?.[1];
  if (prefix && S2_PREFIXES[prefix.toLowerCase()] === prefix)
    return parsed.s2Query;
  return null;
}

export interface SearchForm {
  mode: Mode;
  query: string;
  filters: Filters;
  sort: string;
  pageSize: number;
}

export interface ToolRequest {
  tool: string;
  args: Record<string, unknown>;
}

export type SearchPlan =
  | { kind: "error"; error: FilterError | "empty" }
  | { kind: "lookup"; request: ToolRequest }
  | { kind: "papers"; request: ToolRequest; rewritten: boolean }
  | { kind: "authors"; request: ToolRequest; rewritten: boolean };

export function planSearch(form: SearchForm): SearchPlan {
  const query = form.query.trim();
  if (!query) return { kind: "error", error: "empty" };
  const withFilters = form.mode === "advanced" || form.mode === "bulk";
  if (withFilters) {
    const error = validateFilters(form.filters);
    if (error) return { kind: "error", error };
  }
  const filters = withFilters ? filterArgs(form.filters) : {};

  if (form.mode === "simple") {
    const id = detectIdentifier(query);
    if (id) {
      return {
        kind: "lookup",
        request: {
          tool: "s2_get_papers",
          args: { ids: [id], fields: GUI_FIELDS },
        },
      };
    }
  }
  if (form.mode === "bulk") {
    return {
      kind: "papers",
      rewritten: false,
      request: {
        tool: "s2_search_papers_bulk",
        // Keep the whole page: trimming would make the next token skip rows
        args: {
          query,
          sort: form.sort || undefined,
          max_results: 1000,
          fields: GUI_FIELDS,
          ...filters,
        },
      },
    };
  }
  const text = relevanceQuery(query);
  if (!text) return { kind: "error", error: "empty" };
  if (form.mode === "authors") {
    return {
      kind: "authors",
      rewritten: text !== query,
      request: {
        tool: "s2_search_authors",
        args: { query: text, limit: form.pageSize, offset: 0 },
      },
    };
  }
  return {
    kind: "papers",
    rewritten: text !== query,
    request: {
      tool: "s2_search_papers",
      args: {
        query: text,
        limit: form.pageSize,
        offset: 0,
        fields: GUI_FIELDS,
        ...filters,
      },
    },
  };
}

// --- paging ---

export type Paging =
  | {
      kind: "offset";
      offset: number;
      limit: number;
      total?: number;
      hasNext: boolean;
      cap?: number;
    }
  | { kind: "token"; token: string | null; total?: number }
  | { kind: "none" };

export function offsetPaging(
  res: { offset?: number; next?: number | null; total?: number },
  limit: number,
  cap?: number,
): Paging {
  const offset = res.offset ?? 0;
  return {
    kind: "offset",
    offset,
    limit,
    total: res.total,
    hasNext: res.next != null && (cap === undefined || offset + limit < cap),
    cap,
  };
}

export function canPrev(p: Paging): boolean {
  return p.kind === "offset" && p.offset > 0;
}

export function canNext(p: Paging): boolean {
  return p.kind === "offset" ? p.hasNext : p.kind === "token" && !!p.token;
}

/** Arguments that, merged into the original request, fetch the adjacent page. */
export function pageArgs(
  p: Paging,
  dir: "next" | "prev",
): Record<string, unknown> | null {
  if (dir === "next" && !canNext(p)) return null;
  if (dir === "prev" && !canPrev(p)) return null;
  if (p.kind === "token") return { token: p.token };
  if (p.kind !== "offset") return null;
  const offset =
    dir === "next" ? p.offset + p.limit : Math.max(0, p.offset - p.limit);
  const limit =
    p.cap === undefined ? p.limit : Math.min(p.limit, p.cap - offset);
  return { offset, limit };
}

/** 1-based range of the rows on the current page. */
export function pageRange(p: Paging, count: number) {
  const first = p.kind === "offset" ? p.offset + 1 : 1;
  return { first: count ? first : 0, last: first + count - 1 };
}

// --- tool results → papers ---

function usable(p: S2Paper | null | undefined): p is S2Paper {
  // Citation lists contain stubs without a paperId; they can't be added
  return !!p && !!p.paperId;
}

/** Papers from any paper-returning tool called with `fields`. */
export function papersFromResult(tool: string, value: any): S2Paper[] {
  if (!value) return [];
  if (tool === "s2_get_papers")
    return (value.papers ?? []).map((r: any) => r.paper).filter(usable);
  if (tool === "s2_get_citations")
    return (value.data ?? []).map((r: any) => r.citingPaper).filter(usable);
  if (tool === "s2_get_references")
    return (value.data ?? []).map((r: any) => r.citedPaper).filter(usable);
  return (value.papers ?? []).filter(usable);
}

/** Paging state for a tool's result. */
export function pagingFromResult(
  tool: string,
  value: any,
  limit: number,
  requestOffset = 0,
): Paging {
  // Author search answers without an offset; the request's is the same
  value = { offset: requestOffset, ...value };
  switch (tool) {
    case "s2_search_papers":
      return offsetPaging(value, limit, RELEVANCE_CAP);
    case "s2_search_papers_bulk":
      return {
        kind: "token",
        token: value?.token ?? null,
        total: value?.total,
      };
    case "s2_search_authors":
    case "s2_get_author_papers":
    case "s2_get_citations":
    case "s2_get_references":
      return offsetPaging(value, limit);
    default:
      return { kind: "none" };
  }
}

export interface S2AuthorRow {
  authorId: string;
  name: string;
  affiliations?: string[];
  paperCount?: number;
  citationCount?: number;
  hIndex?: number;
}

export function authorsFromResult(value: any): S2AuthorRow[] {
  return (value?.authors ?? []).filter((a: any) => a?.authorId);
}

// --- display helpers ---

export function authorLine(p: S2Paper, max = 3): string {
  const names = (p.authors ?? []).map((a) => a.name);
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} et al.`;
}

export function venueOf(p: S2Paper): string {
  return p.venue || p.journal?.name || "";
}

export function pdfUrl(p: S2Paper): string | undefined {
  return p.openAccessPdf?.url || undefined;
}

export type SortKey = "title" | "authors" | "year" | "venue" | "citations";

/** Client-side sort of the loaded rows. Stable, missing values last. */
export function sortPapers(
  papers: readonly S2Paper[],
  key: SortKey | null,
  desc: boolean,
): S2Paper[] {
  if (!key) return [...papers];
  const value = (p: S2Paper): string | number | undefined => {
    switch (key) {
      case "title":
        return p.title?.toLowerCase();
      case "authors":
        return p.authors?.[0]?.name.toLowerCase();
      case "year":
        return p.year ?? undefined;
      case "venue":
        return venueOf(p).toLowerCase() || undefined;
      case "citations":
        return p.citationCount;
    }
  };
  return papers
    .map((p, i) => ({ p, i, v: value(p) }))
    .sort((a, b) => {
      if (a.v === undefined && b.v === undefined) return a.i - b.i;
      if (a.v === undefined) return 1;
      if (b.v === undefined) return -1;
      const c = a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
      return (desc ? -c : c) || a.i - b.i;
    })
    .map((x) => x.p);
}
