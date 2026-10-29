import type { S2Paper } from "../s2/types";
import { getString } from "../utils/locale";
import {
  PaperActions,
  actionButtons,
  authorsList,
  link,
  metaLine,
  s2Link,
} from "./detail";
import { el } from "./dom";
import type { ResultsView, ViewHost } from "./view";

/** Cards are heavier than rows, so a 1,000-paper bulk page renders in steps. */
const BATCH = 100;

interface Card {
  node: HTMLElement;
  box: HTMLInputElement;
  badge: HTMLElement;
  outcome: HTMLElement;
  actions: HTMLElement;
  paper: S2Paper;
}

/** Scholar-style cards; the checkbox on each card is its selection. */
export class ResultsCards implements ResultsView {
  private papers: readonly S2Paper[] = [];
  private shown = 0;
  private cards = new Map<string, Card>();
  private list: HTMLElement | null = null;
  private moreButton: HTMLButtonElement | null = null;

  constructor(
    private host: ViewHost,
    private container: HTMLElement,
    private actions: PaperActions,
  ) {}

  destroy() {
    this.container.replaceChildren();
  }

  render(papers: readonly S2Paper[]) {
    const doc = this.host.doc;
    this.papers = papers;
    this.cards.clear();
    this.shown = 0;
    this.list = el(doc, "div", { class: "s2-cards" });
    this.moreButton = el(doc, "button", {
      class: "s2-cards-more",
      text: getString("gui-cards-more"),
    });
    this.moreButton.addEventListener("click", () => this.renderBatch());
    this.container.replaceChildren(this.list, this.moreButton);
    this.renderBatch();
  }

  private renderBatch() {
    const end = Math.min(this.papers.length, this.shown + BATCH);
    for (const p of this.papers.slice(this.shown, end)) {
      const card = this.card(p);
      this.cards.set(p.paperId, card);
      this.list!.append(card.node);
    }
    this.shown = end;
    this.moreButton!.hidden = this.shown >= this.papers.length;
    this.refresh();
  }

  private card(p: S2Paper): Card {
    const doc = this.host.doc;
    const box = el(doc, "input", {
      type: "checkbox",
      class: "s2-card-check",
      title: getString("gui-card-select"),
    });
    box.addEventListener("change", () => {
      if (box.checked) this.host.selection.add(p.paperId);
      else this.host.selection.delete(p.paperId);
      this.host.focused = p.paperId;
      this.refresh();
      this.host.onSelectionChange();
    });
    const title = link(doc, p.title ?? "", s2Link(p));
    title.classList.add("s2-card-title");

    const abstract = el(doc, "p", {
      class: p.abstract ? "s2-abstract s2-clamp" : "s2-abstract s2-muted",
      text: p.abstract || getString("gui-no-abstract"),
    });
    const toggle =
      p.abstract && p.abstract.length > 280
        ? el(doc, "button", {
            class: "s2-more-toggle",
            text: getString("gui-abstract-more"),
          })
        : null;
    toggle?.addEventListener("click", () => {
      const open = abstract.classList.toggle("s2-clamp");
      toggle.textContent = getString(
        open ? "gui-abstract-more" : "gui-abstract-less",
      );
    });

    const badge = el(doc, "span", {
      class: "s2-badge-line",
      text: getString("gui-in-library"),
    });
    const outcome = el(doc, "span", { class: "s2-outcome" });
    const actions = el(doc, "div");
    const node = el(
      doc,
      "article",
      { class: "s2-card", "data-id": p.paperId },
      [
        box,
        el(doc, "div", { class: "s2-card-body" }, [
          el(doc, "div", {}, [title, " ", badge, " ", outcome]),
          authorsList(doc, p, this.actions),
          el(doc, "div", { class: "s2-meta", text: metaLine(p) }),
          abstract,
          toggle,
          actions,
        ]),
      ],
    );
    return { node, box, badge, outcome, actions, paper: p };
  }

  refresh() {
    for (const [id, card] of this.cards) {
      const selected = this.host.selection.has(id);
      card.box.checked = selected;
      card.node.setAttribute("aria-selected", String(selected));
      const key = this.host.inLibrary(card.paper);
      card.badge.hidden = !key;
      const outcome = this.host.outcome(card.paper);
      card.outcome.hidden = !outcome;
      card.outcome.textContent = outcome ?? "";
      // Rebuilt so "Show in Zotero" follows the in-library state
      card.actions.replaceWith(
        (card.actions = actionButtons(
          this.host.doc,
          card.paper,
          this.actions,
          key,
        )),
      );
    }
  }
}
