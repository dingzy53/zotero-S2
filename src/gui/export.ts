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

/**
 * Joins S2's BibTeX entries (`citationStyles.bibtex` from `s2_get_papers`),
 * and names the papers S2 had none for.
 */
export function joinBibtex(rows: ReadonlyArray<{ id: string; paper: any }>): {
  text: string;
  missing: string[];
} {
  const entries: string[] = [];
  const missing: string[] = [];
  for (const row of rows) {
    const bib = row.paper?.citationStyles?.bibtex;
    if (bib) entries.push(String(bib).trim());
    else missing.push(row.id);
  }
  return { text: entries.length ? entries.join("\n\n") + "\n" : "", missing };
}
