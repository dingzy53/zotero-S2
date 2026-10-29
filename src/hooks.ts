import { initLocale } from "./utils/locale";
import { createZToolkit } from "./utils/ztoolkit";
import { onPrefsLoad, registerPrefsPane } from "./modules/preferences";
import {
  ensureToken,
  registerEndpoints,
  unregisterEndpoints,
} from "./http/endpoints";
import { addFTL, registerMenu, removeFTL, unregisterMenu } from "./gui/menu";
import {
  closeSearchWindows,
  onSearchWindowLoad,
  onSearchWindowUnload,
} from "./gui/searchWindow";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  ensureToken();
  await registerPrefsPane();
  registerEndpoints();
  registerMenu();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();
  addFTL(win);
}

async function onMainWindowUnload(_win: Window): Promise<void> {
  ztoolkit.unregisterAll();
}

function onShutdown(): void {
  unregisterEndpoints();
  closeSearchWindows();
  unregisterMenu();
  for (const win of Zotero.getMainWindows()) removeFTL(win);
  ztoolkit.unregisterAll();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      onPrefsLoad(data.window);
      break;
    default:
      return;
  }
}

async function onSearchWindowEvent(
  type: "load" | "unload",
  data: { window: Window },
) {
  if (type === "load") onSearchWindowLoad(data.window);
  else onSearchWindowUnload(data.window);
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onPrefsEvent,
  onSearchWindowEvent,
};
