import type { S2Paper } from "../s2/types";
import { getString } from "../utils/locale";
import { el } from "./dom";
import { pdfUrl, venueOf } from "./model";

/** Buttons the detail pane and the cards offer for one paper. */
export interface PaperActions {
  showInZotero?(paper: S2Paper): void;
  related?(paper: S2Paper, kind: RelatedKind): void;
  author?(authorId: string, name: string): void;
}

export type RelatedKind = "citations" | "references" | "recommendations";

export function s2Link(p: S2Paper): string {
  return p.url || `https://www.semanticscholar.org/paper/${p.paperId}`;
}

function idLinks(doc: Document, p: S2Paper): HTMLElement {
  const ext = p.externalIds ?? {};
  const links: Array<[string, string]> = [];
  if (ext.DOI) links.push([`DOI ${ext.DOI}`, `https://doi.org/${ext.DOI}`]);
  if (ext.ArXiv)
    links.push([`arXiv ${ext.ArXiv}`, `https://arxiv.org/abs/${ext.ArXiv}`]);
  if (ext.PubMed)
    links.push([
      `PMID ${ext.PubMed}`,
      `https://pubmed.ncbi.nlm.nih.gov/${ext.PubMed}/`,
    ]);
  const corpus = p.corpusId ?? ext.CorpusId;
  return el(doc, "div", { class: "s2-ids" }, [
    ...links.map(([text, href]) => link(doc, text, href)),
    corpus != null && el(doc, "span", { text: `CorpusId ${corpus}` }),
  ]);
}

export function link(doc: Document, text: string, href: string) {
  const a = el(doc, "a", { text, href, class: "s2-link" });
  a.addEventListener("click", (e) => {
    e.preventDefault();
    Zotero.launchURL(href);
  });
  return a;
}

export function button(
  doc: Document,
  l10n: string,
  onClick: () => void,
  cls = "",
): HTMLButtonElement {
  const b = el(doc, "button", {
    class: cls || undefined,
    text: getString(l10n as any),
  });
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/** `venue · 2017 · 1,234 citations` */
export function metaLine(p: S2Paper): string {
  return [
    venueOf(p),
    p.publicationDate || (p.year != null ? String(p.year) : ""),
    p.citationCount != null
      ? getString("gui-citations", { args: { count: p.citationCount } })
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function actionButtons(
  doc: Document,
  p: S2Paper,
  actions: PaperActions,
  itemKey: string | null | undefined,
): HTMLElement {
  const pdf = pdfUrl(p);
  return el(doc, "div", { class: "s2-actions" }, [
    button(doc, "gui-open-s2", () => Zotero.launchURL(s2Link(p))),
    pdf && button(doc, "gui-open-pdf", () => Zotero.launchURL(pdf)),
    itemKey &&
      actions.showInZotero &&
      button(doc, "gui-show-in-zotero", () => actions.showInZotero!(p)),
    ...(actions.related
      ? (["citations", "references", "recommendations"] as const).map((kind) =>
          button(doc, `gui-related-${kind}`, () => actions.related!(p, kind)),
        )
      : []),
  ]);
}

export function authorsList(
  doc: Document,
  p: S2Paper,
  actions: PaperActions,
): HTMLElement {
  const authors = p.authors ?? [];
  return el(
    doc,
    "div",
    { class: "s2-authors" },
    authors.flatMap((a, i) => {
      const sep = i < authors.length - 1 ? ", " : "";
      if (!a.authorId || !actions.author) return [`${a.name}${sep}`];
      // No href: a click lists the author's papers here, not in a browser
      const name = el(doc, "a", {
        class: "s2-link",
        text: a.name,
        title: getString("gui-author-papers", { args: { name: a.name } }),
      });
      name.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        actions.author!(a.authorId!, a.name);
      });
      return [name, sep];
    }),
  );
}

/** The pane beside the table: everything we know about one paper. */
export function renderDetail(
  doc: Document,
  container: HTMLElement,
  p: S2Paper | null,
  actions: PaperActions,
  itemKey: string | null | undefined,
  outcome: string | undefined,
) {
  if (!p) {
    container.replaceChildren(
      el(doc, "div", {
        class: "s2-empty",
        text: getString("gui-detail-empty"),
      }),
    );
    return;
  }
  const facts = [
    p.publicationTypes?.length
      ? p.publicationTypes.join(", ").replace(/([a-z])([A-Z])/g, "$1 $2")
      : "",
    p.fieldsOfStudy?.length ? p.fieldsOfStudy.join(", ") : "",
  ].filter(Boolean);
  const parts: Array<Node | null | undefined | false | ""> = [
    el(doc, "h2", { class: "s2-detail-title", text: p.title ?? "" }),
    authorsList(doc, p, actions),
    el(doc, "div", { class: "s2-meta", text: metaLine(p) }),
    facts.length > 0 &&
      el(doc, "div", { class: "s2-meta", text: facts.join(" · ") }),
    itemKey &&
      el(doc, "div", {
        class: "s2-badge-line",
        text: getString("gui-in-library"),
      }),
    outcome && el(doc, "div", { class: "s2-outcome", text: outcome }),
    actionButtons(doc, p, actions, itemKey),
    el(doc, "p", {
      class: p.abstract ? "s2-abstract" : "s2-abstract s2-muted",
      text: p.abstract || getString("gui-no-abstract"),
    }),
    idLinks(doc, p),
  ];
  container.replaceChildren(...parts.filter((n): n is Node => !!n));
}
