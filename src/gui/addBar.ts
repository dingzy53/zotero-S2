import type { S2Paper } from "../s2/types";
import { MAX_ADD } from "../mcp/tools";
import { getString } from "../utils/locale";
import { listCollections } from "../zotero/collections";
import { findExisting } from "../zotero/dedupe";
import { idsFromPaper } from "../zotero/identifiers";
import { callTool } from "./deps";

const NEW = "__new__";
const ROOT = "";

export interface AddTarget {
  libraryID: number;
  /** Collection key, or "" for the library root. */
  collection: string;
}

/**
 * Where to add by default: the collection selected in the main window when
 * exactly one is (GUI only, plural getters only; tools never read the UI
 * selection), else `fallback`, else My Library.
 */
export function defaultTarget(fallback?: AddTarget | null): AddTarget {
  try {
    const pane = Zotero.getActiveZoteroPane() as any;
    const collections = pane?.getSelectedCollections?.() ?? [];
    if (collections.length === 1 && editable(collections[0].libraryID)) {
      return {
        libraryID: collections[0].libraryID,
        collection: collections[0].key,
      };
    }
    const libraries: number[] = pane?.getSelectedLibraryIDs?.() ?? [];
    if (!fallback && libraries.length === 1 && editable(libraries[0])) {
      return { libraryID: libraries[0], collection: ROOT };
    }
  } catch (e) {
    Zotero.logError(e as Error);
  }
  if (fallback && editable(fallback.libraryID)) return fallback;
  return { libraryID: Zotero.Libraries.userLibraryID, collection: ROOT };
}

function editable(libraryID: number): boolean {
  const lib = Zotero.Libraries.get(libraryID);
  return !!lib && lib.editable && lib.libraryType !== "feed";
}

/** Badge state per paper: item key, null (not in library) or unchecked. */
export class LibraryBadges {
  private cache = new Map<string, string | null>();
  private run = 0;

  constructor(private onUpdate: () => void) {}

  get(libraryID: number, p: S2Paper): string | null | undefined {
    return this.cache.get(`${libraryID}:${p.paperId}`);
  }

  clear() {
    this.cache.clear();
    this.run++;
  }

  /**
   * Looks the papers up locally (no S2 calls), 25 at a time, yielding
   * between chunks so a 1,000-paper bulk page doesn't freeze the window.
   */
  async check(libraryID: number, papers: readonly S2Paper[]) {
    const run = ++this.run;
    const todo = papers.filter(
      (p) => !this.cache.has(`${libraryID}:${p.paperId}`),
    );
    for (let i = 0; i < todo.length; i += 25) {
      for (const p of todo.slice(i, i + 25)) {
        let key: string | null = null;
        try {
          key = (await findExisting(libraryID, idsFromPaper(p)))?.key ?? null;
        } catch (e) {
          Zotero.logError(e as Error);
        }
        if (run !== this.run) return;
        this.cache.set(`${libraryID}:${p.paperId}`, key);
      }
      this.onUpdate();
      await Zotero.Promise.delay(0);
      if (run !== this.run) return;
    }
  }
}

export interface AddHost {
  doc: Document;
  /** False once the window has closed. */
  readonly alive: boolean;
  selectedPapers(): S2Paper[];
  setOutcome(paperId: string, text: string): void;
  showHint(text: string | null): void;
  showError(text: string | null): void;
  afterAdd(): void;
  targetChanged(): void;
}

interface AddResultRow {
  id: string;
  itemKey?: string;
  existing?: boolean;
  pdf?: string;
  error?: string;
}

/** The bottom bar: target library/collection, options and the Add button. */
export class AddBar {
  adding = false;

  constructor(private host: AddHost) {
    const $ = this.$;
    $("library").addEventListener("command", () => {
      this.fillCollections(ROOT);
      host.targetChanged();
    });
    $("collection").addEventListener("command", () => {
      $("new-collection").hidden = this.collectionValue() !== NEW;
      if (!$("new-collection").hidden) $("new-collection").focus();
    });
    $("add").addEventListener("click", () => this.add());
  }

  private $ = <T = any>(id: string): T =>
    this.host.doc.getElementById(`s2-${id}`) as T;

  private collectionValue(): string {
    return this.$<any>("collection").value ?? ROOT;
  }

  get libraryID(): number {
    return Number(this.$<any>("library").value);
  }

  /** The current target; a new collection reports its typed path. */
  target(): AddTarget & { create?: string } {
    const value = this.collectionValue();
    return value === NEW
      ? {
          libraryID: this.libraryID,
          collection: ROOT,
          create: this.$<HTMLInputElement>("new-collection").value.trim(),
        }
      : { libraryID: this.libraryID, collection: value };
  }

  setTarget(t: AddTarget) {
    const libraries = Zotero.Libraries.getAll().filter((l) =>
      editable(l.libraryID),
    );
    const menu = this.$<any>("library");
    menu.removeAllItems();
    for (const lib of libraries)
      menu.appendItem(lib.name, String(lib.libraryID));
    menu.value = String(
      libraries.some((l) => l.libraryID === t.libraryID)
        ? t.libraryID
        : Zotero.Libraries.userLibraryID,
    );
    this.fillCollections(t.collection);
  }

  private fillCollections(selected: string) {
    const menu = this.$<any>("collection");
    menu.removeAllItems();
    menu.appendItem(getString("gui-library-root"), ROOT);
    const collections = listCollections(this.libraryID);
    for (const c of collections) {
      menu.appendItem(c.path.split("/").join(" › "), c.key);
    }
    menu.appendItem(getString("gui-new-collection"), NEW);
    menu.value = collections.some((c) => c.key === selected) ? selected : ROOT;
    this.$("new-collection").hidden = true;
  }

  options() {
    return {
      tags: this.$<HTMLInputElement>("tags").value,
      metadata: this.$<any>("metadata").value || "s2",
      attachPdf: this.$<HTMLInputElement>("attach-pdf").checked,
    };
  }

  setOptions(o: { tags?: string; metadata?: string; attachPdf?: boolean }) {
    if (o.tags !== undefined) this.$<HTMLInputElement>("tags").value = o.tags;
    if (o.metadata) this.$<any>("metadata").value = o.metadata;
    if (o.attachPdf !== undefined)
      this.$<HTMLInputElement>("attach-pdf").checked = o.attachPdf;
  }

  /** Button label and the 25-per-add cap, shared with agents. */
  render() {
    const count = this.host.selectedPapers().length;
    const button = this.$<HTMLButtonElement>("add");
    button.textContent = getString("gui-add-button", { args: { count } });
    const tooMany = count > MAX_ADD;
    button.disabled = this.adding || count === 0 || tooMany;
    this.$("add-hint").textContent = tooMany
      ? getString("gui-add-too-many", { args: { max: MAX_ADD } })
      : "";
  }

  async add() {
    const papers = this.host.selectedPapers();
    if (this.adding || !papers.length || papers.length > MAX_ADD) return;
    const target = this.target();
    if (target.create === "") {
      this.host.showError(getString("gui-add-new-collection-empty"));
      return;
    }
    const { tags, metadata, attachPdf } = this.options();
    this.adding = true;
    this.render();
    this.host.showError(null);
    this.host.showHint(
      getString("gui-adding", { args: { count: papers.length } }),
    );
    const outcome = await callTool("zotero_add_papers", {
      ids: papers.map((p) => p.paperId),
      collection: target.create || target.collection || undefined,
      create_collection: !!target.create,
      attach_pdf: attachPdf,
      tags: tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      metadata_source: metadata,
      library_id: target.libraryID,
    });
    this.adding = false;
    // The add finished (items are saved) after the window closed
    if (!this.host.alive) return;
    if (!outcome.ok) {
      this.host.showHint(null);
      this.host.showError(outcome.message);
      this.render();
      return;
    }
    const value = outcome.value as {
      collection: { key: string; created: boolean } | null;
      summary: {
        added: number;
        existing: number;
        failed: number;
        pdfAttached: number;
      };
      results: AddResultRow[];
    };
    for (const row of value.results) {
      this.host.setOutcome(row.id, describeOutcome(row));
    }
    const s = value.summary;
    this.host.showHint(
      getString("gui-add-summary", {
        args: {
          added: s.added,
          existing: s.existing,
          failed: s.failed,
          pdfs: s.pdfAttached,
        },
      }),
    );
    if (value.collection?.created || target.create) {
      this.fillCollections(value.collection?.key ?? ROOT);
    }
    this.host.afterAdd();
    this.render();
  }
}

export function describeOutcome(row: AddResultRow): string {
  if (row.error)
    return getString("gui-outcome-failed", { args: { error: row.error } });
  const parts = [
    getString(row.existing ? "gui-outcome-existing" : "gui-outcome-added"),
  ];
  if (row.pdf)
    parts.push(getString("gui-outcome-pdf", { args: { status: row.pdf } }));
  return parts.join(" · ");
}
