import { assert } from "chai";
import { config } from "../package.json";
import { FIXTURES } from "./fixtures";
import { fixtureClient } from "./helpers";

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
async function openWindow(calls: string[] = []) {
  api().guiDeps.s2 = () => fixtureClient(undefined, calls);
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
});
