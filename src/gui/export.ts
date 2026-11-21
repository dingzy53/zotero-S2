/** Pure serializers for exporting search results. */
import type { S2Paper } from "../s2/types";
import { venueOf } from "./model";

export type ExportFormat = "bibtex" | "ris" | "csv";

export const EXTENSIONS: Record<ExportFormat, string> = {
  bibtex: "bib",
  ris: "ris",
  csv: "csv",
};

/** RFC 4180: quote fields with quotes, commas or line breaks. */
function csvField(value: unknown): string {
  const s = value === undefined || value === null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_COLUMNS: Array<[string, (p: S2Paper) => unknown]> = [
  ["Title", (p) => p.title],
  ["Authors", (p) => (p.authors ?? []).map((a) => a.name).join("; ")],
  ["Year", (p) => p.year],
  ["Venue", (p) => venueOf(p)],
  ["Publication date", (p) => p.publicationDate],
  ["DOI", (p) => p.externalIds?.DOI],
  ["arXiv", (p) => p.externalIds?.ArXiv],
  ["S2 paper id", (p) => p.paperId],
  ["URL", (p) => p.url],
  ["Citations", (p) => p.citationCount],
  ["Abstract", (p) => p.abstract],
];

export function toCSV(papers: readonly S2Paper[]): string {
  const lines = [CSV_COLUMNS.map(([name]) => csvField(name)).join(",")];
  for (const p of papers) {
    lines.push(CSV_COLUMNS.map(([, get]) => csvField(get(p))).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

function risType(p: S2Paper): string {
  const types = p.publicationTypes ?? [];
  if (types.includes("JournalArticle")) return "JOUR";
  if (types.includes("Conference")) return "CPAPER";
  if (types.includes("BookSection")) return "CHAP";
  if (types.includes("Book")) return "BOOK";
  if (types.includes("Dataset")) return "DATA";
  if (p.externalIds?.ArXiv) return "UNPB";
  return "GEN";
}

/** RIS values are single-line. */
function oneLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

export function toRIS(papers: readonly S2Paper[]): string {
  const out: string[] = [];
  const tag = (name: string, value: unknown) => {
    if (value === undefined || value === null || value === "") return;
    out.push(`${name}  - ${oneLine(String(value))}`);
  };
  for (const p of papers) {
    const type = risType(p);
    tag("TY", type);
    tag("TI", p.title);
    for (const a of p.authors ?? []) tag("AU", a.name);
    tag("PY", p.year);
    // RIS dates are YYYY/MM/DD
    tag("DA", p.publicationDate?.replace(/-/g, "/"));
    tag(type === "JOUR" ? "JO" : "T2", venueOf(p));
    tag("VL", p.journal?.volume);
    tag("SP", p.journal?.pages);
    tag("DO", p.externalIds?.DOI);
    tag("UR", p.url);
    if (p.externalIds?.ArXiv) tag("N1", `arXiv: ${p.externalIds.ArXiv}`);
    tag("AB", p.abstract);
    out.push("ER  - ", "");
  }
  return out.join("\r\n");
}

/** Brace-delimited BibTeX values: escape braces so a title can't end them. */
function bibValue(s: string): string {
  return oneLine(s).replace(/[{}]/g, (c) => `\\${c}`);
}

/**
 * Fixes two known flaws in S2's `citationStyles.bibtex`: conference papers
 * come back as `@Article` with a `booktitle` (and no `journal`), and `doi` is
 * left out even when S2 knows it. `paper` is the search result's metadata.
 */
export function normalizeBibtexEntry(raw: string, paper?: S2Paper): string {
  let bib = raw.trim();
  if (
    /^@article\s*\{/i.test(bib) &&
    /\bbooktitle\s*=/i.test(bib) &&
    !/\bjournal\s*=/i.test(bib)
  ) {
    const types = paper?.publicationTypes ?? [];
    if (types.includes("JournalArticle") && !types.includes("Conference"))
      bib = bib.replace(/\bbooktitle(\s*=)/i, "journal$1");
    else bib = bib.replace(/^@article\s*\{/i, "@inproceedings{");
  }
  const doi = paper?.externalIds?.DOI;
  const close = bib.lastIndexOf("}");
  if (doi && close > 0 && !/\bdoi\s*=/i.test(bib)) {
    const before = bib.slice(0, close).trimEnd();
    const comma = before.endsWith(",") ? "" : ",";
    bib = `${before}${comma}\n  doi = {${bibValue(doi)}}\n${bib.slice(close)}`;
  }
  return bib;
}

/** ASCII letters and digits only, for citation keys. */
function keyPart(s: string | undefined | null): string {
  return (s ?? "").normalize("NFD").replace(/[^A-Za-z0-9]/g, "");
}

/** A citation key in S2's style: last name, year, first title word. */
function citeKey(p: S2Paper): string {
  const last = p.authors?.[0]?.name?.trim().split(/\s+/).pop();
  const word = (p.title ?? "")
    .split(/\s+/)
    .map(keyPart)
    .find((w) => w);
  const key = `${keyPart(last)}${p.year ?? ""}${word ?? ""}`;
  return /[A-Za-z]/.test(key) ? key : `S2${p.paperId.slice(0, 10)}`;
}

/** Builds a BibTeX entry from S2 metadata, for papers S2 has none for. */
export function bibtexFromPaper(p: S2Paper): string {
  const types = p.publicationTypes ?? [];
  const venue = venueOf(p);
  let type = "misc";
  if (types.includes("JournalArticle") && !types.includes("Conference"))
    type = "article";
  else if (types.includes("Conference")) type = "inproceedings";
  else if (p.publicationVenue?.type === "conference") type = "inproceedings";
  else if (p.journal?.name || p.publicationVenue?.type === "journal")
    type = "article";
  const fields: Array<[string, unknown]> = [
    ["author", (p.authors ?? []).map((a) => a.name).join(" and ")],
    ["title", p.title],
  ];
  if (type === "inproceedings") fields.push(["booktitle", venue]);
  if (type === "article") {
    fields.push(
      ["journal", p.journal?.name || venue],
      ["volume", p.journal?.volume],
      ["pages", p.journal?.pages?.trim()],
    );
  }
  fields.push(["year", p.year], ["doi", p.externalIds?.DOI]);
  if (p.externalIds?.ArXiv) {
    fields.push(["eprint", p.externalIds.ArXiv], ["archivePrefix", "arXiv"]);
  }
  if (type === "misc" && !p.externalIds?.DOI) fields.push(["url", p.url]);
  const body = fields
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([name, v]) => `  ${name} = {${bibValue(String(v))}}`)
    .join(",\n");
  return `@${type}{${citeKey(p)}${body ? `,\n${body}` : ""}\n}`;
}

/**
 * Joins S2's BibTeX entries (`citationStyles.bibtex` from `s2_get_papers`),
 * normalized against the search results' metadata in `papers`. Papers S2 had
 * no entry for are built from that metadata; the rest are named as missing.
 */
export function joinBibtex(
  rows: ReadonlyArray<{ id: string; paper: any }>,
  papers: readonly S2Paper[] = [],
): {
  text: string;
  missing: string[];
} {
  const known = new Map(papers.map((p) => [p.paperId, p]));
  const entries: string[] = [];
  const missing: string[] = [];
  for (const row of rows) {
    const paper = known.get(row.id);
    const bib = row.paper?.citationStyles?.bibtex;
    if (bib) entries.push(normalizeBibtexEntry(String(bib), paper));
    else if (paper) entries.push(bibtexFromPaper(paper));
    else missing.push(row.id);
  }
  return { text: entries.length ? entries.join("\n\n") + "\n" : "", missing };
}
