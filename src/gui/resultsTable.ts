import type { S2Paper } from "../s2/types";
import { getString } from "../utils/locale";
import { el } from "./dom";
import { SortKey, authorLine, pdfUrl, sortPapers, venueOf } from "./model";
import type { ResultsView, ViewHost } from "./view";

const COLUMNS: Array<{ key: SortKey | null; cls: string; label?: string }> = [
  { key: null, cls: "s2-col-badge" },
  { key: "title", cls: "s2-col-title", label: "gui-col-title" },
  { key: "authors", cls: "s2-col-authors", label: "gui-col-authors" },
  { key: "year", cls: "s2-col-year", label: "gui-col-year" },
  { key: "venue", cls: "s2-col-venue", label: "gui-col-venue" },
  { key: "citations", cls: "s2-col-citations", label: "gui-col-citations" },
  { key: null, cls: "s2-col-pdf", label: "gui-col-pdf" },
];

/**
 * A plain HTML table: at most 1,000 rows, so no virtualization is needed,
 * and selection stays fully under our control (shared with the card view).
 */
export class ResultsTable implements ResultsView {
  private papers: S2Paper[] = [];
  private rows = new Map<string, { tr: HTMLTableRowElement; paper: S2Paper }>();
  private sortKey: SortKey | null = null;
  private sortDesc = false;
  private anchor: string | null = null;
  private source: readonly S2Paper[] = [];
  private readonly onKey = (e: KeyboardEvent) => this.keydown(e);

  constructor(
    private host: ViewHost,
    private container: HTMLElement,
  ) {
    container.addEventListener("keydown", this.onKey);
  }

  destroy() {
    this.container.removeEventListener("keydown", this.onKey);
    this.container.replaceChildren();
  }

  render(papers: readonly S2Paper[]) {
    const doc = this.host.doc;
    this.source = papers;
    this.papers = sortPapers(papers, this.sortKey, this.sortDesc);
    this.rows.clear();

    const head = el(doc, "tr");
    for (const col of COLUMNS) {
      const th = el(doc, "th", {
        class: col.cls,
        text: col.label ? getString(col.label as any) : "",
        "data-key": col.key ?? undefined,
        "data-sort":
          col.key && col.key === this.sortKey
            ? this.sortDesc
              ? "desc"
              : "asc"
            : undefined,
      });
      if (col.key) th.addEventListener("click", () => this.sortBy(col.key!));
      head.append(th);
    }

    const body = el(doc, "tbody");
    for (const p of this.papers) {
      const pdf = pdfUrl(p);
      const tr = el(doc, "tr", { "data-id": p.paperId }, [
        el(doc, "td", { class: "s2-col-badge s2-badge" }),
        el(doc, "td", { class: "s2-col-title", text: p.title ?? "" }),
        el(doc, "td", { class: "s2-col-authors", text: authorLine(p) }),
        el(doc, "td", { class: "s2-col-year", text: String(p.year ?? "") }),
        el(doc, "td", { class: "s2-col-venue", text: venueOf(p) }),
        el(doc, "td", {
          class: "s2-col-citations",
          text: p.citationCount?.toLocaleString() ?? "",
        }),
        el(doc, "td", {
          class: "s2-col-pdf",
          text: pdf ? "PDF" : "",
          title: pdf ? getString("gui-pdf-yes", "title") : undefined,
        }),
      ]);
      tr.children[1].setAttribute("title", p.title ?? "");
      tr.addEventListener("mousedown", (e) => this.click(p, e as MouseEvent));
      tr.addEventListener("dblclick", () => this.host.onOpen(p));
      this.rows.set(p.paperId, { tr, paper: p });
      body.append(tr);
    }

    const table = el(doc, "table", { class: "s2-table" }, [
      el(doc, "thead", {}, [head]),
      body,
    ]);
    this.container.replaceChildren(table);
    this.refresh();
  }

  refresh() {
    for (const [id, { tr, paper }] of this.rows) {
      tr.setAttribute("aria-selected", String(this.host.selection.has(id)));
      const badge = tr.firstElementChild as HTMLElement;
      const key = this.host.inLibrary(paper);
      const outcome = this.host.outcome(paper);
      badge.textContent = key ? "✓" : "";
      badge.title = outcome ?? "";
      tr.classList.toggle("s2-in-library", !!key);
    }
  }

  private sortBy(key: SortKey) {
    if (this.sortKey === key) {
      // asc → desc → original order
      if (this.sortDesc) this.sortKey = null;
      this.sortDesc = !this.sortDesc;
    } else {
      this.sortKey = key;
      this.sortDesc = key === "citations" || key === "year";
    }
    if (!this.sortKey) this.sortDesc = false;
    this.render(this.source);
  }

  private click(p: S2Paper, e: MouseEvent) {
    const sel = this.host.selection;
    if (e.shiftKey && this.anchor) {
      this.selectRange(this.anchor, p.paperId, e.ctrlKey || e.metaKey);
    } else if (e.ctrlKey || e.metaKey) {
      if (sel.has(p.paperId)) sel.delete(p.paperId);
      else sel.add(p.paperId);
      this.anchor = p.paperId;
    } else {
      sel.clear();
      sel.add(p.paperId);
      this.anchor = p.paperId;
    }
    this.host.focused = p.paperId;
    this.changed();
  }

  private selectRange(from: string, to: string, keep: boolean) {
    const ids = this.papers.map((p) => p.paperId);
    const a = ids.indexOf(from);
    const b = ids.indexOf(to);
    if (a < 0 || b < 0) return;
    if (!keep) this.host.selection.clear();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++)
      this.host.selection.add(ids[i]);
  }

  private keydown(e: KeyboardEvent) {
    if (!this.papers.length) return;
    const ids = this.papers.map((p) => p.paperId);
    if ((e.ctrlKey || e.metaKey) && e.key === "a") {
      e.preventDefault();
      ids.forEach((id) => this.host.selection.add(id));
      this.changed();
      return;
    }
    if (e.key === "Enter" && this.host.focused) {
      const p = this.papers.find((x) => x.paperId === this.host.focused);
      if (p) this.host.onOpen(p);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const current = this.host.focused ? ids.indexOf(this.host.focused) : -1;
    const next = Math.max(
      0,
      Math.min(ids.length - 1, current + (e.key === "ArrowDown" ? 1 : -1)),
    );
    const id = ids[next];
    if (e.shiftKey && this.anchor) {
      this.selectRange(this.anchor, id, false);
    } else {
      this.host.selection.clear();
      this.host.selection.add(id);
      this.anchor = id;
    }
    this.host.focused = id;
    this.rows.get(id)?.tr.scrollIntoView({ block: "nearest" });
    this.changed();
  }

  private changed() {
    this.refresh();
    this.host.onSelectionChange();
  }
}
