import { assert } from "chai";
import { config } from "../package.json";

const prefix = `${config.prefsPrefix}.`;
const id = (s: string) => `zotero-prefpane-${config.addonRef}-${s}`;

async function waitFor<T>(
  fn: () => T | null | undefined,
  label: string,
  ms = 8_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms)
      throw new Error(`timed out waiting for ${label}`);
    await Zotero.Promise.delay(100);
  }
}

describe("settings pane", function () {
  this.timeout(30_000);
  let win: Window | null = null;

  after(function () {
    win?.close();
  });

  it("renders the endpoint, token and command, and regenerates the token", async function () {
    const pane = (Zotero.PreferencePanes as any).pluginPanes.find(
      (p: any) => p.pluginID === config.addonID,
    );
    assert.ok(pane, "pane registered");
    win = Zotero.Utilities.Internal.openPreferences(pane.id) as Window;
    // The window navigates after opening, so re-read its document each poll
    const token = await waitFor(
      () =>
        win?.document?.getElementById(id("token")) as HTMLInputElement | null,
      "token input",
    );
    await waitFor(() => token.value, "token value");
    const doc = token.ownerDocument;
    const saved = Zotero.Prefs.get(`${prefix}mcpToken`, true) as string;
    assert.equal(token.value, saved);

    const endpoint = doc.getElementById(id("endpoint")) as HTMLInputElement;
    assert.match(endpoint.value, /^http:\/\/127\.0\.0\.1:\d+\/s2\/mcp$/);
    const command = doc.getElementById(id("command")) as HTMLInputElement;
    assert.include(command.value, `Bearer ${saved}`);

    (doc.getElementById(id("regenerate")) as any).doCommand();
    const fresh = Zotero.Prefs.get(`${prefix}mcpToken`, true) as string;
    assert.notEqual(fresh, saved);
    assert.match(fresh, /^[0-9a-f]{64}$/);
    assert.equal(token.value, fresh);

    // Restore the fixed test token used by the HTTP checks
    Zotero.Prefs.set(`${prefix}mcpToken`, saved, true);

    // Search window settings: the page size stays an int pref
    const pageSize = doc.getElementById(id("page-size")) as any;
    assert.equal(pageSize.value, "25");
    pageSize.value = "50";
    pageSize.dispatchEvent(
      new (win!.document.defaultView as any).Event("command"),
    );
    assert.strictEqual(Zotero.Prefs.get(`${prefix}gui.pageSize`, true), 50);
    Zotero.Prefs.set(`${prefix}gui.pageSize`, 25, true);
    assert.equal(
      (doc.getElementById(id("view")) as any).value,
      Zotero.Prefs.get(`${prefix}resultsView`, true),
    );
  });
});
