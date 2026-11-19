import { config } from "../../package.json";

/**
 * The stdio bridge (`addon/content/bridge/zotero-s2-mcp.mjs`) is a Node
 * script an MCP client starts itself, so the tools exist even when Zotero is
 * opened after the agent session. A client needs a real file to run, and an
 * .xpi is a zip, so we keep a copy in the Zotero data directory.
 */

const FILE = "zotero-s2-mcp.mjs";

export function bridgePath(
  dataDirectory: string = Zotero.DataDirectory.dir,
): string {
  return PathUtils.join(dataDirectory, "zotero-s2", FILE);
}

/**
 * Writes the packaged bridge to `bridgePath()` unless that copy is current.
 * The path is in commands users have already pasted, so every plugin update
 * must refresh the file there.
 */
export async function installBridge(
  dataDirectory: string = Zotero.DataDirectory.dir,
): Promise<void> {
  const url =
    typeof rootURI !== "undefined"
      ? `${rootURI}content/bridge/${FILE}`
      : `chrome://${config.addonRef}/content/bridge/${FILE}`;
  // getResourceAsync opens the channel directly; getContentsFromURLAsync goes
  // through HTTP URI parsing and fails on packed jar:file://… .xpi URIs.
  const source = await Zotero.File.getResourceAsync(url);
  const path = bridgePath(dataDirectory);
  try {
    if ((await IOUtils.readUTF8(path)) === source) return;
  } catch {
    // Not there yet
  }
  await IOUtils.makeDirectory(PathUtils.parent(path)!, {
    createAncestors: true,
  });
  await IOUtils.writeUTF8(path, source, { tmpPath: `${path}.tmp` });
}

/** `claude mcp add` for the bridge; the URL is given only when it isn't the default. */
export function bridgeCommand(token: string, endpoint: string): string {
  const env = [`-e ZOTERO_S2_TOKEN=${token}`];
  if (endpoint !== "http://127.0.0.1:23119/s2/mcp") {
    env.push(`-e ZOTERO_S2_URL=${endpoint}`);
  }
  return `claude mcp add zotero-s2 ${env.join(" ")} -- node "${bridgePath()}"`;
}
