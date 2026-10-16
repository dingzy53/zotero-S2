import { config, version } from "../../package.json";
import { getPref } from "../utils/prefs";
import { S2Client } from "../s2/client";
import { createMcpHandler } from "../mcp/server";
import { runTool } from "../mcp/runTool";
import { TOOLS, TOOLS_BY_NAME } from "../mcp/tools";

export const MCP_PATH = "/s2/mcp";
export const TOOLS_PATH = "/s2/tools";
const TOOL_PATH = "/s2/tools/:name";

const INSTRUCTIONS = [
  "Zotero S2: search Semantic Scholar and file papers into the user's Zotero library.",
  "Semantic Scholar is limited to 1 request/second (shared by all calls; the server queues and retries), so prefer batch tools: s2_get_papers takes up to 500 ids, zotero_add_papers up to 25.",
  "Typical flow: s2_search_papers → zotero_add_papers with ids and a collection.",
  'Collections may be given by key or slash path ("Project/Reading"); zotero_add_papers creates missing collections and reuses items already in the library.',
].join(" ");

type Reply = [number, Record<string, string>, string];

const s2 = new S2Client({ apiKey: () => getPref("apiKey") || "" });

const mcp = createMcpHandler({
  name: config.addonName,
  version,
  instructions: INSTRUCTIONS,
  tools: () => TOOLS,
  callTool: (tool, args) => runTool(tool, args, s2, "mcp"),
});

export function getS2Client(): S2Client {
  return s2;
}

function json(status: number, body: unknown): Reply {
  return [status, { "Content-Type": "application/json" }, JSON.stringify(body)];
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Common gate: enabled, no browser Origin (DNS-rebinding / CSRF), valid bearer token. */
function checkAccess(
  headers: Record<string, string | undefined>,
): Reply | null {
  if (!getPref("enable")) {
    return json(503, { error: "Zotero S2 server is disabled in settings" });
  }
  if (headers.origin !== undefined) {
    return json(403, {
      jsonrpc: "2.0",
      error: { code: -32600, message: "Origin not allowed" },
    });
  }
  const token = (getPref("mcpToken") || "").trim();
  const auth = headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!token || !m || !timingSafeEqual(m[1].trim(), token)) {
    return [
      401,
      { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
      JSON.stringify({
        error:
          "Missing or invalid bearer token (see Zotero → Settings → Zotero S2)",
      }),
    ];
  }
  return null;
}

interface ServerRequest {
  method: string;
  pathParams: Record<string, string>;
  headers: Record<string, string | undefined>;
  data: unknown;
}

function makeEndpoint(
  methods: string[],
  handle: (req: ServerRequest) => Promise<Reply>,
) {
  return class {
    supportedMethods = methods;
    supportedDataTypes = ["application/json"];
    // We reject Origin-bearing requests ourselves (403) instead of Zotero's silent drop
    allowRequestsFromUnsafeWebContent = true;

    // Single-parameter form: Zotero passes a request object and awaits [status, headers, body]
    async init(req: ServerRequest): Promise<Reply> {
      try {
        return checkAccess(req.headers) ?? (await handle(req));
      } catch (e) {
        Zotero.logError(e as Error);
        return json(500, { error: String(e) });
      }
    }
  };
}

const ENDPOINTS: Record<string, unknown> = {
  [MCP_PATH]: makeEndpoint(["GET", "POST", "DELETE"], (req) => mcp(req)),
  [TOOLS_PATH]: makeEndpoint(["GET"], async () =>
    json(200, {
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    }),
  ),
  [TOOL_PATH]: makeEndpoint(["POST"], async (req) => {
    const tool = TOOLS_BY_NAME.get(req.pathParams.name);
    if (!tool)
      return json(404, { error: `Unknown tool: ${req.pathParams.name}` });
    const outcome = await runTool(tool, req.data ?? {}, s2, "rest");
    return outcome.ok
      ? json(200, outcome.value)
      : json(400, { error: outcome.message });
  }),
};

const EXTRA_STATUS_TEXT: Record<number, string> = {
  202: "Accepted",
  401: "Unauthorized",
  405: "Method Not Allowed",
};

export function registerEndpoints() {
  const codes = Zotero.Server.responseCodes as Record<number, string>;
  for (const [code, text] of Object.entries(EXTRA_STATUS_TEXT)) {
    codes[Number(code)] ??= text;
  }
  for (const [path, endpoint] of Object.entries(ENDPOINTS)) {
    (Zotero.Server.Endpoints as Record<string, unknown>)[path] = endpoint;
  }
}

export function unregisterEndpoints() {
  for (const path of Object.keys(ENDPOINTS)) {
    delete (Zotero.Server.Endpoints as Record<string, unknown>)[path];
  }
}

export function serverPort(): number {
  try {
    return (
      (Zotero.Server as any).port ||
      Zotero.Prefs.get("httpServer.port") ||
      23119
    );
  } catch {
    return (Zotero.Prefs.get("httpServer.port") as number) || 23119;
  }
}

export function ensureToken(): string {
  let token = getPref("mcpToken");
  if (!token) {
    token = generateToken();
    Zotero.Prefs.set(`${config.prefsPrefix}.mcpToken`, token, true);
  }
  return token;
}

export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
