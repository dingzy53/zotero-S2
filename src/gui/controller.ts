import { config } from "../../package.json";
import { FluentMessageId } from "../../typings/i10n";
import { getPrefsPaneID } from "../modules/preferences";
import { GUI_FIELDS } from "../s2/fields";
import type { S2Paper } from "../s2/types";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { errorMessage } from "../mcp/errors";
import { callTool } from "./deps";
import { el } from "./dom";
import {
  FIELDS_OF_STUDY,
  Filters,
  MODES,
  Mode,
  PUBLICATION_TYPES,
  Paging,
  S2AuthorRow,
  RELEVANCE_CAP,
  SearchForm,
  ToolRequest,
  authorsFromResult,
  canNext,
  canPrev,
  emptyFilters,
  pageArgs,
  pageRange,
  pagingFromResult,
  papersFromResult,
  planSearch,
} from "./model";
import { AddBar, AddHost, LibraryBadges, defaultTarget } from "./addBar";
import { PaperActions, RelatedKind, renderDetail } from "./detail";
import { EXTENSIONS, ExportFormat, joinBibtex, toCSV, toRIS } from "./export";
import { ResultsCards } from "./resultsCards";
import { ResultsTable } from "./resultsTable";
import type { ResultsView, ViewHost } from "./view";
import {
  GuiState,
  loadHistory,
  loadState,
  recordHistory,
  saveState,
} from "./state";
import { newFilePicker } from "../zotero/apis";

/** One screen of results; related navigation pushes more of these. */
export interface ResultSet {
  label: string;
  request: ToolRequest;
  paging: Paging;
  papers: S2Paper[];
  /** Author search results; a set has either papers or authors. */
  authors?: S2AuthorRow[];
  selection: Set<string>;
  focused: string | null;
  scrollTop: number;
}

const WAITING_AFTER_MS = 1500;

export type ViewKind = "table" | "cards";

export class SearchController implements ViewHost, AddHost {
  readonly doc: Document;
  mode: Mode = "simple";
  stack: ResultSet[] = [];
  busy = false;
  /** False once the window closes; checked after every await. */
  alive = true;
  private generation = 0;
  viewKind: ViewKind = "table";
  private view!: ResultsView;
  private noSelection = new Set<string>();
  private prefObserver: symbol;
  readonly actions: PaperActions = {
    showInZotero: (p) => this.showInZotero(p),
    related: (p, kind) => this.related(p, kind),
    author: (id, name) => this.authorPapers(id, name),
  };
  readonly addBar: AddBar;
  private badges = new LibraryBadges(() => this.refreshMarks());
  private outcomes = new Map<string, string>();

  constructor(readonly win: Window) {
    this.doc = win.document;
    this.buildFilterGrids();
    this.bind();
    this.addBar = new AddBar(this);
    const state = loadState();
    this.addBar.setTarget(defaultTarget(state.target));
    this.addBar.setOptions(state);
    this.setMode(state.mode);
    this.$<HTMLInputElement>("query").value = state.query;
    this.setFilters(state.filters);
    if (state.sort) (this.$("sort") as any).value = state.sort;
    this.setView(getPref("resultsView") === "cards" ? "cards" : "table");
    this.prefObserver = Zotero.Prefs.registerObserver(
      `${config.prefsPrefix}.resultsView`,
      (value: string) => this.setView(value === "cards" ? "cards" : "table"),
      true,
    );
    this.$<HTMLInputElement>("query").focus();
  }

  destroy() {
    if (!this.alive) return;
    this.alive = false;
    this.saveState();
    // Stops in-library checks that would redraw a closed window
    this.badges.clear();
    // Responses still in flight must not touch a closed window
    this.generation++;
    Zotero.Prefs.unregisterObserver(this.prefObserver);
    this.view.destroy();
  }

  /** Switches between the table + detail pane and the card list. */
  setView(kind: ViewKind) {
    if (this.view && kind === this.viewKind) return;
    this.view?.destroy();
    this.viewKind = kind;
    this.$("root").dataset.view = kind;
    for (const b of this.doc.querySelectorAll<HTMLElement>("[data-view]")) {
      b.setAttribute("aria-checked", String(b.dataset.view === kind));
    }
    const results = this.$("results");
    this.view =
      kind === "cards"
        ? new ResultsCards(this, results, this.actions)
        : new ResultsTable(this, results);
    this.renderAll();
  }

  $<T extends HTMLElement = HTMLElement>(id: string): T {
    return this.doc.getElementById(`s2-${id}`) as T;
  }

  get current(): ResultSet | undefined {
    return this.stack[this.stack.length - 1];
  }

  // --- ViewHost ---

  get selection(): Set<string> {
    return this.current?.selection ?? this.noSelection;
  }

  get focused(): string | null {
    return this.current?.focused ?? null;
  }

  set focused(id: string | null) {
    if (this.current) this.current.focused = id;
  }

  inLibrary(paper: S2Paper): string | null | undefined {
    return this.badges.get(this.addBar.libraryID, paper);
  }

  outcome(paper: S2Paper): string | undefined {
    return this.outcomes.get(paper.paperId);
  }

  onSelectionChange() {
    this.renderStatus();
    this.renderDetail();
    this.addBar.render();
  }

  // --- AddHost ---

  selectedPapers(): S2Paper[] {
    const current = this.current;
    if (!current) return [];
    return current.papers.filter((p) => current.selection.has(p.paperId));
  }

  setOutcome(paperId: string, text: string) {
    this.outcomes.set(paperId, text);
  }

  afterAdd() {
    this.badges.clear();
    this.checkBadges();
  }

  targetChanged() {
    this.refreshMarks();
    this.checkBadges();
  }

  private checkBadges() {
    const current = this.current;
    if (current) this.badges.check(this.addBar.libraryID, current.papers);
  }

  private refreshMarks() {
    this.view.refresh();
    this.renderDetail();
  }

  private showInZotero(p: S2Paper) {
    const key = this.inLibrary(p);
    if (!key) return;
    const item = Zotero.Items.getByLibraryAndKey(this.addBar.libraryID, key);
    if (!item) return;
    const win = Zotero.getMainWindow();
    (Zotero.getActiveZoteroPane() as any)?.selectItem(item.id);
    win?.focus();
  }

  onOpen(paper: S2Paper) {
    if (paper.url) Zotero.launchURL(paper.url);
  }

  // --- form ---

  private bind() {
    for (const button of this.doc.querySelectorAll<HTMLElement>(
      ".s2-modes [data-mode]",
    )) {
      button.addEventListener("click", () =>
        this.setMode(button.dataset.mode as Mode),
      );
    }
    this.$("search").addEventListener("click", () => this.search());
    this.$("query").addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.search();
      }
    });
    for (const b of this.doc.querySelectorAll<HTMLElement>("[data-view]")) {
      b.addEventListener("click", () =>
        setPref("resultsView", b.dataset.view === "cards" ? "cards" : "table"),
      );
    }
    this.$("filters-reset").addEventListener("click", () =>
      this.setFilters(emptyFilters()),
    );
    this.$("prev").addEventListener("click", () => this.page("prev"));
    this.$("next").addEventListener("click", () => this.page("next"));
    this.$("more").addEventListener("click", () => this.page("next"));
    this.$("back").addEventListener("click", () => this.goBack());
    this.$("history-popup").addEventListener("popupshowing", () =>
      this.fillHistory(),
    );
    for (const item of this.$("export-popup").querySelectorAll<HTMLElement>(
      "[data-format]",
    )) {
      item.addEventListener("command", () =>
        this.export(
          item.dataset.format as ExportFormat,
          item.dataset.copy === "true",
        ),
      );
    }
    this.$("pool").addEventListener("command", () =>
      this.setPool((this.$("pool") as any).value),
    );
    this.$("open-settings").addEventListener("click", () =>
      Zotero.Utilities.Internal.openPreferences(getPrefsPaneID() ?? ""),
    );
  }

  private buildFilterGrids() {
    const grid = (id: string, values: readonly string[]) => {
      this.$(id).replaceChildren(
        ...values.map((value) =>
          el(this.doc, "label", { class: "s2-check" }, [
            el(this.doc, "input", { type: "checkbox", value }),
            el(this.doc, "span", {
              // "JournalArticle" → "Journal Article"
              text: value.replace(/([a-z])([A-Z])/g, "$1 $2"),
            }),
          ]),
        ),
      );
    };
    grid("fields-of-study", FIELDS_OF_STUDY);
    grid("publication-types", PUBLICATION_TYPES);
  }

  setMode(mode: Mode) {
    if (!MODES.includes(mode)) mode = "simple";
    this.mode = mode;
    for (const button of this.doc.querySelectorAll<HTMLElement>(
      ".s2-modes [data-mode]",
    )) {
      button.setAttribute(
        "aria-selected",
        String(button.dataset.mode === mode),
      );
    }
    const filters = this.$("filters");
    filters.hidden = mode !== "advanced" && mode !== "bulk";
    filters.dataset.mode = mode;
    const suffix =
      mode === "bulk" ? "-bulk" : mode === "authors" ? "-authors" : "";
    this.doc.l10n?.setAttributes(
      this.$("query"),
      `${config.addonRef}-search-query${suffix}`,
    );
  }

  private checked(id: string): string[] {
    return [
      ...this.$(id).querySelectorAll<HTMLInputElement>("input:checked"),
    ].map((i) => i.value);
  }

  readFilters(): Filters {
    const v = (id: string) => this.$<HTMLInputElement>(id).value;
    return {
      yearFrom: v("year-from"),
      yearTo: v("year-to"),
      dateFrom: v("date-from"),
      dateTo: v("date-to"),
      venue: v("venue"),
      fieldsOfStudy: this.checked("fields-of-study"),
      publicationTypes: this.checked("publication-types"),
      minCitations: v("min-citations"),
      openAccess: this.$<HTMLInputElement>("open-access").checked,
    };
  }

  setFilters(f: Filters) {
    const set = (id: string, value: string) =>
      (this.$<HTMLInputElement>(id).value = value);
    set("year-from", f.yearFrom);
    set("year-to", f.yearTo);
    set("date-from", f.dateFrom);
    set("date-to", f.dateTo);
    set("venue", f.venue);
    set("min-citations", f.minCitations);
    this.$<HTMLInputElement>("open-access").checked = f.openAccess;
    for (const [id, values] of [
      ["fields-of-study", f.fieldsOfStudy],
      ["publication-types", f.publicationTypes],
    ] as const) {
      for (const box of this.$(id).querySelectorAll<HTMLInputElement>(
        "input",
      )) {
        box.checked = values.includes(box.value);
      }
    }
  }

  readForm(): SearchForm {
    return {
      mode: this.mode,
      query: this.$<HTMLInputElement>("query").value,
      filters: this.readFilters(),
      sort: (this.$("sort") as any).value || "",
      pageSize: Number(getPref("gui.pageSize")) || 25,
    };
  }

  // --- requests ---

  /** Runs the search in the form. Only on Enter or a click: no typeahead. */
  async search() {
    if (this.busy) return;
    const form = this.readForm();
    const plan = planSearch(form);
    this.showHint(null);
    if (plan.kind === "error") {
      this.showError(getString(`gui-error-${plan.error}` as FluentMessageId));
      return;
    }
    const label = form.query.trim();
    recordHistory({ mode: form.mode, query: label });
    this.saveState();
    const ok = await this.load(plan.request, { label, replace: true });
    if (!ok) return;
    if (plan.kind === "lookup") {
      if (!this.current?.papers.length) {
        this.showError(getString("gui-error-not-found"));
        return;
      }
      this.focused = this.current.papers[0].paperId;
      this.current.selection.add(this.focused);
      this.view.refresh();
      this.onSelectionChange();
      this.showHint(getString("gui-hint-lookup"));
    } else if (plan.rewritten) {
      this.showHint(getString("gui-hint-hyphens"));
    }
  }

  /**
   * Calls a tool and shows its papers: as a new search (`replace`), a related
   * list on top of the stack (`push`), or another page of the current set.
   */
  async load(
    request: ToolRequest,
    opts: {
      label?: string;
      replace?: boolean;
      push?: boolean;
      page?: Record<string, unknown>;
      append?: boolean;
    },
  ): Promise<boolean> {
    const gen = ++this.generation;
    this.setBusy(true);
    const waiting = this.win.setTimeout(() => {
      if (gen === this.generation && this.busy)
        this.setStatus(getString("gui-status-waiting"));
    }, WAITING_AFTER_MS);
    const outcome = await callTool(request.tool, {
      ...request.args,
      ...opts.page,
    });
    if (gen !== this.generation || !this.alive) return false;
    this.win.clearTimeout(waiting);
    this.setBusy(false);
    if (!outcome.ok) {
      this.showError(outcome.message);
      this.renderStatus();
      return false;
    }
    this.showError(null);
    const limit = Number(
      opts.page?.limit ?? request.args.limit ?? request.args.max_results ?? 0,
    );
    const papers = papersFromResult(request.tool, outcome.value);
    const authors =
      request.tool === "s2_search_authors"
        ? authorsFromResult(outcome.value)
        : undefined;
    const paging = pagingFromResult(
      request.tool,
      outcome.value,
      limit,
      Number(opts.page?.offset ?? request.args.offset ?? 0),
    );
    const current = this.current;
    if ((opts.page || opts.append) && current) {
      current.papers = opts.append ? [...current.papers, ...papers] : papers;
      current.authors = authors;
      current.paging = paging;
      if (!opts.append) {
        current.selection.clear();
        current.focused = null;
      }
    } else {
      const set: ResultSet = {
        label: opts.label ?? "",
        request,
        paging,
        papers,
        authors,
        selection: new Set(),
        focused: null,
        scrollTop: 0,
      };
      if (opts.push) {
        if (current) current.scrollTop = this.$("results").scrollTop;
        this.stack.push(set);
      } else {
        this.stack = [set];
      }
    }
    this.renderAll();
    if (!opts.append) this.$("results").scrollTop = 0;
    return true;
  }

  currentState(): GuiState {
    const form = this.readForm();
    const target = this.addBar.target();
    const options = this.addBar.options();
    return {
      mode: form.mode,
      query: form.query,
      filters: form.filters,
      sort: form.sort,
      // A typed new-collection path isn't a collection yet
      target: { libraryID: target.libraryID, collection: target.collection },
      tags: options.tags,
      metadata: options.metadata,
      attachPdf: options.attachPdf,
    };
  }

  saveState() {
    try {
      saveState(this.currentState());
    } catch (e) {
      Zotero.logError(e as Error);
    }
  }

  private fillHistory() {
    const popup = this.$("history-popup");
    popup.replaceChildren();
    const entries = loadHistory();
    if (!entries.length) {
      const item = this.doc.createXULElement("menuitem");
      item.setAttribute("label", getString("gui-history-empty"));
      item.setAttribute("disabled", "true");
      popup.append(item);
      return;
    }
    for (const entry of entries) {
      const item = this.doc.createXULElement("menuitem");
      item.setAttribute(
        "label",
        `${entry.query}  —  ${getString(`gui-mode-${entry.mode}` as FluentMessageId)}`,
      );
      item.addEventListener("command", () => {
        this.setMode(entry.mode);
        this.$<HTMLInputElement>("query").value = entry.query;
        this.search();
      });
      popup.append(item);
    }
  }

  /** The selected papers, or every loaded one when nothing is selected. */
  exportPapers(): S2Paper[] {
    const selected = this.selectedPapers();
    return selected.length ? selected : (this.current?.papers ?? []);
  }

  /** Serializes the export set; BibTeX comes from S2, 500 papers per call. */
  async exportText(
    format: ExportFormat,
  ): Promise<{ text: string; count: number; missing: number } | null> {
    const papers = this.exportPapers();
    if (!papers.length) {
      this.showError(getString("gui-export-nothing"));
      return null;
    }
    if (format === "csv")
      return { text: toCSV(papers), count: papers.length, missing: 0 };
    if (format === "ris")
      return { text: toRIS(papers), count: papers.length, missing: 0 };
    this.showHint(
      getString("gui-export-fetching", { args: { count: papers.length } }),
    );
    const rows: Array<{ id: string; paper: any }> = [];
    for (let i = 0; i < papers.length; i += 500) {
      const outcome = await callTool("s2_get_papers", {
        ids: papers.slice(i, i + 500).map((p) => p.paperId),
        fields: "citationStyles",
      });
      if (!this.alive) return null;
      if (!outcome.ok) {
        this.showHint(null);
        this.showError(outcome.message);
        return null;
      }
      rows.push(...((outcome.value as any).papers ?? []));
    }
    const { text, missing } = joinBibtex(rows);
    return {
      text,
      count: rows.length - missing.length,
      missing: missing.length,
    };
  }

  async export(format: ExportFormat, copy = false) {
    try {
      await this.exportUnguarded(format, copy);
    } catch (e) {
      // Runs from a menu command: an unhandled rejection would be invisible
      Zotero.logError(e as Error);
      if (!this.alive) return;
      this.showHint(null);
      this.showError(errorMessage(e));
    }
  }

  private async exportUnguarded(format: ExportFormat, copy: boolean) {
    this.showError(null);
    const result = await this.exportText(format);
    if (!result || !this.alive) return;
    const missing = result.missing
      ? ` ${getString("gui-export-missing", { args: { count: result.missing } })}`
      : "";
    if (copy) {
      Zotero.Utilities.Internal.copyTextToClipboard(result.text);
      this.showHint(
        getString("gui-export-copied", { args: { count: result.count } }) +
          missing,
      );
      return;
    }
    const fp = newFilePicker();
    fp.init(this.win, getString("gui-export-title"), fp.modeSave);
    const ext = EXTENSIONS[format];
    fp.defaultString = `semantic-scholar.${ext}`;
    fp.defaultExtension = ext;
    fp.appendFilter(ext.toUpperCase(), `*.${ext}`);
    const rv = await fp.show();
    if (!this.alive) return;
    if (rv !== fp.returnOK && rv !== fp.returnReplace) {
      this.showHint(null);
      return;
    }
    await IOUtils.writeUTF8(fp.file, result.text);
    if (!this.alive) return;
    this.showHint(
      getString("gui-export-saved", {
        args: { count: result.count, file: PathUtils.filename(fp.file) },
      }) + missing,
    );
  }

  private pageSize(): number {
    return Number(getPref("gui.pageSize")) || 25;
  }

  /** Citations, references or recommendations of a paper, as a new level. */
  related(p: S2Paper, kind: RelatedKind) {
    if (this.busy) return;
    const title = p.title ?? p.paperId;
    const request: ToolRequest =
      kind === "recommendations"
        ? {
            tool: "s2_recommend",
            args: {
              positive_ids: [p.paperId],
              limit: 100,
              pool: "recent",
              fields: GUI_FIELDS,
            },
          }
        : {
            tool:
              kind === "citations" ? "s2_get_citations" : "s2_get_references",
            args: {
              paper_id: p.paperId,
              limit: this.pageSize(),
              offset: 0,
              fields: GUI_FIELDS,
            },
          };
    return this.load(request, {
      push: true,
      label: getString(`gui-crumb-${kind}`, { args: { title: short(title) } }),
    });
  }

  /** An author's papers, as a new level (or the first, from author search). */
  authorPapers(authorId: string, name: string) {
    if (this.busy) return;
    return this.load(
      {
        tool: "s2_get_author_papers",
        args: {
          author_id: authorId,
          limit: this.pageSize(),
          offset: 0,
          fields: GUI_FIELDS,
        },
      },
      { push: true, label: getString("gui-author-papers", { args: { name } }) },
    );
  }

  /** Back to an earlier level, without calling S2 again. */
  goBack(level = this.stack.length - 2) {
    if (this.busy || level < 0 || level >= this.stack.length - 1) return;
    this.stack.length = level + 1;
    this.renderAll();
    this.$("results").scrollTop = this.current!.scrollTop;
  }

  async setPool(pool: string) {
    const current = this.current;
    if (!current || current.request.tool !== "s2_recommend" || this.busy)
      return;
    current.request.args.pool = pool;
    await this.load(current.request, { page: {} });
  }

  async page(dir: "next" | "prev") {
    const current = this.current;
    if (!current || this.busy) return;
    const args = pageArgs(current.paging, dir);
    if (!args) return;
    await this.load(current.request, {
      page: args,
      append: current.paging.kind === "token",
    });
  }

  // --- rendering ---

  renderAll() {
    const current = this.current;
    const results = this.$("results");
    this.renderCrumbs();
    if (current?.authors) {
      this.view.render([]);
      this.renderAuthors(current.authors);
    } else if (!current) {
      this.view.render([]);
      results.replaceChildren(
        el(this.doc, "div", {
          class: "s2-empty",
          text: getString("gui-status-ready"),
        }),
      );
    } else if (!current.papers.length) {
      this.view.render([]);
      results.replaceChildren(
        el(this.doc, "div", {
          class: "s2-empty",
          text: getString("gui-status-none"),
        }),
      );
    } else {
      this.view.render(current.papers);
      this.checkBadges();
    }
    this.renderStatus();
    this.renderDetail();
    this.addBar?.render();
  }

  private renderCrumbs() {
    const crumbs = this.$("crumbs");
    crumbs.hidden = this.stack.length < 2;
    const trail = this.$("crumb-trail");
    trail.replaceChildren();
    this.stack.forEach((set, i) => {
      if (i) trail.append(" › ");
      const last = i === this.stack.length - 1;
      const label = set.label || "…";
      if (last) {
        trail.append(el(this.doc, "strong", { text: label }));
      } else {
        const a = el(this.doc, "a", { class: "s2-link", text: label });
        a.addEventListener("click", () => this.goBack(i));
        trail.append(a);
      }
    });
    const isRecs = this.current?.request.tool === "s2_recommend";
    this.$("pool-box").hidden = !isRecs;
    if (isRecs)
      (this.$("pool") as any).value =
        this.current!.request.args.pool ?? "recent";
  }

  private renderAuthors(authors: S2AuthorRow[]) {
    const doc = this.doc;
    if (!authors.length) {
      this.$("results").replaceChildren(
        el(doc, "div", {
          class: "s2-empty",
          text: getString("gui-status-none"),
        }),
      );
      return;
    }
    const head = el(doc, "tr", {}, [
      el(doc, "th", {
        class: "s2-col-title",
        text: getString("gui-col-author"),
      }),
      el(doc, "th", { text: getString("gui-col-affiliations") }),
      el(doc, "th", {
        class: "s2-col-citations",
        text: getString("gui-col-papers"),
      }),
      el(doc, "th", {
        class: "s2-col-citations",
        text: getString("gui-col-citations"),
      }),
      el(doc, "th", {
        class: "s2-col-year",
        text: getString("gui-col-hindex"),
      }),
    ]);
    const body = el(doc, "tbody");
    for (const a of authors) {
      const tr = el(
        doc,
        "tr",
        { class: "s2-author-row", "data-id": a.authorId },
        [
          el(doc, "td", { class: "s2-col-title", text: a.name }),
          el(doc, "td", { text: (a.affiliations ?? []).join("; ") }),
          el(doc, "td", {
            class: "s2-col-citations",
            text: a.paperCount?.toLocaleString() ?? "",
          }),
          el(doc, "td", {
            class: "s2-col-citations",
            text: a.citationCount?.toLocaleString() ?? "",
          }),
          el(doc, "td", { class: "s2-col-year", text: String(a.hIndex ?? "") }),
        ],
      );
      tr.title = getString("gui-author-papers", { args: { name: a.name } });
      tr.addEventListener("click", () => this.authorPapers(a.authorId, a.name));
      body.append(tr);
    }
    this.$("results").replaceChildren(
      el(doc, "table", { class: "s2-table s2-authors-table" }, [
        el(doc, "thead", {}, [head]),
        body,
      ]),
    );
  }

  focusedPaper(): S2Paper | null {
    const current = this.current;
    if (!current?.focused) return null;
    return current.papers.find((p) => p.paperId === current.focused) ?? null;
  }

  renderDetail() {
    if (this.viewKind !== "table") return;
    const p = this.focusedPaper();
    renderDetail(
      this.doc,
      this.$("detail"),
      p,
      this.actions,
      p && this.inLibrary(p),
      p ? this.outcome(p) : undefined,
      getString(
        this.current?.authors ? "gui-detail-authors" : "gui-detail-empty",
      ),
    );
  }

  renderStatus() {
    const current = this.current;
    const prev = this.$<HTMLButtonElement>("prev");
    const next = this.$<HTMLButtonElement>("next");
    const more = this.$<HTMLButtonElement>("more");
    const paging = current?.paging ?? { kind: "none" };
    // Offset lists page; bulk token lists grow, since tokens only go forward
    prev.hidden = next.hidden = paging.kind !== "offset";
    more.hidden = paging.kind !== "token" || !paging.token;
    prev.disabled = this.busy || !canPrev(paging);
    next.disabled = more.disabled = this.busy || !canNext(paging);
    if (this.busy) return;
    if (!current) {
      this.setStatus(getString("gui-status-ready"));
      return;
    }
    const count = current.authors?.length ?? current.papers.length;
    let text: string;
    if (paging.kind === "offset" && paging.total !== undefined && count) {
      const { first, last } = pageRange(paging, count);
      const capped =
        paging.cap === RELEVANCE_CAP && paging.total > RELEVANCE_CAP;
      text = getString(
        capped ? "gui-status-range-capped" : "gui-status-range",
        { args: { first, last, total: paging.total } },
      );
    } else if (paging.kind === "token" && paging.total !== undefined) {
      text = getString("gui-status-range", {
        args: { first: count ? 1 : 0, last: count, total: paging.total },
      });
    } else {
      text = getString("gui-status-count", { args: { count } });
    }
    if (current.selection.size) {
      text += ` · ${getString("gui-status-selected", {
        args: { count: current.selection.size },
      })}`;
    }
    this.setStatus(text);
  }

  private setStatus(text: string) {
    this.$("status").textContent = text;
  }

  private setBusy(busy: boolean) {
    this.busy = busy;
    this.$<HTMLButtonElement>("search").disabled = busy;
    this.doc.documentElement?.toggleAttribute("busy", busy);
    if (busy) this.setStatus(getString("gui-status-searching"));
    this.renderStatus();
  }

  showError(message: string | null) {
    const banner = this.$("banner");
    banner.hidden = !message;
    this.$("banner-text").textContent = message ?? "";
    this.$("open-settings").hidden = !message || !/API key/i.test(message);
  }

  showHint(message: string | null) {
    const hint = this.$("hint");
    hint.hidden = !message;
    hint.textContent = message ?? "";
  }
}

function short(title: string, max = 60): string {
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}
