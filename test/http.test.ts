import { assert } from "chai";
import { config } from "../package.json";
import { MODERN_VERSION } from "../src/mcp/server";
import { TOOLS } from "../src/mcp/tools";

// Set in zotero-plugin.config.ts → test.prefs
const TOKEN = "test-token";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const JSON_TYPE = { "Content-Type": "application/json" };

/** A real request through Zotero's local server, not the endpoint object. */
async function send(
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
) {
  const port = Zotero.Prefs.get("httpServer.port");
  const xhr = await Zotero.HTTP.request(
    method,
    `http://127.0.0.1:${port}${path}`,
    {
      headers: options.headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      responseType: "text",
      successCodes: false,
      errorDelayMax: 0,
    } as any,
  );
  const text: string = xhr.responseText;
  return {
    status: xhr.status,
    text,
    json: text ? JSON.parse(text) : null,
    header: (name: string) => xhr.getResponseHeader(name),
  };
}

function modernBody(method: string, params: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN_VERSION,
        "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}

describe("HTTP access control", function () {
  it("requires the bearer token", async function () {
    const none = await send("GET", "/s2/tools");
    assert.equal(none.status, 401);
    assert.equal(none.header("WWW-Authenticate"), "Bearer");
    const wrong = await send("GET", "/s2/tools", {
      headers: { Authorization: "Bearer not-the-token" },
    });
    assert.equal(wrong.status, 401);
  });

  it("rejects requests from web pages (Origin header)", async function () {
    const r = await send("POST", "/s2/mcp", {
      headers: { ...AUTH, ...JSON_TYPE, Origin: "https://example.com" },
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    assert.equal(r.status, 403);
    // Ours, not Zotero's silent browser-request drop
    assert.equal(r.json.error.message, "Origin not allowed");
  });

  it("returns 503 while disabled in settings", async function () {
    const pref = `${config.prefsPrefix}.enable`;
    Zotero.Prefs.set(pref, false, true);
    try {
      const r = await send("GET", "/s2/tools", { headers: AUTH });
      assert.equal(r.status, 503);
    } finally {
      Zotero.Prefs.set(pref, true, true);
    }
  });
});

describe("HTTP MCP endpoint", function () {
  it("serves a modern request with mixed-case headers", async function () {
    const r = await send("POST", "/s2/mcp", {
      headers: {
        ...AUTH,
        ...JSON_TYPE,
        "MCP-Protocol-Version": MODERN_VERSION,
        "Mcp-Method": "tools/list",
      },
      body: modernBody("tools/list"),
    });
    assert.equal(r.status, 200);
    assert.lengthOf(r.json.result.tools, TOOLS.length);
    assert.equal(
      r.json.result._meta["io.modelcontextprotocol/serverInfo"].name,
      config.addonName,
    );
  });

  it("rejects a modern tools/call whose Mcp-Name header doesn't match", async function () {
    const r = await send("POST", "/s2/mcp", {
      headers: {
        ...AUTH,
        ...JSON_TYPE,
        "MCP-Protocol-Version": MODERN_VERSION,
        "Mcp-Method": "tools/call",
        "Mcp-Name": "s2_search_papers",
      },
      body: modernBody("tools/call", {
        name: "zotero_list_collections",
        arguments: {},
      }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, -32020);
  });

  it("serves a legacy initialize and its notification", async function () {
    const init = await send("POST", "/s2/mcp", {
      headers: { ...AUTH, ...JSON_TYPE },
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      },
    });
    assert.equal(init.status, 200);
    assert.equal(init.json.result.protocolVersion, "2025-06-18");
    const note = await send("POST", "/s2/mcp", {
      headers: { ...AUTH, ...JSON_TYPE, "MCP-Protocol-Version": "2025-06-18" },
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    assert.equal(note.status, 202);
    assert.equal(note.text, "");
  });

  it("answers GET with 405", async function () {
    const r = await send("GET", "/s2/mcp", { headers: AUTH });
    assert.equal(r.status, 405);
    assert.equal(r.header("Allow"), "POST");
  });
});

describe("HTTP REST mirror", function () {
  it("lists tools", async function () {
    const r = await send("GET", "/s2/tools", { headers: AUTH });
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.json.tools.map((t: any) => t.name),
      TOOLS.map((t) => t.name),
    );
  });

  it("runs a tool, and reports bad names and arguments", async function () {
    const ok = await send("POST", "/s2/tools/zotero_list_collections", {
      headers: { ...AUTH, ...JSON_TYPE },
      body: {},
    });
    assert.equal(ok.status, 200);
    assert.isArray(ok.json.collections);

    const unknown = await send("POST", "/s2/tools/no_such_tool", {
      headers: { ...AUTH, ...JSON_TYPE },
      body: {},
    });
    assert.equal(unknown.status, 404);

    const bad = await send("POST", "/s2/tools/zotero_list_collections", {
      headers: { ...AUTH, ...JSON_TYPE },
      body: { bogus: 1 },
    });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /Unknown argument "bogus"/);
  });
});
