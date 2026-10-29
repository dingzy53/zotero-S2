/**
 * Remembered search state and query history, stored as JSON prefs. Parsing
 * tolerates anything, since prefs can be edited by hand or by old versions.
 */
import { getPref, setPref } from "../utils/prefs";
import type { AddTarget } from "./addBar";
import { Filters, MODES, Mode, emptyFilters } from "./model";

export interface GuiState {
  mode: Mode;
  query: string;
  filters: Filters;
  sort: string;
  target: AddTarget | null;
  tags: string;
  metadata: string;
  attachPdf: boolean;
}

export interface HistoryEntry {
  mode: Mode;
  query: string;
}

export const HISTORY_MAX = 20;

export function defaultState(): GuiState {
  return {
    mode: "simple",
    query: "",
    filters: emptyFilters(),
    sort: "",
    target: null,
    tags: "",
    metadata: "s2",
    attachPdf: true,
  };
}

function parseJSON(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

const str = (v: unknown, fallback = "") =>
  typeof v === "string" ? v : fallback;
const strList = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const isMode = (v: unknown): v is Mode => MODES.includes(v as Mode);

export function parseState(json: string): GuiState {
  const d = defaultState();
  const raw = parseJSON(json) as Record<string, any> | null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return d;
  const f = (raw.filters ?? {}) as Record<string, unknown>;
  const t = raw.target as Record<string, unknown> | null | undefined;
  return {
    mode: isMode(raw.mode) ? raw.mode : d.mode,
    query: str(raw.query),
    filters: {
      yearFrom: str(f.yearFrom),
      yearTo: str(f.yearTo),
      dateFrom: str(f.dateFrom),
      dateTo: str(f.dateTo),
      venue: str(f.venue),
      fieldsOfStudy: strList(f.fieldsOfStudy),
      publicationTypes: strList(f.publicationTypes),
      minCitations: str(f.minCitations),
      openAccess: f.openAccess === true,
    },
    sort: str(raw.sort),
    target:
      t && Number.isInteger(t.libraryID)
        ? { libraryID: t.libraryID as number, collection: str(t.collection) }
        : null,
    tags: str(raw.tags),
    metadata: raw.metadata === "translator" ? "translator" : "s2",
    attachPdf: raw.attachPdf !== false,
  };
}

export function parseHistory(json: string): HistoryEntry[] {
  const raw = parseJSON(json);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (e): e is HistoryEntry =>
        !!e && isMode(e.mode) && typeof e.query === "string" && !!e.query,
    )
    .slice(0, HISTORY_MAX);
}

/** Newest first; a repeated query (same mode, any case) moves to the top. */
export function addHistory(
  list: readonly HistoryEntry[],
  entry: HistoryEntry,
): HistoryEntry[] {
  const query = entry.query.trim();
  if (!query) return [...list];
  const key = query.toLowerCase();
  return [
    { mode: entry.mode, query },
    ...list.filter(
      (e) => !(e.mode === entry.mode && e.query.toLowerCase() === key),
    ),
  ].slice(0, HISTORY_MAX);
}

// --- prefs I/O ---

export function loadState(): GuiState {
  return parseState(getPref("gui.lastState") || "");
}

export function saveState(state: GuiState) {
  setPref("gui.lastState", JSON.stringify(state));
}

export function loadHistory(): HistoryEntry[] {
  return parseHistory(getPref("gui.history") || "");
}

export function recordHistory(entry: HistoryEntry) {
  setPref("gui.history", JSON.stringify(addHistory(loadHistory(), entry)));
}

export function clearHistory() {
  setPref("gui.history", "");
}
