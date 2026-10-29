import { config } from "../../package.json";

export const WINDOW_TYPE = `${config.addonRef}:search`;
const URL = `chrome://${config.addonRef}/content/search.xhtml`;

const controllers = new WeakMap<Window, { destroy(): void }>();

/** Focuses the search window, opening it first if needed. One per session. */
export function openSearchWindow(): Window | null {
  const existing = Services.wm.getMostRecentWindow(
    WINDOW_TYPE,
  ) as unknown as Window | null;
  if (existing) {
    existing.focus();
    return existing;
  }
  const parent = Zotero.getMainWindow();
  if (!parent) return null;
  return parent.openDialog(
    URL,
    `${config.addonRef}-search`,
    "chrome,resizable,centerscreen,dialog=no",
  );
}

export function searchWindows(): Window[] {
  const out: Window[] = [];
  const it = Services.wm.getEnumerator(WINDOW_TYPE);
  while (it.hasMoreElements()) out.push(it.getNext() as unknown as Window);
  return out;
}

/** Closes every search window, so none keeps running unloaded plugin code. */
export function closeSearchWindows() {
  for (const win of searchWindows()) win.close();
}

export function onSearchWindowLoad(win: Window) {
  controllers.set(win, { destroy() {} });
}

export function onSearchWindowUnload(win: Window) {
  controllers.get(win)?.destroy();
  controllers.delete(win);
}
