/**
 * The stdio bridge (`addon/content/bridge/zotero-s2-mcp.mjs`) is a Node
 * script an MCP client starts itself, so the tools exist even when Zotero is
 * opened after the agent session. A client needs a real file to run, and an
 * .xpi is a zip, so we keep a copy in the Zotero data directory.
 */

const FILE = "zotero-s2-mcp.mjs";

export function bridgePath(): string {
  return PathUtils.join(Zotero.DataDirectory.dir, "zotero-s2", FILE);
}

/**
 * Writes the packaged bridge to `bridgePath()` unless that copy is current.
 * The path is in commands users have already pasted, so every plugin update
 * must refresh the file there.
 */
export async function installBridge(): Promise<void> {
  const source = await Zotero.File.getContentsFromURLAsync(
    `${rootURI}content/bridge/${FILE}`,
  );
  const path = bridgePath();
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
