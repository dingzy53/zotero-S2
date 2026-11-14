import { S2Client, S2Error } from "../s2/client";
import {
  FULL_FIELDS,
  SEARCH_FIELDS,
  compactPaper,
  compactSnippet,
  trimRawPaper,
} from "../s2/fields";
import { CallStats, S2Paper } from "../s2/types";
import {
  describeCollection,
  findCollection,
  listCollections,
  resolveCollection,
  resolveLibraryID,
} from "../zotero/collections";
import {
  describeItem,
  findExisting,
  itemArxiv,
  itemDOI,
  itemS2Id,
  itemYear,
} from "../zotero/dedupe";
import {
  ParsedId,
  idsFromPaper,
  normalizeTitle,
  parseIdentifier,
} from "../zotero/identifiers";
import {
  MetadataSource,
  addTagsAndNote,
  applyMapped,
  createFromTranslator,
  createItem,
} from "../zotero/importer";
import {
  MAX_PDF_BYTES,
  PdfStatus,
  PdfTarget,
  attachPDFBy,
  importPDFFile,
  importPDFFromURL,
  writeTempPDF,
} from "../zotero/pdf";
import { classifyItemType, s2ToZotero } from "../zotero/s2ToZotero";
import { libraryWrites } from "../zotero/writeLock";
import { ToolError, errorMessage } from "./errors";
import { JSONSchema } from "./schema";

export interface ToolContext {
  s2: S2Client;
  /** Also carries the deadline into `S2Client.request()`. */
  stats: CallStats;
  /** Epoch ms by which the call should answer (`TOOL_BUDGET_MS` in runTool). */
  deadline: number;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: JSONSchema & { type: "object" };
  annotations: {
    readOnlyHint: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint: boolean;
  };
  handler(args: Record<string, any>, ctx: ToolContext): Promise<unknown>;
}

export const MAX_ADD = 25;
/** Collection changes are local and quick, so more items fit in one call. */
const MAX_MOVE = 100;

// --- shared schema fragments ---

const libraryID: JSONSchema = {
  type: "integer",
  description:
    "Zotero library ID. Defaults to My Library; group libraries also work.",
};
const paperIdDesc =
  "Paper id: S2 paperId, DOI:…, ARXIV:…, CorpusId:…, PMID:…, URL:…, a bare DOI/arXiv id, or a doi.org/arxiv.org URL.";
const fieldsOverride: JSONSchema = {
  type: "string",
  description:
    "Optional comma-separated S2 fields. If set, raw S2 JSON is returned instead of the compact form.",
};
const includeAttachments: JSONSchema = {
  type: "boolean",
  default: false,
  description:
    "Also list each item's attachments: key, title, filename, contentType and the file's absolute path on the Zotero computer (null if the file isn't on disk).",
};
const collectionRef: JSONSchema = {
  type: "string",
  description:
    'Collection key (e.g. "ABCD2345") or slash path (e.g. "Agent/Reading").',
};
const s2Filters: Record<string, JSONSchema> = {
  year: {
    type: "string",
    description: 'Year or range, e.g. "2019", "2016-2020", "2010-".',
  },
  publicationDateOrYear: {
    type: "string",
    description:
      'Date range "start:end", either end optional, e.g. "2019-03-05:2020-06", "2021:".',
  },
  fieldsOfStudy: {
    type: "string",
    description: 'Comma list, e.g. "Computer Science,Medicine".',
  },
  publicationTypes: {
    type: "string",
    description: 'Comma list, e.g. "JournalArticle,Conference,Review".',
  },
  venue: { type: "string", description: "Comma list of venue names." },
  minCitationCount: { type: "integer", minimum: 0 },
  openAccessPdf: {
    type: "boolean",
    description: "Only papers with a public PDF.",
  },
};

function s2FilterQuery(args: Record<string, any>) {
  return {
    year: args.year,
    publicationDateOrYear: args.publicationDateOrYear,
    fieldsOfStudy: args.fieldsOfStudy,
    publicationTypes: args.publicationTypes,
    venue: args.venue,
    minCitationCount: args.minCitationCount,
    openAccessPdf: args.openAccessPdf ? "" : undefined,
  };
}

function papersOut(list: Array<S2Paper | null>, raw: boolean) {
  return raw ? list.map(trimRawPaper) : list.map(compactPaper);
}

function getItem(libraryID: number, key: string): Zotero.Item {
  const item = Zotero.Items.getByLibraryAndKey(libraryID, key) as
    Zotero.Item | false;
  if (!item)
    throw new ToolError(`Item ${key} not found in library ${libraryID}`);
  if (!item.isRegularItem())
    throw new ToolError(`Item ${key} is not a regular item`);
  return item;
}

/** The S2 id we'd use to look up an existing Zotero item. */
function s2QueryForItem(item: Zotero.Item): string | null {
  const s2Id = itemS2Id(item);
  if (s2Id) return s2Id;
  const doi = itemDOI(item);
  if (doi) return `DOI:${doi}`;
  const arxiv = itemArxiv(item);
  if (arxiv) return `ARXIV:${arxiv}`;
  return null;
}

async function lookupItems(
  ctx: ToolContext,
  items: Zotero.Item[],
  fields: string,
  matchByTitle: boolean,
): Promise<Array<S2Paper | null>> {
  const queries = items.map(s2QueryForItem);
  const withId = queries.map((q, i) => (q ? i : -1)).filter((i) => i >= 0);
  const papers: Array<S2Paper | null> = items.map(() => null);
  if (withId.length) {
    const batch = await ctx.s2.paperBatch(
      ctx.stats,
      withId.map((i) => queries[i]!),
      fields,
    );
    withId.forEach((itemIndex, j) => (papers[itemIndex] = batch[j]));
  }
  if (matchByTitle) {
    for (let i = 0; i < items.length; i++) {
      if (papers[i]) continue;
      const title = items[i].getField("title") as string;
      if (!title) continue;
      const match = await ctx.s2.matchTitle(ctx.stats, title, fields);
      // S2 returns its closest title even for a different paper. A wrong
      // match would write its S2 id into Extra, and later runs trust that id
      if (match && isSameWork(items[i], match)) papers[i] = match;
    }
  }
  return papers;
}

const NOT_AN_S2_ID =
  "not a paper id Semantic Scholar accepts; use a DOI, arXiv id, CorpusId or S2 paperId";

/**
 * One `paperBatch` for all ids. S2 answers 400 for the whole batch when it
 * can't read one of them, so on a 400 the batch is retried once with only the
 * id forms S2 always parses, and the others come back in `rejected`. One bad
 * id must not fail the other 24.
 */
async function batchLookup(
  ctx: ToolContext,
  parsed: ParsedId[],
  fields?: string,
): Promise<{ papers: Array<S2Paper | null>; rejected: Set<number> }> {
  const query = (indexes: number[]) =>
    ctx.s2.paperBatch(
      ctx.stats,
      indexes.map((i) => parsed[i].s2Query),
      fields,
    );
  const all = parsed.map((_, i) => i);
  try {
    return { papers: await query(all), rejected: new Set() };
  } catch (e) {
    if (!(e instanceof S2Error) || e.status !== 400) throw e;
    const safe = all.filter((i) => {
      const p = parsed[i];
      return !!(p.doi || p.arxiv || p.s2Id || p.corpusId);
    });
    // Nothing to set aside: the 400 is about something else
    if (safe.length === all.length) throw e;
    const found = safe.length ? await query(safe) : [];
    const papers: Array<S2Paper | null> = parsed.map(() => null);
    safe.forEach((i, j) => (papers[i] = found[j]));
    return { papers, rejected: new Set(all.filter((i) => !safe.includes(i))) };
  }
}

function isSameWork(item: Zotero.Item, paper: S2Paper): boolean {
  const title = normalizeTitle(item.getField("title") as string);
  if (!title || title !== normalizeTitle(paper.title ?? "")) return false;
  const year = itemYear(item);
  return !year || !paper.year || year === paper.year;
}

/**
 * Sets the item's type to the one S2's data points to. Skipped when that type
 * is only the fallback guess: "journal article" for a paper S2 knows little
 * about must not overwrite a type someone chose.
 */
function fixItemType(
  item: Zotero.Item,
  paper: S2Paper,
): { from: string; to: string } | null {
  const { itemType: to, certain } = classifyItemType(paper);
  const from = Zotero.ItemTypes.getName(item.itemTypeID);
  const typeID = Zotero.ItemTypes.getID(to);
  if (!certain || to === from || !typeID) return null;
  item.setType(typeID);
  return { from, to };
}

// --- tools ---

/** Where an agent-supplied PDF goes: onto a parent item, or standalone. */
async function pdfTarget(
  lib: number,
  args: Record<string, any>,
): Promise<PdfTarget> {
  if (args.parent_item_key) {
    // Zotero gives a child attachment its parent's collections
    if (args.collection) {
      throw new ToolError(
        "Give parent_item_key or collection, not both: an attachment belongs to its parent's collections",
      );
    }
    return { parent: getItem(lib, args.parent_item_key) };
  }
  const target = args.collection
    ? await resolveCollection(lib, args.collection, args.create_collection)
    : null;
  return {
    libraryID: lib,
    collection: target?.collection ?? null,
    recognize: args.recognize,
  };
}

const PDF_HINT =
  "No open copy was found for some items. If you can get the PDF, use zotero_add_pdf_from_url (URL or landing page) or zotero_add_pdf_file (local path or base64).";
const PENDING_HINT =
  'Some PDFs are still downloading in Zotero (pdf: "pending"). Call zotero_attach_pdf again with the pending item keys to see the result; nothing is downloaded twice.';
const OUT_OF_TIME =
  "not processed: this call ran out of time. Call again with the remaining ids";

/** Advice for the PDF statuses in a result, if any is needed. */
function pdfHint(rows: Array<{ pdf?: PdfStatus }>): { hint?: string } {
  const hints = [
    rows.some((r) => r.pdf === "not_found") && PDF_HINT,
    rows.some((r) => r.pdf === "pending") && PENDING_HINT,
  ].filter(Boolean);
  return hints.length ? { hint: hints.join(" ") } : {};
}

export const TOOLS: ToolDef[] = [
  {
    name: "s2_search_papers",
    title: "Search papers (Semantic Scholar)",
    description:
      "Relevance-ranked paper search on Semantic Scholar. Returns compact records (paperId, title, year, venue, authors, doi, arxiv, citationCount, openAccessPdf). Use the returned paperId with other tools.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Plain-text query (no boolean syntax).",
        },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
        offset: { type: "integer", minimum: 0, default: 0 },
        ...s2Filters,
        fields: fieldsOverride,
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async handler(args, ctx) {
      const res = await ctx.s2.searchPapers(ctx.stats, {
        query: args.query,
        limit: args.limit,
        offset: args.offset,
        ...s2FilterQuery(args),
        ...(args.fields ? { fields: args.fields } : {}),
      });
      return {
        total: res.total,
        offset: res.offset,
        next: res.next,
        papers: papersOut(res.data ?? [], !!args.fields),
      };
    },
  },
  {
    name: "s2_search_papers_bulk",
    title: "Bulk paper search (Semantic Scholar)",
    description:
      'Boolean/bulk search for large result sets. Supports +, |, -, "phrases", * and sort (e.g. "citationCount:desc", "publicationDate:desc"). Page with the returned token.',
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        token: {
          type: "string",
          description: "Continuation token from a previous call.",
        },
        sort: { type: "string", description: 'e.g. "citationCount:desc".' },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          default: 100,
          description: "Trim the returned page to this many papers.",
        },
        ...s2Filters,
        fields: fieldsOverride,
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async handler(args, ctx) {
      const res = await ctx.s2.searchPapersBulk(ctx.stats, {
        query: args.query,
        token: args.token,
        sort: args.sort,
        ...s2FilterQuery(args),
        ...(args.fields ? { fields: args.fields } : {}),
      });
      const data: S2Paper[] = res.data ?? [];
      return {
        total: res.total,
        token: res.token ?? null,
        truncated: data.length > args.max_results,
        papers: papersOut(data.slice(0, args.max_results), !!args.fields),
      };
    },
  },
  {
    name: "s2_match_title",
    title: "Match paper by title",
    description:
      "Find the single best Semantic Scholar match for a paper title. Returns { match: null } when no title matches; that is an answer, not an error.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, fields: fieldsOverride },
      required: ["title"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async handler(args, ctx) {
      const best = await ctx.s2.matchTitle(
        ctx.stats,
        args.title,
        args.fields || FULL_FIELDS,
      );
      // A miss is a normal answer; an error would read as a failed call
      if (!best) return { match: null };
      return args.fields
        ? trimRawPaper(best)
        : { matchScore: best.matchScore, paper: compactPaper(best) };
    },
  },
  {
    name: "s2_get_papers",
    title: "Get paper details",
    description:
      "Details (incl. abstract) for 1–500 papers in one request. Prefer this over repeated single lookups: Semantic Scholar is limited to 1 request/second.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 500,
          description: paperIdDesc,
        },
        fields: fieldsOverride,
      },
      required: ["ids"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async handler(args, ctx) {
      const { papers, rejected } = await batchLookup(
        ctx,
        (args.ids as string[]).map(parseIdentifier),
        args.fields || FULL_FIELDS,
      );
      return {
        papers: (args.ids as string[]).map((id, i) => ({
          id,
          found: !!papers[i],
          paper: args.fields
            ? trimRawPaper(papers[i])
            : compactPaper(papers[i]),
          ...(rejected.has(i) && { error: NOT_AN_S2_ID }),
        })),
      };
    },
  },
  ...(["citations", "references"] as const).map((kind): ToolDef => ({
    name: `s2_get_${kind}`,
    title:
      kind === "citations" ? "Papers citing a paper" : "Papers a paper cites",
    description:
      kind === "citations"
        ? "Papers that cite the given paper, with optional citation contexts and intents."
        : "Papers referenced by the given paper, with optional citation contexts and intents.",
    inputSchema: {
      type: "object",
      properties: {
        paper_id: { type: "string", description: paperIdDesc },
        limit: { type: "integer", minimum: 1, maximum: 1000, default: 20 },
        offset: { type: "integer", minimum: 0, default: 0 },
        include_contexts: {
          type: "boolean",
          default: false,
          description:
            "Include citation context snippets, intents and isInfluential.",
        },
        fields: fieldsOverride,
      },
      required: ["paper_id"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async handler(args, ctx) {
      const fields =
        args.fields ||
        (args.include_contexts
          ? `${SEARCH_FIELDS},contexts,intents,isInfluential`
          : SEARCH_FIELDS);
      const res = await ctx.s2.paperRelations(
        ctx.stats,
        kind,
        parseIdentifier(args.paper_id).s2Query,
        { fields, limit: args.limit, offset: args.offset },
      );
      const key = kind === "citations" ? "citingPaper" : "citedPaper";
      if (args.fields) {
        return {
          ...res,
          data: (res.data ?? []).map((row: any) => ({
            ...row,
            [key]: trimRawPaper(row[key]),
          })),
        };
      }
      return {
        offset: res.offset,
        next: res.next,
        items: (res.data ?? []).map((row: any) => ({
          paper: compactPaper(row[key]),
          ...(args.include_contexts
            ? {
                isInfluential: row.isInfluential,
                intents: row.intents,
                contexts: row.contexts,
              }
            : {}),
        })),
      };
    },
  })),
  {
    name: "s2_recommend",
    title: "Recommend related papers",
    description:
      "Paper recommendations. One positive id → recommendations for that paper; several positive and/or negative ids → recommendations from example lists.",
    inputSchema: {
      type: "object",
      properties: {
        positive_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 100,
          description: paperIdDesc,
        },
        negative_ids: {
          type: "array",
          items: { type: "string" },
          maxItems: 100,
        },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 10 },
        pool: {
          type: "string",
          enum: ["recent", "all-cs"],
          default: "recent",
          description: "Candidate pool (single-paper mode only).",
        },
        fields: fieldsOverride,
      },
      required: ["positive_ids"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async handler(args, ctx) {
      const pos = (args.positive_ids as string[]).map(
        (id) => parseIdentifier(id).s2Query,
      );
      const neg = ((args.negative_ids as string[]) ?? []).map(
        (id) => parseIdentifier(id).s2Query,
      );
      // A `fields: undefined` would override the client's default fields
      const fields = args.fields ? { fields: args.fields } : {};
      const res =
        pos.length === 1 && !neg.length
          ? await ctx.s2.recommendForPaper(ctx.stats, pos[0], {
              limit: args.limit,
              from: args.pool,
              ...fields,
            })
          : await ctx.s2.recommendFromLists(ctx.stats, pos, neg, {
              limit: args.limit,
              ...fields,
            });
      return {
        papers: papersOut(res.recommendedPapers ?? [], !!args.fields),
      };
    },
  },
  {
    name: "s2_search_authors",
    title: "Search authors",
    description:
      "Find Semantic Scholar authors by name (with paper count, citations, h-index).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1000, default: 10 },
        offset: { type: "integer", minimum: 0, default: 0 },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async handler(args, ctx) {
      const res = await ctx.s2.searchAuthors(ctx.stats, {
        query: args.query,
        limit: args.limit,
        offset: args.offset,
      });
      return { total: res.total, next: res.next, authors: res.data ?? [] };
    },
  },
  {
    name: "s2_get_author_papers",
    title: "Papers by an author",
    description: "List papers by a Semantic Scholar author id.",
    inputSchema: {
      type: "object",
      properties: {
        author_id: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 1000, default: 20 },
        offset: { type: "integer", minimum: 0, default: 0 },
        fields: fieldsOverride,
      },
      required: ["author_id"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async handler(args, ctx) {
      const res = await ctx.s2.authorPapers(ctx.stats, args.author_id, {
        limit: args.limit,
        offset: args.offset,
        ...(args.fields ? { fields: args.fields } : {}),
      });
      return {
        offset: res.offset,
        next: res.next,
        papers: papersOut(res.data ?? [], !!args.fields),
      };
    },
  },
  {
    name: "s2_snippet_search",
    title: "Full-text snippet search",
    description:
      "Search ~500-word text snippets from paper titles, abstracts and bodies. Good for finding papers that state a specific claim or method. Each result's paper.id (CorpusId:…) works with the other tools.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Plain-text query." },
        limit: { type: "integer", minimum: 1, maximum: 1000, default: 10 },
        paperIds: {
          type: "string",
          description: `Comma list of up to ~100 paper ids to search within. ${paperIdDesc}`,
        },
        year: s2Filters.year,
        publicationDateOrYear: s2Filters.publicationDateOrYear,
        fieldsOfStudy: s2Filters.fieldsOfStudy,
        venue: s2Filters.venue,
        minCitationCount: s2Filters.minCitationCount,
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async handler(args, ctx) {
      const paperIds = (args.paperIds as string | undefined)
        ?.split(",")
        .filter((id) => id.trim())
        .map((id) => parseIdentifier(id).s2Query)
        .join(",");
      const res = await ctx.s2.snippetSearch(ctx.stats, {
        query: args.query,
        limit: args.limit,
        paperIds,
        year: args.year,
        publicationDateOrYear: args.publicationDateOrYear,
        fieldsOfStudy: args.fieldsOfStudy,
        venue: args.venue,
        minCitationCount: args.minCitationCount,
      });
      return { results: (res.data ?? []).map(compactSnippet) };
    },
  },
  {
    name: "zotero_list_collections",
    title: "List Zotero collections",
    description:
      "All collections in a library with key, slash path, parent and item count.",
    inputSchema: { type: "object", properties: { library_id: libraryID } },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async handler(args) {
      const lib = resolveLibraryID(args.library_id);
      return { libraryID: lib, collections: listCollections(lib) };
    },
  },
  {
    name: "zotero_create_collection",
    title: "Create Zotero collection",
    description:
      'Create a collection by slash path ("Parent/Child"); missing parents are created. Idempotent: returns the existing collection if present.',
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, library_id: libraryID },
      required: ["path"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async handler(args) {
      const lib = resolveLibraryID(args.library_id, true);
      const { collection, created } = await resolveCollection(
        lib,
        args.path,
        true,
      );
      return { created, collection: describeCollection(collection) };
    },
  },
  {
    name: "zotero_list_collection_items",
    title: "List items in a collection",
    description:
      "Regular items in a collection: key, title, year, authors, DOI, arXiv, S2 id, hasPDF. Set include_attachments to get each item's files and their paths.",
    inputSchema: {
      type: "object",
      properties: {
        collection: collectionRef,
        include_subcollections: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
        offset: { type: "integer", minimum: 0, default: 0 },
        include_attachments: includeAttachments,
        library_id: libraryID,
      },
      required: ["collection"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    async handler(args) {
      const lib = resolveLibraryID(args.library_id);
      const collection = findCollection(lib, args.collection);
      if (!collection)
        throw new ToolError(`Collection "${args.collection}" not found`);
      const ids = new Set<number>(collection.getChildItems(true));
      if (args.include_subcollections) {
        for (const sub of Zotero.Collections.getByParent(collection.id, true)) {
          for (const id of sub.getChildItems(true)) ids.add(id);
        }
      }
      const items = (Zotero.Items.get([...ids]) as Zotero.Item[])
        .filter((i) => i.isRegularItem() && !i.deleted)
        .sort((a, b) =>
          (a.getField("title") as string).localeCompare(
            b.getField("title") as string,
          ),
        );
      return {
        collection: describeCollection(collection),
        total: items.length,
        offset: args.offset,
        items: items
          .slice(args.offset, args.offset + args.limit)
          .map((item) => describeItem(item, args.include_attachments)),
      };
    },
  },
  {
    name: "zotero_find_in_library",
    title: "Check whether papers are in Zotero",
    description:
      "For each id, report the matching Zotero item (by DOI, arXiv id, S2 id or title+year) and its collections and PDF status. Ids that need it are resolved via one S2 batch call.",
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 100,
          description: paperIdDesc,
        },
        resolve_via_s2: {
          type: "boolean",
          default: true,
          description: "Fetch DOI/arXiv/title from S2 to improve matching.",
        },
        include_attachments: includeAttachments,
        library_id: libraryID,
      },
      required: ["ids"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    async handler(args, ctx) {
      const lib = resolveLibraryID(args.library_id);
      const parsed = (args.ids as string[]).map(parseIdentifier);
      let papers: Array<S2Paper | null> = parsed.map(() => null);
      let warning: string | undefined;
      if (args.resolve_via_s2) {
        // The library check still works without S2 (e.g. no API key yet)
        try {
          papers = await ctx.s2.paperBatch(
            ctx.stats,
            parsed.map((p) => p.s2Query),
            "paperId,corpusId,externalIds,title,year",
          );
        } catch (e) {
          if (!(e instanceof S2Error)) throw e;
          warning = `Matched by the given ids only; Semantic Scholar lookup failed: ${e.message}`;
        }
      }
      const results = [];
      for (let i = 0; i < parsed.length; i++) {
        const ids = papers[i]
          ? { ...parsed[i], ...idsFromPaper(papers[i]!) }
          : parsed[i];
        const item = await findExisting(lib, ids);
        results.push({
          id: args.ids[i],
          inLibrary: !!item,
          item: item ? describeItem(item, args.include_attachments) : null,
        });
      }
      return warning ? { warning, results } : { results };
    },
  },
  {
    name: "zotero_add_papers",
    title: "Add papers to Zotero",
    description: `Add up to ${MAX_ADD} papers (any id form) to Zotero, optionally into a collection (created if missing), and attach PDFs (S2 open-access → arXiv → Zotero resolvers). Papers already in the library are reused and just added to the collection. A DOI or arXiv id that Semantic Scholar doesn't have is looked up by Zotero itself (Crossref, arXiv). Each id gets its own result row, so one bad id doesn't fail the others. For longer lists, call repeatedly in chunks of ${MAX_ADD}.`,
    inputSchema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_ADD,
          description: paperIdDesc,
        },
        collection: collectionRef,
        create_collection: { type: "boolean", default: true },
        attach_pdf: { type: "boolean", default: true },
        tags: { type: "array", items: { type: "string" } },
        note: {
          type: "string",
          description: "Child note (plain text or HTML) added to each item.",
        },
        metadata_source: {
          type: "string",
          enum: ["s2", "translator"],
          default: "s2",
          description:
            '"s2" maps Semantic Scholar metadata (fast). "translator" uses Zotero\'s DOI/arXiv lookup (richer, ~3 s per paper), falling back to S2.',
        },
        library_id: libraryID,
      },
      required: ["ids"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async handler(args, ctx) {
      const lib = resolveLibraryID(args.library_id, true);
      const ids = args.ids as string[];
      const parsed = ids.map(parseIdentifier);
      const { papers, rejected } = await batchLookup(ctx, parsed);
      const target = args.collection
        ? await resolveCollection(lib, args.collection, args.create_collection)
        : null;
      const collectionID = target?.collection.id ?? null;

      type Row = {
        id: string;
        itemKey?: string;
        title?: string;
        existing?: boolean;
        metadataSource?: MetadataSource;
        pdf?: PdfStatus;
        note?: string;
        error?: string;
      };
      const rows: Row[] = [];
      const work: Array<{
        row: Row;
        item: Zotero.Item;
        paper: S2Paper | null;
      }> = [];

      for (let i = 0; i < ids.length; i++) {
        const paper = papers[i];
        const row: Row = { id: ids[i] };
        rows.push(row);
        // Zotero's own lookup can still resolve a DOI or arXiv id S2 lacks
        const { doi, arxiv } = parsed[i];
        const byId = !paper && (doi || arxiv) ? { doi, arxiv } : null;
        if (!paper && !byId) {
          row.error = rejected.has(i)
            ? NOT_AN_S2_ID
            : "not found on Semantic Scholar";
          continue;
        }
        // Translator lookups take ~3 s each; answer before the client gives up
        if (Date.now() >= ctx.deadline) {
          row.error = OUT_OF_TIME;
          continue;
        }
        try {
          // A parallel call must not create the same item between our check and create
          const item = await libraryWrites.run(async () => {
            const found = await findExisting(
              lib,
              paper ? idsFromPaper(paper) : byId!,
            );
            let item: Zotero.Item;
            if (found) {
              item = found;
              row.existing = true;
              if (collectionID && !item.inCollection(collectionID)) {
                item.addToCollection(collectionID);
                await item.saveTx();
              }
            } else if (!paper) {
              const created = await createFromTranslator(
                lib,
                byId!,
                collectionID,
              ).catch((e) => {
                throw new ToolError(
                  `not found on Semantic Scholar, and Zotero's ${doi ? "DOI" : "arXiv"} lookup failed: ${errorMessage(e)}`,
                );
              });
              if (!created) {
                throw new ToolError(
                  `not found on Semantic Scholar or by Zotero's ${doi ? "DOI" : "arXiv"} lookup`,
                );
              }
              item = created;
              row.existing = false;
              row.metadataSource = "translator";
              row.note =
                "Semantic Scholar doesn't have this paper; the metadata comes from Zotero's own lookup.";
            } else {
              const created = await createItem(
                lib,
                paper,
                collectionID,
                args.metadata_source,
              );
              item = created.item;
              row.existing = false;
              row.metadataSource = created.source;
            }
            await addTagsAndNote(item, args.tags, args.note);
            return item;
          });
          row.itemKey = item.key;
          row.title = item.getField("title") as string;
          work.push({ row, item, paper });
        } catch (e) {
          row.error = errorMessage(e);
        }
      }

      if (args.attach_pdf) {
        await Promise.all(
          work.map(async ({ row, item, paper }) => {
            row.pdf = await attachPDFBy(ctx.deadline, item, paper);
          }),
        );
      }

      return {
        collection: target
          ? {
              ...describeCollection(target.collection),
              created: target.created,
            }
          : null,
        summary: {
          added: rows.filter((r) => r.existing === false).length,
          existing: rows.filter((r) => r.existing === true).length,
          failed: rows.filter((r) => r.error).length,
          pdfAttached: rows.filter((r) => r.pdf === "attached").length,
          pdfPending: rows.filter((r) => r.pdf === "pending").length,
        },
        results: rows,
        ...pdfHint(rows),
      };
    },
  },
  {
    name: "zotero_move_items",
    title: "Move items between collections",
    description: `Add up to ${MAX_MOVE} existing items to collections and/or remove them from collections. Give both to move items (e.g. into a subcollection). Items are never deleted: an item removed from its last collection stays in the library, unfiled. Collections themselves are not deleted or renamed; do that in Zotero.`,
    inputSchema: {
      type: "object",
      properties: {
        item_keys: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_MOVE,
        },
        add_to: {
          type: "array",
          items: collectionRef,
          maxItems: 10,
          description: "Collections to put the items in.",
        },
        remove_from: {
          type: "array",
          items: collectionRef,
          maxItems: 10,
          description:
            "Collections to take the items out of. They must exist. Subcollections are not affected.",
        },
        create_collections: {
          type: "boolean",
          default: true,
          description: "Create add_to collections that don't exist yet.",
        },
        library_id: libraryID,
      },
      required: ["item_keys"],
    },
    annotations: {
      readOnlyHint: false,
      // Changes collection membership only; items and collections stay
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async handler(args) {
      const lib = resolveLibraryID(args.library_id, true);
      const addRefs = (args.add_to as string[] | undefined) ?? [];
      const removeRefs = (args.remove_from as string[] | undefined) ?? [];
      if (!addRefs.length && !removeRefs.length) {
        throw new ToolError("Give add_to, remove_from, or both");
      }
      // Check everything before the first write, so a typo changes nothing
      const items = (args.item_keys as string[]).map((k) => getItem(lib, k));
      const removeFrom = removeRefs.map((ref) => {
        const collection = findCollection(lib, ref);
        if (!collection) {
          throw new ToolError(`Collection "${ref}" (remove_from) not found`);
        }
        return collection;
      });
      const addTo: Zotero.Collection[] = [];
      for (const ref of addRefs) {
        const existing = findCollection(lib, ref);
        if (existing && removeFrom.some((c) => c.id === existing.id)) {
          throw new ToolError(
            `Collection "${ref}" is in both add_to and remove_from`,
          );
        }
        if (!existing && !args.create_collections) {
          throw new ToolError(`Collection "${ref}" (add_to) not found`);
        }
      }
      for (const ref of addRefs) {
        addTo.push((await resolveCollection(lib, ref, true)).collection);
      }

      const results = [];
      for (const item of items) {
        // Membership is read and written under the lock other writers use
        results.push(
          await libraryWrites.run(async () => {
            const added = addTo.filter((c) => !item.inCollection(c.id));
            const removed = removeFrom.filter((c) => item.inCollection(c.id));
            for (const c of added) item.addToCollection(c.id);
            for (const c of removed) item.removeFromCollection(c.id);
            if (added.length || removed.length) await item.saveTx();
            return {
              itemKey: item.key,
              added: added.map((c) => c.key),
              removed: removed.map((c) => c.key),
              collections: describeItem(item).collections,
            };
          }),
        );
      }
      return {
        addTo: addTo.map(describeCollection),
        removeFrom: removeFrom.map(describeCollection),
        results,
      };
    },
  },
  {
    name: "zotero_attach_pdf",
    title: "Find and attach PDFs",
    description: `Find and attach a PDF for up to ${MAX_ADD} existing Zotero items that lack one. A download that outlasts the call is reported as "pending" and keeps running; call again with those keys to see how it ended.`,
    inputSchema: {
      type: "object",
      properties: {
        item_keys: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_ADD,
        },
        library_id: libraryID,
      },
      required: ["item_keys"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async handler(args, ctx) {
      const lib = resolveLibraryID(args.library_id, true);
      const items = (args.item_keys as string[]).map((k) => getItem(lib, k));
      const papers = await lookupItems(
        ctx,
        items,
        "paperId,externalIds,openAccessPdf",
        false,
      );
      const results = await Promise.all(
        items.map(async (item, i) => ({
          itemKey: item.key,
          pdf: await attachPDFBy(ctx.deadline, item, papers[i]),
        })),
      );
      return { results, ...pdfHint(results) };
    },
  },
  {
    name: "zotero_add_pdf_from_url",
    title: "Add a PDF from a URL",
    description:
      "Download a PDF into Zotero. Works with direct PDF links and with article landing pages (Zotero follows the page to its PDF). With parent_item_key it is attached to that item; otherwise it is saved standalone (optionally into a collection) and Zotero's metadata recognizer creates a parent item. Many publisher sites refuse automated downloads; the error then says what the site answered. If so, or if the PDF is already on disk, fetch the file yourself and use zotero_add_pdf_file.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        parent_item_key: { type: "string" },
        collection: collectionRef,
        create_collection: { type: "boolean", default: true },
        recognize: { type: "boolean", default: true },
        library_id: libraryID,
      },
      required: ["url"],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
    async handler(args) {
      const lib = resolveLibraryID(args.library_id, true);
      return importPDFFromURL(args.url, await pdfTarget(lib, args));
    },
  },
  {
    name: "zotero_add_pdf_file",
    title: "Add a PDF file",
    description: `Import a PDF you already have into Zotero (stored as a copy; your file is left in place). Give exactly one of path (an absolute path on the computer running Zotero) or content_base64 (the file's bytes, for agents on another machine; max ${MAX_PDF_BYTES / 1024 / 1024} MB). With parent_item_key it is attached to that item, and the same file is never attached twice; otherwise it is saved standalone, optionally into a collection, and Zotero's metadata recognizer (which sends text from the PDF to Zotero's service) creates a parent item. Use this when zotero_attach_pdf or zotero_add_pdf_from_url can't fetch a paywalled or bot-protected PDF but you can.`,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to a .pdf file on the Zotero computer.",
        },
        content_base64: {
          type: "string",
          description: "The PDF's bytes, base64-encoded.",
        },
        filename: {
          type: "string",
          description:
            'File name for a standalone base64 upload, e.g. "paper.pdf".',
        },
        title: {
          type: "string",
          description: "Attachment title (default: Zotero's).",
        },
        parent_item_key: { type: "string" },
        collection: collectionRef,
        create_collection: { type: "boolean", default: true },
        recognize: { type: "boolean", default: true },
        library_id: libraryID,
      },
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    async handler(args) {
      const lib = resolveLibraryID(args.library_id, true);
      const hasPath = args.path !== undefined;
      if (hasPath === (args.content_base64 !== undefined)) {
        throw new ToolError("Give exactly one of path or content_base64");
      }
      const target = await pdfTarget(lib, args);
      if (hasPath) {
        return importPDFFile(args.path, target, { title: args.title });
      }
      const tmp = await writeTempPDF(args.content_base64);
      const name = args.filename
        ? String(args.filename).replace(/\.pdf$/i, "")
        : undefined;
      return importPDFFile(tmp, target, {
        title: args.title,
        fileBaseName: name ? Zotero.File.getValidFileName(name) : undefined,
        ownTemp: true,
      });
    },
  },
  {
    name: "zotero_enrich_items",
    title: "Enrich items from Semantic Scholar",
    description: `Match up to ${MAX_ADD} existing Zotero items on Semantic Scholar (by S2 id, DOI, arXiv, else an exact title with no conflicting year) and fill in missing fields (abstract, date, venue, DOI, authors). Records the S2 id in Extra. With overwrite=true existing values are replaced. With fix_item_type=true an item whose type is wrong (e.g. a conference paper saved as a journal article) is changed to the right one.`,
    inputSchema: {
      type: "object",
      properties: {
        item_keys: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          // Items without ids need one title match each, at 1 request/second
          maxItems: MAX_ADD,
        },
        overwrite: { type: "boolean", default: false },
        fix_item_type: {
          type: "boolean",
          default: false,
          description:
            "Change the item type when Semantic Scholar's data clearly shows another one (journal article ↔ conference paper, preprint, book…). Zotero drops fields the new type doesn't have. The change is reported as itemType: { from, to }.",
        },
        library_id: libraryID,
      },
      required: ["item_keys"],
    },
    annotations: {
      readOnlyHint: false,
      // overwrite=true replaces existing field values; fix_item_type can drop some
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    async handler(args, ctx) {
      const lib = resolveLibraryID(args.library_id, true);
      const items = (args.item_keys as string[]).map((k) => getItem(lib, k));
      const papers = await lookupItems(ctx, items, FULL_FIELDS, true);
      const results = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const paper = papers[i];
        if (!paper) {
          results.push({ itemKey: item.key, matched: false });
          continue;
        }
        // Before the fields: they are checked against the item's type
        const retyped = args.fix_item_type ? fixItemType(item, paper) : null;
        const changed = applyMapped(item, s2ToZotero(paper), !args.overwrite);
        if (changed.length || retyped) await item.saveTx();
        results.push({
          itemKey: item.key,
          matched: true,
          paperId: paper.paperId,
          changed,
          ...(retyped && { itemType: retyped }),
        });
      }
      return { results };
    },
  },
];

// prepareArgs() rejects unknown arguments; advertise that to clients
for (const tool of TOOLS) tool.inputSchema.additionalProperties = false;

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
