import { config } from "../../package.json";
import { openSearchWindow } from "./searchWindow";

const FTL = `${config.addonRef}-mainWindow.ftl`;
let menuID: string | false = false;

/** Registered once per session; Zotero adds it to every main window. */
export function registerMenu() {
  menuID = Zotero.MenuManager.registerMenu({
    menuID: `${config.addonRef}-tools-search`,
    pluginID: config.addonID,
    target: "main/menubar/tools",
    menus: [
      {
        menuType: "menuitem",
        // Scaffold prefixes FTL files and xhtml data-l10n-id, not TS strings
        l10nID: `${config.addonRef}-menu-search`,
        icon: `chrome://${config.addonRef}/content/icons/menu.svg`,
        onCommand: () => openSearchWindow(),
      },
    ],
  });
}

export function unregisterMenu() {
  if (menuID) Zotero.MenuManager.unregisterMenu(menuID);
  menuID = false;
}

export function addFTL(win: Window) {
  (win as any).MozXULElement?.insertFTLIfNeeded(FTL);
}

export function removeFTL(win: Window) {
  win.document.querySelector(`link[href="${FTL}"]`)?.remove();
}
