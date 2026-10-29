import { assert } from "chai";
import { config } from "../package.json";
import { FIXTURES } from "./fixtures";
import { fixtureClient } from "./helpers";
import type { S2Paper } from "../src/s2/types";

// The test bundle has its own copies of every module, so reach the running
// plugin's GUI through its api object
const api = () => (Zotero as any)[config.addonInstance].api;

async function waitFor<T>(
  fn: () => T | null | undefined | false,
  label: string,
  ms = 8_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms)
      throw new Error(`timed out waiting for ${label}`);
    await Zotero.Promise.delay(50);
  }
}

describe("search window: plumbing", function () {
  this.timeout(30_000);

  afterEach(async function () {
    api().closeSearchWindows();
    await waitFor(() => api().searchWindows().length === 0, "windows closed");
  });

  it("adds a labeled item to the Tools menu", async function () {
    const win = Zotero.getMainWindow();
    const doc = win.document;
    const popup = doc.getElementById("menu_ToolsPopup")!;
    Zotero.MenuManager.updateMenuPopup(popup as any, "main/menubar/tools", {
      getContext: () => ({}),
    } as any);
    const item = await waitFor(
      () =>
        popup.querySelector(
          `[data-l10n-id="${config.addonRef}-menu-search"]`,
        ) as XULElement | null,
      "menu item",
    );
    await doc.l10n!.translateElements([item as unknown as Element]);
    assert.match(item.getAttribute("label") ?? "", /Semantic Scholar/);
  });

  it("opens one window and focuses it on a second open", async function () {
    const first = api().openSearchWindow() as Window;
    await waitFor(
      () => first.document?.readyState === "complete",
      "window loaded",
    );
    const second = api().openSearchWindow() as Window;
    assert.strictEqual(second, first);
    assert.lengthOf(api().searchWindows(), 1);
    await waitFor(() => first.document.title, "window title");
    assert.match(first.document.title, /Semantic Scholar/);
  });
});

/** Opens the window with S2 served from fixtures. */
async function openWindow(calls: string[] = [], papers?: S2Paper[]) {
  api().guiDeps.s2 = () => fixtureClient(papers, calls);
  const win = api().openSearchWindow() as Window;
  const ctl = await waitFor(() => api().controllerFor(win), "controller");
  return { win, doc: win.document, ctl };
}

function setQuery(doc: Document, query: string) {
  (doc.getElementById("s2-query") as HTMLInputElement).value = query;
}

const rows = (doc: Document) =>
  [...doc.querySelectorAll(".s2-table tbody tr")] as HTMLElement[];

describe("search window: searching", function () {
  this.timeout(30_000);
  let restore: any;

  before(function () {
    restore = api().guiDeps.s2;
  });

  afterEach(async function () {
    api().closeSearchWindows();
    await waitFor(() => api().searchWindows().length === 0, "windows closed");
    api().guiDeps.s2 = restore;
  });

  it("runs a simple search into the table and logs it as gui", async function () {
    const calls: string[] = [];
    const { doc } = await openWindow(calls);
    setQuery(doc, "self-attention");
    (doc.getElementById("s2-search") as HTMLButtonElement).click();
    await waitFor(() => rows(doc).length === FIXTURES.length, "rows");
    assert.include(rows(doc)[0].textContent, FIXTURES[0].title!);
    assert.match(calls[0], /\/paper\/search\?.*query=self(\+|%20)attention/);
    assert.isFalse(doc.getElementById("s2-hint")!.hidden, "hyphen hint");
    const entry = api().getActivity()[0];
    assert.equal(entry.via, "gui");
    assert.equal(entry.tool, "s2_search_papers");
  });

  it("selects rows with click, ctrl-click and shift-click", async function () {
    const { doc, ctl } = await openWindow();
    setQuery(doc, "attention");
    await ctl.search();
    const r = rows(doc);
    const down = (el: Element, opts: MouseEventInit = {}) =>
      el.dispatchEvent(
        new (doc.defaultView as any).MouseEvent("mousedown", {
          bubbles: true,
          ...opts,
        }),
      );
    down(r[0]);
    assert.equal(ctl.selection.size, 1);
    down(r[2], { shiftKey: true });
    assert.equal(ctl.selection.size, 3);
    down(r[1], { ctrlKey: true });
    assert.equal(ctl.selection.size, 2);
    assert.equal(r[1].getAttribute("aria-selected"), "false");
    assert.match(doc.getElementById("s2-status")!.textContent!, /2 selected/);
  });

  it("looks up a typed DOI instead of searching", async function () {
    const calls: string[] = [];
    const { doc, ctl } = await openWindow(calls);
    setQuery(doc, "10.1038/nature14539");
    await ctl.search();
    assert.lengthOf(rows(doc), 1);
    assert.match(calls[0], /POST .*\/paper\/batch/);
    assert.equal(ctl.selection.size, 1);
  });

  it("validates advanced filters before calling S2", async function () {
    const calls: string[] = [];
    const { doc, ctl } = await openWindow(calls);
    ctl.setMode("advanced");
    assert.isFalse(doc.getElementById("s2-filters")!.hidden);
    setQuery(doc, "attention");
    (doc.getElementById("s2-year-from") as HTMLInputElement).value = "2020";
    (doc.getElementById("s2-year-to") as HTMLInputElement).value = "2019";
    await ctl.search();
    assert.lengthOf(calls, 0);
    assert.isFalse(doc.getElementById("s2-banner")!.hidden);
    (doc.getElementById("s2-year-to") as HTMLInputElement).value = "";
    const box = doc.querySelector(
      '#s2-fields-of-study input[value="Computer Science"]',
    ) as HTMLInputElement;
    box.checked = true;
    await ctl.search();
    assert.isTrue(doc.getElementById("s2-banner")!.hidden);
    assert.match(calls[0], /year=2020-/);
    assert.match(calls[0], /fieldsOfStudy=Computer(\+|%20)Science/);
  });

  it("explains a missing API key with a settings button", async function () {
    const { doc, ctl } = await openWindow();
    api().guiDeps.s2 = restore;
    const key = Zotero.Prefs.get(`${config.prefsPrefix}.apiKey`, true);
    Zotero.Prefs.set(`${config.prefsPrefix}.apiKey`, "", true);
    try {
      setQuery(doc, "attention");
      await ctl.search();
      assert.match(
        doc.getElementById("s2-banner-text")!.textContent!,
        /API key/,
      );
      assert.isFalse(doc.getElementById("s2-open-settings")!.hidden);
    } finally {
      Zotero.Prefs.set(`${config.prefsPrefix}.apiKey`, key, true);
    }
  });

  it("pages bulk results with tokens and a sort", async function () {
    const calls: string[] = [];
    const { doc, ctl } = await openWindow(calls);
    ctl.setMode("bulk");
    assert.isFalse(doc.getElementById("s2-syntax")!.hidden);
    (doc.getElementById("s2-sort") as any).value = "citationCount:desc";
    setQuery(doc, '"attention" +transformer -rnn');
    await ctl.search();
    assert.lengthOf(rows(doc), 2);
    assert.match(calls[0], /\/paper\/search\/bulk\?/);
    assert.match(calls[0], /sort=citationCount%3Adesc/);
    assert.match(calls[0], /query=%22attention%22(\+|%20)%2Btransformer/);
    const more = doc.getElementById("s2-more") as HTMLButtonElement;
    assert.isFalse(more.hidden);
    assert.isTrue(doc.getElementById("s2-next")!.hidden);
    more.click();
    await waitFor(() => rows(doc).length === 3, "appended rows");
    assert.match(calls[1], /token=page2/);
    assert.isTrue(more.hidden);
  });

  it("shows details for the focused row and keeps the selection across views", async function () {
    const { doc, ctl } = await openWindow();
    Zotero.Prefs.set(`${config.prefsPrefix}.resultsView`, "table", true);
    setQuery(doc, "attention");
    await ctl.search();
    const detail = doc.getElementById("s2-detail")!;
    assert.include(detail.textContent, "Select a paper");
    const row = rows(doc).find((r) =>
      r.textContent!.includes(FIXTURES[0].title!),
    )!;
    row.dispatchEvent(
      new (doc.defaultView as any).MouseEvent("mousedown", { bubbles: true }),
    );
    assert.include(detail.textContent, FIXTURES[0].abstract!);
    assert.include(detail.textContent, "Vaswani");

    (doc.querySelector('[data-view="cards"]') as HTMLElement).click();
    assert.equal(
      Zotero.Prefs.get(`${config.prefsPrefix}.resultsView`, true),
      "cards",
    );
    await waitFor(() => doc.querySelectorAll(".s2-card").length, "cards");
    const checked = [
      ...doc.querySelectorAll<HTMLInputElement>(".s2-card-check"),
    ].filter((b) => b.checked);
    assert.lengthOf(checked, 1);
    assert.equal(
      checked[0].closest(".s2-card")!.getAttribute("data-id"),
      FIXTURES[0].paperId,
    );
    // Ticking a second card adds to the same selection
    const other = doc.querySelectorAll<HTMLInputElement>(".s2-card-check")[1];
    other.click();
    assert.equal(ctl.selection.size, 2);
    Zotero.Prefs.set(`${config.prefsPrefix}.resultsView`, "table", true);
    await waitFor(() => rows(doc).length, "table again");
    assert.lengthOf(
      rows(doc).filter((r) => r.getAttribute("aria-selected") === "true"),
      2,
    );
  });
});

describe("search window: adding", function () {
  this.timeout(60_000);
  let ROOT: string;
  let restore: any;

  before(function () {
    ROOT = `GUI Test ${Date.now()}`;
    restore = api().guiDeps.s2;
  });

  // Later suites expect the fixture papers not to be in the library yet
  after(async function () {
    const lib = Zotero.Libraries.userLibraryID;
    const ours = Zotero.Collections.getByLibrary(lib).filter((c) =>
      c.name.startsWith(ROOT),
    );
    for (const c of ours) {
      const items = c.getChildItems(false, true);
      for (const sub of Zotero.Collections.getByParent(c.id, true))
        items.push(...sub.getChildItems(false, true));
      await Zotero.Items.erase(items.map((i) => i.id));
      await c.eraseTx();
    }
  });

  afterEach(async function () {
    api().closeSearchWindows();
    await waitFor(() => api().searchWindows().length === 0, "windows closed");
    api().guiDeps.s2 = restore;
  });

  const keydown = (doc: Document, key: string, opts: KeyboardEventInit = {}) =>
    doc.getElementById("s2-results")!.dispatchEvent(
      new (doc.defaultView as any).KeyboardEvent("keydown", {
        key,
        bubbles: true,
        ...opts,
      }),
    );

  it("adds the selection to a new collection, then reports duplicates", async function () {
    const { doc, ctl } = await openWindow();
    setQuery(doc, "attention");
    await ctl.search();
    keydown(doc, "a", { ctrlKey: true });
    const add = doc.getElementById("s2-add") as HTMLButtonElement;
    assert.equal(add.textContent, `Add ${FIXTURES.length} papers`);
    assert.isFalse(add.disabled);

    const menu = doc.getElementById("s2-collection") as any;
    menu.value = "__new__";
    menu.dispatchEvent(new (doc.defaultView as any).Event("command"));
    const path = doc.getElementById("s2-new-collection") as HTMLInputElement;
    assert.isFalse(path.hidden);
    path.value = `${ROOT}/Inbox`;
    (doc.getElementById("s2-tags") as HTMLInputElement).value = "gui, s2";
    // No network in tests
    (doc.getElementById("s2-attach-pdf") as HTMLInputElement).checked = false;
    await ctl.addBar.add();

    const hint = doc.getElementById("s2-hint")!.textContent!;
    assert.match(hint, new RegExp(`^${FIXTURES.length} added, 0 already`));
    const lib = Zotero.Libraries.userLibraryID;
    const root = Zotero.Collections.getByLibrary(lib).find(
      (c) => c.name === ROOT,
    )!;
    const inbox = Zotero.Collections.getByParent(root.id)[0];
    assert.equal(inbox.name, "Inbox");
    assert.lengthOf(inbox.getChildItems(), FIXTURES.length);
    const item = inbox.getChildItems()[0];
    assert.sameMembers(
      item.getTags().map((t: any) => t.tag),
      ["gui", "s2"],
    );
    // The new collection becomes the target, and badges appear
    assert.equal(menu.value, inbox.key);
    await waitFor(
      () => rows(doc).every((r) => r.classList.contains("s2-in-library")),
      "in-library badges",
    );
    const entry = api().getActivity()[0];
    assert.equal(entry.via, "gui");
    assert.equal(entry.tool, "zotero_add_papers");

    // Showing a row's details offers "Show in Zotero"
    rows(doc)[0].dispatchEvent(
      new (doc.defaultView as any).MouseEvent("mousedown", { bubbles: true }),
    );
    assert.include(doc.getElementById("s2-detail")!.textContent, "In library");
    assert.include(
      doc.getElementById("s2-detail")!.textContent,
      "Show in Zotero",
    );

    keydown(doc, "a", { ctrlKey: true });
    await ctl.addBar.add();
    assert.match(
      doc.getElementById("s2-hint")!.textContent!,
      new RegExp(`^0 added, ${FIXTURES.length} already`),
    );
    assert.lengthOf(inbox.getChildItems(), FIXTURES.length);
  });

  it("caps an add at 25 papers", async function () {
    const many: S2Paper[] = Array.from({ length: 26 }, (_, i) => ({
      ...FIXTURES[0],
      paperId: `${i}`.padStart(40, "f"),
      title: `Paper ${i}`,
      externalIds: {},
    }));
    const { doc, ctl } = await openWindow([], many);
    Zotero.Prefs.set(`${config.prefsPrefix}.gui.pageSize`, 50, true);
    setQuery(doc, "many");
    try {
      await ctl.search();
    } finally {
      Zotero.Prefs.set(`${config.prefsPrefix}.gui.pageSize`, 25, true);
    }
    assert.lengthOf(rows(doc), 26);
    keydown(doc, "a", { ctrlKey: true });
    const add = doc.getElementById("s2-add") as HTMLButtonElement;
    assert.isTrue(add.disabled);
    assert.match(doc.getElementById("s2-add-hint")!.textContent!, /at most 25/);
    rows(doc)[0].dispatchEvent(
      new (doc.defaultView as any).MouseEvent("mousedown", { bubbles: true }),
    );
    assert.isFalse(add.disabled);
  });

  it("targets the collection selected in the main window", async function () {
    const lib = Zotero.Libraries.userLibraryID;
    const collection = new Zotero.Collection({
      libraryID: lib,
      name: `${ROOT} target`,
    } as any);
    await collection.saveTx();
    const pane = Zotero.getActiveZoteroPane() as any;
    await pane.collectionsView.selectByID(`C${collection.id}`);
    const { doc } = await openWindow();
    assert.equal((doc.getElementById("s2-library") as any).value, String(lib));
    assert.equal(
      (doc.getElementById("s2-collection") as any).value,
      collection.key,
    );
    await pane.collectionsView.selectByID(`L${lib}`);
  });
});
