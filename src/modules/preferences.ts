import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref, setPref } from "../utils/prefs";
import {
  MCP_PATH,
  generateToken,
  getS2Client,
  serverPort,
} from "../http/endpoints";
import { clearEntries, getEntries, onChange, record } from "../log/activity";
import { newStats } from "../s2/types";
import { errorMessage } from "../mcp/errors";

let paneID: string | undefined;

export function getPrefsPaneID() {
  return paneID;
}

export async function registerPrefsPane() {
  paneID = await Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: getString("prefs-title"),
    image: `chrome://${config.addonRef}/content/icons/favicon.png`,
  });
}

const id = (suffix: string) => `zotero-prefpane-${config.addonRef}-${suffix}`;

export function onPrefsLoad(win: Window) {
  const doc = win.document;
  const $ = <T extends Element = HTMLInputElement>(suffix: string) =>
    doc.getElementById(id(suffix)) as T | null;

  const endpoint = () => `http://127.0.0.1:${serverPort()}${MCP_PATH}`;
  const command = () =>
    `claude mcp add --transport http zotero-s2 ${endpoint()} --header "Authorization: Bearer ${getPref("mcpToken")}"`;

  const renderAccess = () => {
    $("endpoint")!.value = endpoint();
    $("token")!.value = getPref("mcpToken");
    $("command")!.value = command();
  };
  renderAccess();

  const copy = (text: string, button: Element | null) => {
    Zotero.Utilities.Internal.copyTextToClipboard(text);
    // XUL buttons read `label` as a property since Zotero 8
    const btn = button as (Element & { label?: string }) | null;
    if (btn?.label) {
      const label = btn.label;
      btn.label = getString("copied");
      win.setTimeout(() => (btn.label = label), 1200);
    }
  };
  $("copy-token")?.addEventListener("command", (e: Event) =>
    copy(getPref("mcpToken"), e.target as Element),
  );
  $("copy-command")?.addEventListener("command", (e: Event) =>
    copy(command(), e.target as Element),
  );
  $("regenerate")?.addEventListener("command", () => {
    setPref("mcpToken", generateToken());
    renderAccess();
  });

  $("test")?.addEventListener("command", async () => {
    const out = $<HTMLElement>("test-result")!;
    out.textContent = getString("test-running");
    const stats = newStats();
    const start = Date.now();
    let error: string | undefined;
    try {
      await getS2Client().searchPapers(stats, { query: "test", limit: 1 });
      out.textContent = getString("test-ok");
    } catch (e) {
      error = errorMessage(e);
      out.textContent = getString("test-failed", { args: { error } });
    }
    record({
      time: start,
      via: "prefs",
      tool: "test_api_key",
      args: {},
      durationMs: Date.now() - start,
      s2Calls: stats.s2Calls,
      retries: stats.retries,
      ok: !error,
      error,
    });
  });

  const renderLog = () => renderActivity(doc, $<HTMLElement>("log"));
  renderLog();
  $("log-clear")?.addEventListener("command", () => clearEntries());
  const unsubscribe = onChange(() => {
    if (Components.utils.isDeadWrapper(doc) || !doc.defaultView) {
      unsubscribe();
      return;
    }
    renderLog();
  });
  win.addEventListener("unload", () => unsubscribe(), { once: true });
}

function renderActivity(doc: Document, container: HTMLElement | null) {
  if (!container) return;
  container.replaceChildren();
  const entries = getEntries();
  if (!entries.length) {
    container.textContent = getString("log-empty");
    return;
  }
  const html = "http://www.w3.org/1999/xhtml";
  const el = (tag: string, text?: string, title?: string) => {
    const node = doc.createElementNS(html, tag) as HTMLElement;
    if (text !== undefined) node.textContent = text;
    if (title) node.title = title;
    return node;
  };
  const table = el("table");
  table.style.width = "100%";
  table.style.borderCollapse = "collapse";
  const head = el("tr");
  for (const key of [
    "log-col-time",
    "log-col-via",
    "log-col-tool",
    "log-col-args",
    "log-col-duration",
    "log-col-s2",
    "log-col-retries",
    "log-col-status",
  ] as const) {
    const th = el("th", getString(key));
    th.style.textAlign = "left";
    head.append(th);
  }
  table.append(head);
  for (const e of entries) {
    const row = el("tr");
    row.append(
      el("td", new Date(e.time).toLocaleTimeString()),
      el("td", e.via),
      el("td", e.tool),
      el("td", e.args.length > 60 ? `${e.args.slice(0, 57)}…` : e.args, e.args),
      el("td", `${(e.durationMs / 1000).toFixed(1)} s`),
      el("td", String(e.s2Calls)),
      el("td", String(e.retries)),
      el("td", e.ok ? "ok" : `error: ${e.error ?? ""}`, e.error),
    );
    if (!e.ok) row.style.color = "var(--accent-red, #d00)";
    table.append(row);
  }
  container.append(table);
}
