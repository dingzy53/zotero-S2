import { S2Paper } from "../s2/types";
import { EXTRA_CORPUS_ID, EXTRA_S2_ID } from "./identifiers";

export interface MappedCreator {
  firstName: string;
  lastName: string;
  creatorType: "author";
}

export interface MappedItem {
  itemType: string;
  /** Zotero field name → value. Fields invalid for the type are dropped at save time. */
  fields: Record<string, string>;
  creators: MappedCreator[];
  /** `Key: value` lines to merge into Extra. */
  extra: string[];
}

const PARTICLES = new Set([
  "van",
  "von",
  "der",
  "den",
  "de",
  "del",
  "della",
  "di",
  "da",
  "dos",
  "du",
  "la",
  "le",
  "st.",
  "ter",
  "ten",
  "bin",
  "al",
]);
const SUFFIXES = new Set(["jr", "jr.", "sr", "sr.", "ii", "iii", "iv"]);

export function splitName(name: string): MappedCreator {
  const clean = name.replace(/\s+/g, " ").trim();
  if (clean.includes(",")) {
    const [last, first] = clean.split(",", 2);
    return {
      firstName: first.trim(),
      lastName: last.trim(),
      creatorType: "author",
    };
  }
  const parts = clean.split(" ");
  if (parts.length === 1) {
    return { firstName: "", lastName: clean, creatorType: "author" };
  }
  let end = parts.length;
  let suffix = "";
  if (end > 2 && SUFFIXES.has(parts[end - 1].toLowerCase())) {
    suffix = " " + parts[end - 1];
    end--;
  }
  let start = end - 1;
  while (start > 1 && PARTICLES.has(parts[start - 1].toLowerCase())) start--;
  return {
    firstName: parts.slice(0, start).join(" "),
    lastName: parts.slice(start, end).join(" ") + suffix,
    creatorType: "author",
  };
}

function isArxivOnly(p: S2Paper): boolean {
  if (!p.externalIds?.ArXiv) return false;
  const venue = p.venue || p.publicationVenue?.name || "";
  return !venue.trim() || /arxiv/i.test(venue);
}

export function chooseItemType(p: S2Paper): string {
  const types = p.publicationTypes ?? [];
  const venueType = p.publicationVenue?.type?.toLowerCase();
  if (types.includes("Book")) return "book";
  if (types.includes("BookSection")) return "bookSection";
  if (types.includes("Dataset")) return "dataset";
  if (isArxivOnly(p)) return "preprint";
  if (types.includes("Conference") || venueType === "conference") {
    return "conferencePaper";
  }
  return "journalArticle";
}

export function s2ToZotero(p: S2Paper): MappedItem {
  const itemType = chooseItemType(p);
  const fields: Record<string, string> = {};
  const set = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    const str = String(value).trim();
    if (str) fields[key] = str;
  };

  set("title", p.title);
  set("abstractNote", p.abstract);
  set("date", p.publicationDate || p.year);

  const doi = p.externalIds?.DOI;
  const arxiv = p.externalIds?.ArXiv;
  set("DOI", doi);

  const journalName = p.journal?.name;
  const isArxivJournal = !!journalName && /^arxiv/i.test(journalName);
  const venue = (!isArxivJournal && journalName) || p.venue || undefined;

  switch (itemType) {
    case "journalArticle":
      set("publicationTitle", venue);
      if (!isArxivJournal) {
        set("volume", p.journal?.volume);
        set("pages", p.journal?.pages?.replace(/\s+/g, ""));
      }
      break;
    case "conferencePaper":
      set("proceedingsTitle", venue);
      set("conferenceName", p.publicationVenue?.name);
      set(
        "pages",
        isArxivJournal ? undefined : p.journal?.pages?.replace(/\s+/g, ""),
      );
      break;
    case "bookSection":
      set("bookTitle", venue);
      break;
    case "preprint":
      set("repository", "arXiv");
      if (arxiv) set("archiveID", `arXiv:${arxiv}`);
      break;
  }

  set(
    "url",
    arxiv && itemType === "preprint" ? `https://arxiv.org/abs/${arxiv}` : p.url,
  );

  const extra: string[] = [];
  if (arxiv && itemType !== "preprint") extra.push(`arXiv: ${arxiv}`);
  if (p.paperId) extra.push(`${EXTRA_S2_ID}: ${p.paperId}`);
  const corpusId = p.corpusId ?? p.externalIds?.CorpusId;
  if (corpusId != null) extra.push(`${EXTRA_CORPUS_ID}: ${corpusId}`);

  return {
    itemType,
    fields,
    creators: (p.authors ?? [])
      .filter((a) => a.name)
      .map((a) => splitName(a.name)),
    extra,
  };
}

/** Appends lines whose key is not already present in Extra. */
export function mergeExtra(existing: string, lines: string[]): string {
  const present = new Set(
    existing
      .split(/\r?\n/)
      .map((l) => l.split(":")[0].trim().toLowerCase())
      .filter(Boolean),
  );
  const add = lines.filter(
    (l) => !present.has(l.split(":")[0].trim().toLowerCase()),
  );
  if (!add.length) return existing;
  return [existing.trim(), ...add].filter(Boolean).join("\n");
}
