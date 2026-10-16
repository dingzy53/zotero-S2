import { ToolOutcome } from "./runTool";
import { ToolDef } from "./tools";

/**
 * Dual-era MCP over Streamable HTTP, JSON responses only (no SSE).
 *
 * - Modern (2026-07-28): stateless; every request carries
 *   `params._meta["io.modelcontextprotocol/protocolVersion"]` and mirrored
 *   `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers.
 * - Legacy (2025-03-26 … 2025-11-25): `initialize` handshake. We mint no
 *   session id, which those revisions allow.
 *
 * A request is modern only when the body has the `_meta` version; header
 * validation and version errors apply only then.
 */

export const MODERN_VERSION = "2026-07-28";
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
export const SUPPORTED_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";

export const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  HEADER_MISMATCH: -32020,
  UNSUPPORTED_VERSION: -32022,
} as const;

export interface McpRequest {
  method: string;
  /** Lower-case header names. */
  headers: Record<string, string | undefined>;
  data: unknown;
}

export type McpResponse = [
  status: number,
  headers: Record<string, string>,
  body: string,
];

export interface McpServerOptions {
  name: string;
  version: string;
  instructions: string;
  tools: () => ToolDef[];
  callTool: (tool: ToolDef, args: unknown) => Promise<ToolOutcome>;
}

type Id = string | number | null;

const JSON_HEADERS = { "Content-Type": "application/json" };

function reply(status: number, payload: object): McpResponse {
  return [status, JSON_HEADERS, JSON.stringify(payload)];
}

function rpcError(
  status: number,
  id: Id,
  code: number,
  message: string,
  data?: unknown,
): McpResponse {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return reply(status, { jsonrpc: "2.0", id, error });
}

function rpcResult(id: Id, result: object): McpResponse {
  return reply(200, {
    jsonrpc: "2.0",
    id,
    result: { resultType: "complete", ...result },
  });
}

/** Decodes the `=?base64?…?=` header form used for non-ASCII values. */
export function decodeHeaderValue(value: string): string {
  const m = /^=\?base64\?(.*)\?=$/.exec(value);
  if (!m) return value;
  const bytes = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function createMcpHandler(opts: McpServerOptions) {
  const serverInfo = { name: opts.name, version: opts.version };
  const capabilities = { tools: { listChanged: false } };

  function listTools() {
    return opts.tools().map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { title: t.title, ...t.annotations },
    }));
  }

  /** Validates mirrored headers for a modern request; returns an error response or null. */
  function checkModernHeaders(
    req: McpRequest,
    id: Id,
    method: string,
    version: string,
    params: any,
  ): McpResponse | null {
    const mismatch = (msg: string) =>
      rpcError(400, id, ERR.HEADER_MISMATCH, `Header mismatch: ${msg}`);
    const headerVersion = req.headers["mcp-protocol-version"];
    if (!headerVersion)
      return mismatch("MCP-Protocol-Version header is missing");
    if (headerVersion !== version) {
      return mismatch(
        `MCP-Protocol-Version '${headerVersion}' does not match body '${version}'`,
      );
    }
    const headerMethod = req.headers["mcp-method"];
    if (!headerMethod) return mismatch("Mcp-Method header is missing");
    if (headerMethod !== method) {
      return mismatch(
        `Mcp-Method '${headerMethod}' does not match body '${method}'`,
      );
    }
    if (method === "tools/call") {
      const rawName = req.headers["mcp-name"];
      if (!rawName) return mismatch("Mcp-Name header is missing");
      let name: string;
      try {
        name = decodeHeaderValue(rawName);
      } catch {
        return mismatch("Mcp-Name header is not valid base64");
      }
      if (name !== params?.name) {
        return mismatch(
          `Mcp-Name '${name}' does not match body '${params?.name}'`,
        );
      }
    }
    return null;
  }

  return async function handle(req: McpRequest): Promise<McpResponse> {
    if (req.method !== "POST") {
      return [
        405,
        { Allow: "POST", ...JSON_HEADERS },
        JSON.stringify({ error: "Use POST" }),
      ];
    }
    const msg = req.data as any;
    if (Array.isArray(msg)) {
      return rpcError(
        400,
        null,
        ERR.INVALID_REQUEST,
        "Batch requests are not supported",
      );
    }
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
      return rpcError(
        400,
        null,
        ERR.INVALID_REQUEST,
        "Expected a JSON-RPC 2.0 message",
      );
    }
    // Notifications and stray client responses need no reply
    if (!("id" in msg) || typeof msg.method !== "string") {
      return [202, {}, ""];
    }

    const id: Id = msg.id;
    const method: string = msg.method;
    const params = msg.params ?? {};
    const modernVersion = params?._meta?.[META_VERSION];
    const isModern = modernVersion !== undefined;

    if (isModern) {
      if (modernVersion !== MODERN_VERSION) {
        return rpcError(
          400,
          id,
          ERR.UNSUPPORTED_VERSION,
          "Unsupported protocol version",
          {
            supported: SUPPORTED_VERSIONS,
            requested: modernVersion,
          },
        );
      }
      const headerError = checkModernHeaders(
        req,
        id,
        method,
        modernVersion,
        params,
      );
      if (headerError) return headerError;
    } else {
      const headerVersion = req.headers["mcp-protocol-version"];
      if (headerVersion && !LEGACY_VERSIONS.includes(headerVersion)) {
        return rpcError(
          400,
          id,
          ERR.INVALID_REQUEST,
          `Unsupported MCP-Protocol-Version '${headerVersion}'`,
          { supported: SUPPORTED_VERSIONS },
        );
      }
    }

    switch (method) {
      case "initialize": {
        const requested = params.protocolVersion;
        return rpcResult(id, {
          protocolVersion: LEGACY_VERSIONS.includes(requested)
            ? requested
            : LEGACY_VERSIONS[0],
          capabilities,
          serverInfo,
          instructions: opts.instructions,
        });
      }
      case "server/discover":
        return rpcResult(id, {
          supportedVersions: SUPPORTED_VERSIONS,
          capabilities,
          _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
          instructions: opts.instructions,
          ttlMs: 3_600_000,
          cacheScope: "private",
        });
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, {
          tools: listTools(),
          ttlMs: 3_600_000,
          cacheScope: "private",
        });
      case "tools/call": {
        const tool = opts.tools().find((t) => t.name === params.name);
        if (!tool) {
          return rpcError(
            isModern ? 400 : 200,
            id,
            ERR.INVALID_PARAMS,
            `Unknown tool: ${params.name}`,
          );
        }
        const outcome = await opts.callTool(tool, params.arguments);
        if (!outcome.ok) {
          return rpcResult(id, {
            content: [{ type: "text", text: outcome.message }],
            isError: true,
          });
        }
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(outcome.value) }],
          structuredContent: outcome.value,
        });
      }
      default:
        return rpcError(
          isModern ? 404 : 200,
          id,
          ERR.METHOD_NOT_FOUND,
          `Method not found: ${method}`,
        );
    }
  };
}
