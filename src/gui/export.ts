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

function formatBibField(name: string, value: string): string {
  return `  ${name} = {${bibValue(value)}}`;
}

const ARXIV_VOLUME = /^abs\/(.+)$/;

/** BibTeX fields identifying an arXiv preprint. */
function arxivFields(arxivId: string): Array<[string, string]> {
  return [
    ["eprint", arxivId],
    ["archivePrefix", "arXiv"],
  ];
}

/** Strips one outer layer of balanced `{…}` or `"…"` from a BibTeX value. */
function unquoteBibValue(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && s[0] === "{" && s[s.length - 1] === "}") {
    let depth = 0;
    let closesAtEnd = true;
    for (let i = 0; i < s.length - 1; i++) {
      if (s[i] === "\\" && i + 1 < s.length - 1) {
        i++;
        continue;
      }
      if (s[i] === "{") depth++;
      else if (s[i] === "}") {
        depth--;
        if (depth === 0) {
          closesAtEnd = false;
          break;
        }
      }
    }
    if (closesAtEnd && depth === 1) return s.slice(1, -1).trim();
  }
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    let depth = 0;
    let closesAtEnd = true;
    for (let i = 1; i < s.length - 1; i++) {
      if (s[i] === "\\" && i + 1 < s.length - 1) {
        i++;
        continue;
      }
      if (s[i] === "{") depth++;
      else if (s[i] === "}" && depth > 0) depth--;
      else if (s[i] === '"' && depth === 0) {
        closesAtEnd = false;
        break;
      }
    }
    if (closesAtEnd && depth === 0) return s.slice(1, -1).trim();
  }
  return s;
}

interface BibField {
  name: string;
  nameStart: number;
  nameEnd: number;
  valueStart: number;
  valueEnd: number;
  commaIndex: number;
  rawValue: string;
}

/**
 * Scans the top-level `field = value` assignments inside a single BibTeX
 * entry, handling nested braces, quoted values (with escapes and braces),
 * barewords and `#` concatenations.
 */
function parseBibFields(bib: string): {
  headerComma: number;
  fields: BibField[];
} {
  const fields: BibField[] = [];
  const open = bib.indexOf("{");
  const close = bib.lastIndexOf("}");
  if (open === -1 || close <= open) return { headerComma: -1, fields };

  let i = open + 1;
  while (i < close && bib[i] !== "," && bib[i] !== "}" && bib[i] !== "=") i++;
  if (i >= close || bib[i] !== ",") return { headerComma: -1, fields };
  const headerComma = i;
  i++;

  while (i < close) {
    while (i < close && /\s/.test(bib[i])) i++;
    if (i >= close) break;
    const nameStart = i;
    while (i < close && /[A-Za-z0-9_:-]/.test(bib[i])) i++;
    const nameEnd = i;
    if (nameEnd === nameStart) break;
    const name = bib.slice(nameStart, nameEnd).toLowerCase();

    while (i < close && /\s/.test(bib[i])) i++;
    if (i >= close || bib[i] !== "=") break;
    i++;
    while (i < close && /\s/.test(bib[i])) i++;

    const valueStart = i;
    let valueEnd = valueStart;
    for (;;) {
      if (i >= close) break;
      const ch = bib[i];
      if (ch === "{") {
        let depth = 1;
        i++;
        while (i < close && depth > 0) {
          if (bib[i] === "\\" && i + 1 < close) {
            i += 2;
            continue;
          }
          if (bib[i] === "{") depth++;
          else if (bib[i] === "}") depth--;
          i++;
        }
        if (depth !== 0) return { headerComma, fields };
        valueEnd = i;
      } else if (ch === '"') {
        let depth = 0;
        let closed = false;
        i++;
        while (i < close) {
          if (bib[i] === "\\" && i + 1 < close) {
            i += 2;
            continue;
          }
          if (bib[i] === "{") depth++;
          else if (bib[i] === "}" && depth > 0) depth--;
          else if (bib[i] === '"' && depth === 0) {
            i++;
            closed = true;
            break;
          }
          i++;
        }
        if (!closed) return { headerComma, fields };
        valueEnd = i;
      } else {
        const atomStart = i;
        while (i < close && !/[\s,#}]/.test(bib[i])) i++;
        if (i === atomStart) break;
        valueEnd = i;
      }

      let next = i;
      while (next < close && /\s/.test(bib[next])) next++;
      if (next < close && bib[next] === "#") {
        i = next + 1;
        while (i < close && /\s/.test(bib[i])) i++;
        continue;
      }
      break;
    }

    if (valueEnd === valueStart) break;
    while (i < close && /\s/.test(bib[i])) i++;
    let commaIndex = -1;
    if (i < close && bib[i] === ",") {
      commaIndex = i;
      i++;
    }
    fields.push({
      name,
      nameStart,
      nameEnd,
      valueStart,
      valueEnd,
      commaIndex,
      rawValue: bib.slice(valueStart, valueEnd),
    });
    if (commaIndex === -1) break;
  }

  return { headerComma, fields };
}

/**
 * Removes every occurrence of `fieldName` (case-insensitive) from a BibTeX
 * entry without breaking surrounding fields or commas.
 */
export function removeBibField(bib: string, fieldName: string): string {
  const target = fieldName.toLowerCase();
  let result = bib;
  for (;;) {
    const { headerComma, fields } = parseBibFields(result);
    const idx = fields.findIndex((f) => f.name === target);
    if (idx === -1) return result;
    const f = fields[idx];
    const lineStart = result.lastIndexOf("\n", f.nameStart - 1) + 1;
    const onlyIndentBefore = /^[ \t]*$/.test(
      result.slice(lineStart, f.nameStart),
    );
    const prevComma = idx > 0 ? fields[idx - 1].commaIndex : headerComma;

    if (f.commaIndex !== -1) {
      const afterComma = result.slice(f.commaIndex + 1);
      const eol = /^[ \t]*\r?\n/.exec(afterComma);
      if (onlyIndentBefore && eol) {
        result =
          result.slice(0, lineStart) +
          result.slice(f.commaIndex + 1 + eol[0].length);
      } else if (onlyIndentBefore && /^[ \t]*\}/.test(afterComma)) {
        result = result.slice(0, lineStart) + result.slice(f.commaIndex + 1);
      } else if (onlyIndentBefore) {
        const spaces = /^[ \t]*/.exec(afterComma)![0].length;
        result =
          result.slice(0, f.nameStart) +
          result.slice(f.commaIndex + 1 + spaces);
      } else if (eol || /^[ \t]*\}/.test(afterComma)) {
        let start = f.nameStart;
        while (start > lineStart && /[ \t]/.test(result[start - 1])) start--;
        result = result.slice(0, start) + result.slice(f.commaIndex + 1);
      } else {
        const spaces = /^[ \t]*/.exec(afterComma)![0].length;
        result =
          result.slice(0, f.nameStart) +
          result.slice(f.commaIndex + 1 + spaces);
      }
    } else {
      const afterVal = result.slice(f.valueEnd);
      const eol = /^[ \t]*\r?\n/.exec(afterVal);
      if (onlyIndentBefore && eol && prevComma !== -1) {
        // Drop the field's line(s) and the preceding comma so the entry stays clean
        result =
          result.slice(0, prevComma) +
          result.slice(prevComma + 1, lineStart) +
          result.slice(f.valueEnd + eol[0].length);
      } else if (prevComma !== -1) {
        result = result.slice(0, prevComma) + result.slice(f.valueEnd);
      } else {
        result = result.slice(0, f.nameStart) + result.slice(f.valueEnd);
      }
    }
  }
}

/** Appends fields to a BibTeX entry, skipping any already present. */
function appendBibFields(
  bib: string,
  additions: ReadonlyArray<[string, string]>,
): string {
  const { fields } = parseBibFields(bib);
  const present = new Set(fields.map((f) => f.name));
  const missing = additions.filter(
    ([name]) => !present.has(name.toLowerCase()),
  );
  if (!missing.length) return bib;
  const close = bib.lastIndexOf("}");
  if (close <= 0) return bib;
  const before = bib.slice(0, close).trimEnd();
  const comma = before.endsWith(",") ? "" : ",";
  const lines = missing.map(([n, v]) => formatBibField(n, v)).join(",\n");
  return `${before}${comma}\n${lines}\n${bib.slice(close)}`;
}

/**
 * Fixes known flaws in S2's `citationStyles.bibtex`: conference papers come
 * back as `@Article` with a `booktitle` (sometimes alongside `journal`),
 * journal and arXiv `@Article` entries often carry a stray `booktitle`, arXiv
 * ids are put in `volume = {abs/<id>}` instead of `eprint`/`archivePrefix`,
 * and `doi` is left out even when S2 knows it. `paper` is the search result's
 * metadata.
 */
export function normalizeBibtexEntry(raw: string, paper?: S2Paper): string {
  let bib = raw.trim();
  if (/^@article\s*\{/i.test(bib)) {
    const { fields } = parseBibFields(bib);
    const booktitle = fields.find((f) => f.name === "booktitle");
    const hasJournal = fields.some((f) => f.name === "journal");
    if (booktitle) {
      const types = paper?.publicationTypes ?? [];
      if (!hasJournal) {
        if (types.includes("JournalArticle") && !types.includes("Conference"))
          bib =
            bib.slice(0, booktitle.nameStart) +
            "journal" +
            bib.slice(booktitle.nameEnd);
        else bib = bib.replace(/^@article\s*\{/i, "@inproceedings{");
      } else if (
        types.includes("Conference") &&
        !types.includes("JournalArticle")
      ) {
        bib = bib.replace(/^@article\s*\{/i, "@inproceedings{");
        bib = removeBibField(bib, "journal");
      } else {
        bib = removeBibField(bib, "booktitle");
      }
    }
  }
  let arxivId: string | undefined;
  const volume = parseBibFields(bib).fields.find((f) => f.name === "volume");
  if (volume) {
    const match = ARXIV_VOLUME.exec(unquoteBibValue(volume.rawValue));
    if (match) {
      bib = removeBibField(bib, "volume");
      arxivId = paper?.externalIds?.ArXiv?.trim() || match[1].trim();
    }
  }
  const additions: Array<[string, string]> = [];
  const doi = paper?.externalIds?.DOI;
  if (doi) additions.push(["doi", doi]);
  if (arxivId) additions.push(...arxivFields(arxivId));
  if (additions.length) bib = appendBibFields(bib, additions);
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
  const arxivVolume = p.journal?.volume
    ? ARXIV_VOLUME.exec(p.journal.volume.trim())?.[1]?.trim()
    : undefined;
  if (type === "inproceedings") fields.push(["booktitle", venue]);
  if (type === "article") {
    fields.push(
      ["journal", p.journal?.name || venue],
      ["volume", arxivVolume ? undefined : p.journal?.volume],
      ["pages", p.journal?.pages?.trim()],
    );
  }
  fields.push(["year", p.year], ["doi", p.externalIds?.DOI]);
  const arxivId = p.externalIds?.ArXiv?.trim() || arxivVolume;
  if (arxivId) fields.push(...arxivFields(arxivId));
  if (type === "misc" && !p.externalIds?.DOI) fields.push(["url", p.url]);
  const body = fields
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([name, v]) => formatBibField(name, String(v)))
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
