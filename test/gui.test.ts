import { assert } from "chai";
import { config } from "../package.json";

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
