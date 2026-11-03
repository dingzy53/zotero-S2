export interface ActivityEntry {
  time: number;
  via: "mcp" | "rest" | "prefs" | "gui";
  tool: string;
  args: string;
  durationMs: number;
  s2Calls: number;
  retries: number;
  ok: boolean;
  error?: string;
}

const MAX_ENTRIES = 200;
const entries: ActivityEntry[] = [];
const listeners = new Set<() => void>();

/** Long strings (e.g. a base64 PDF) are logged by length, never by content. */
function shortenLong(_key: string, value: unknown): unknown {
  return typeof value === "string" && value.length > 200
    ? `<${value.length} chars>`
    : value;
}

function summarizeArgs(args: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(args, shortenLong) ?? "";
  } catch {
    s = String(args);
  }
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

export function record(entry: Omit<ActivityEntry, "args"> & { args: unknown }) {
  const full = { ...entry, args: summarizeArgs(entry.args) };
  entries.unshift(full);
  if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES;
  Zotero.debug(
    `[Zotero S2] ${full.via} ${full.tool} ${full.ok ? "ok" : "error"} ` +
      `${full.durationMs}ms s2=${full.s2Calls} retries=${full.retries}` +
      (full.error ? ` ${full.error}` : ""),
  );
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // A closed prefs window must not break logging
    }
  }
}

export function getEntries(): readonly ActivityEntry[] {
  return entries;
}

export function clearEntries() {
  entries.length = 0;
  for (const fn of listeners) fn();
}

export function onChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
