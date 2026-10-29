import { config } from "../../package.json";
import { FluentMessageId } from "../../typings/i10n";
import { getPrefsPaneID } from "../modules/preferences";
import type { S2Paper } from "../s2/types";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import { callTool } from "./deps";
import { el } from "./dom";
import {
  FIELDS_OF_STUDY,
  Filters,
  MODES,
  Mode,
  PUBLICATION_TYPES,
  Paging,
  RELEVANCE_CAP,
  SearchForm,
  ToolRequest,
  canNext,
  canPrev,
  emptyFilters,
  pageArgs,
  pageRange,
  pagingFromResult,
  papersFromResult,
  planSearch,
} from "./model";
import { PaperActions, renderDetail } from "./detail";
import { ResultsCards } from "./resultsCards";
import { ResultsTable } from "./resultsTable";
import type { ResultsView, ViewHost } from "./view";

/** One screen of results; related navigation pushes more of these. */
export interface ResultSet {
  label: string;
  request: ToolRequest;
  paging: Paging;
  papers: S2Paper[];
  selection: Set<string>;
  focused: string | null;
  scrollTop: number;
}

const WAITING_AFTER_MS = 1500;

export type ViewKind = "table" | "cards";

export class SearchController implements ViewHost {
  readonly doc: Document;
  mode: Mode = "simple";
  stack: ResultSet[] = [];
  busy = false;
  private generation = 0;
  viewKind: ViewKind = "table";
  private view!: ResultsView;
  private noSelection = new Set<string>();
  private prefObserver: symbol;
  readonly actions: PaperActions = {};

  constructor(readonly win: Window) {
    this.doc = win.document;
    this.buildFilterGrids();
    this.bind();
    this.setMode("simple");
    this.setView(getPref("resultsView") === "cards" ? "cards" : "table");
    this.prefObserver = Zotero.Prefs.registerObserver(
      `${config.prefsPrefix}.resultsView`,
      (value: string) => this.setView(value === "cards" ? "cards" : "table"),
      true,
    );
    this.$<HTMLInputElement>("query").focus();
  }

  destroy() {
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

  inLibrary(_paper: S2Paper): string | null | undefined {
    return undefined;
  }

  outcome(_paper: S2Paper): string | undefined {
    return undefined;
  }

  onSelectionChange() {
    this.renderStatus();
    this.renderDetail();
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
      this.renderDetail();
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
    this.win.clearTimeout(waiting);
    if (gen !== this.generation) return false;
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
    const paging = pagingFromResult(request.tool, outcome.value, limit);
    const current = this.current;
    if ((opts.page || opts.append) && current) {
      current.papers = opts.append ? [...current.papers, ...papers] : papers;
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
    if (!current) {
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
    }
    this.renderStatus();
    this.renderDetail();
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
    const count = current.papers.length;
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
