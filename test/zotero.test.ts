import { assert } from "chai";
import { TOOLS_BY_NAME } from "../src/mcp/tools";
import { ToolError } from "../src/mcp/errors";
import { prepareArgs } from "../src/mcp/schema";
import { S2Client } from "../src/s2/client";
import { RateLimiter } from "../src/s2/rateLimiter";
import { newStats } from "../src/s2/types";
import { resolveCollection } from "../src/zotero/collections";
import { ATTENTION, DEEP_LEARNING, ARXIV_ONLY } from "./fixtures";
import { fixtureClient, response } from "./helpers";

const ROOT = `S2 Test ${Date.now()}`;

async function runTool(
  name: string,
  args: Record<string, unknown>,
  calls: string[] = [],
) {
  const tool = TOOLS_BY_NAME.get(name)!;
  const s2 = fixtureClient(undefined, calls);
  return (await tool.handler(prepareArgs(tool.inputSchema, args), {
    s2,
    stats: newStats(),
  })) as any;
}

describe("collections", function () {
  it("creates a nested path once and then reuses it", async function () {
    const lib = Zotero.Libraries.userLibraryID;
    const first = await resolveCollection(lib, `${ROOT}/A/B`, true);
    assert.isTrue(first.created);
    const again = await resolveCollection(lib, `${ROOT}/A/B`, true);
    assert.isFalse(again.created);
    assert.equal(again.collection.id, first.collection.id);
    const byKey = await resolveCollection(lib, first.collection.key, false);
    assert.equal(byKey.collection.id, first.collection.id);
  });

  it("lists collections with slash paths", async function () {
    const res = await runTool("zotero_list_collections", {});
    assert.include(
      res.collections.map((c: any) => c.path),
      `${ROOT}/A/B`,
    );
  });
});

describe("zotero_add_papers", function () {
  this.timeout(30_000);

  it("adds papers to a new collection with S2 metadata", async function () {
    const calls: string[] = [];
    const res = await runTool(
      "zotero_add_papers",
      {
        ids: [
          "ARXIV:1706.03762",
          "DOI:10.1038/nature14539",
          "DOI:10.9999/missing",
        ],
        collection: `${ROOT}/Add`,
        attach_pdf: false,
        tags: ["agent"],
        note: "Found by test",
      },
      calls,
    );
    assert.equal(calls.length, 1, "one S2 batch call for all ids");
    assert.isTrue(res.collection.created);
    assert.deepInclude(res.summary, { added: 2, existing: 0, failed: 1 });
    assert.equal(res.results[2].error, "not found on Semantic Scholar");

    const att = Zotero.Items.getByLibraryAndKey(
      Zotero.Libraries.userLibraryID,
      res.results[0].itemKey,
    ) as Zotero.Item;
    assert.equal(Zotero.ItemTypes.getName(att.itemTypeID), "conferencePaper");
    assert.equal(att.getField("title"), ATTENTION.title);
    assert.include(
      att.getField("extra") as string,
      `S2 Paper ID: ${ATTENTION.paperId}`,
    );
    assert.isTrue(att.hasTag("agent"));
    assert.lengthOf(att.getNotes(), 1);
    assert.equal(att.getField("libraryCatalog"), "Semantic Scholar");

    const dl = Zotero.Items.getByLibraryAndKey(
      Zotero.Libraries.userLibraryID,
      res.results[1].itemKey,
    ) as Zotero.Item;
    assert.equal(dl.getField("DOI"), "10.1038/nature14539");
    assert.equal(dl.getField("publicationTitle"), "Nature");
  });

  it("reuses existing items instead of duplicating", async function () {
    const res = await runTool("zotero_add_papers", {
      ids: ["10.1038/nature14539"],
      collection: `${ROOT}/Second`,
      attach_pdf: false,
    });
    assert.deepInclude(res.summary, { added: 0, existing: 1 });
    const item = Zotero.Items.getByLibraryAndKey(
      Zotero.Libraries.userLibraryID,
      res.results[0].itemKey,
    ) as Zotero.Item;
    assert.lengthOf(item.getCollections(), 2, "now in both collections");
  });

  it("matches a hand-made item by title and year", async function () {
    const manual = new Zotero.Item("preprint");
    manual.setField("title", "A preprint about Zotero plugins for agents!");
    manual.setField("date", "2024");
    await manual.saveTx();
    const res = await runTool("zotero_add_papers", {
      ids: [`ARXIV:${ARXIV_ONLY.externalIds!.ArXiv}`],
      attach_pdf: false,
    });
    assert.equal(res.results[0].itemKey, manual.key);
    assert.isTrue(res.results[0].existing);
  });

  it("rejects more than 25 ids", async function () {
    const tool = TOOLS_BY_NAME.get("zotero_add_papers")!;
    assert.throws(
      () =>
        prepareArgs(tool.inputSchema, { ids: Array(26).fill("1706.03762") }),
      /at most 25/,
    );
  });
});

describe("zotero_attach_pdf", function () {
  it("downloads once when the same item is given twice", async function () {
    const item = new Zotero.Item("journalArticle");
    item.setField("title", "PDF dedupe test");
    await item.saveTx();
    // Stub the download so the test stays offline
    const api = Zotero.Attachments as any;
    const original = {
      add: api.addFileFromURLs,
      resolvers: api.getFileResolvers,
    };
    let downloads = 0;
    api.getFileResolvers = () => [];
    api.addFileFromURLs = async () => {
      downloads++;
      await Zotero.Promise.delay(50);
      return {};
    };
    try {
      const res = await runTool("zotero_attach_pdf", {
        item_keys: [item.key, item.key],
      });
      assert.equal(downloads, 1);
      assert.deepEqual(
        res.results.map((r: any) => r.pdf),
        ["attached", "attached"],
      );
    } finally {
      api.addFileFromURLs = original.add;
      api.getFileResolvers = original.resolvers;
    }
  });
});

describe("zotero_find_in_library", function () {
  it("finds items by DOI without calling S2", async function () {
    const calls: string[] = [];
    const res = await runTool(
      "zotero_find_in_library",
      {
        ids: ["https://doi.org/10.1038/NATURE14539", "DOI:10.1/none"],
        resolve_via_s2: false,
      },
      calls,
    );
    assert.lengthOf(calls, 0);
    assert.isTrue(res.results[0].inLibrary);
    assert.equal(res.results[0].item.doi, "10.1038/nature14539");
    assert.isFalse(res.results[1].inLibrary);
  });

  it("resolves S2 ids via one batch call", async function () {
    const calls: string[] = [];
    const res = await runTool(
      "zotero_find_in_library",
      { ids: [DEEP_LEARNING.paperId] },
      calls,
    );
    assert.lengthOf(calls, 1);
    assert.isTrue(res.results[0].inLibrary);
  });

  it("falls back to local matching when S2 fails", async function () {
    const tool = TOOLS_BY_NAME.get("zotero_find_in_library")!;
    // No API key: the client refuses before any request
    const s2 = new S2Client({ apiKey: () => "" });
    const res = (await tool.handler(
      prepareArgs(tool.inputSchema, { ids: ["DOI:10.1038/nature14539"] }),
      { s2, stats: newStats() },
    )) as any;
    assert.match(res.warning, /No Semantic Scholar API key/);
    assert.isTrue(res.results[0].inLibrary);
  });
});

describe("s2_match_title", function () {
  it("returns the best match, or a ToolError when there is none", async function () {
    const res = await runTool("s2_match_title", { title: DEEP_LEARNING.title });
    assert.equal(res.paper.paperId, DEEP_LEARNING.paperId);
    assert.equal(res.matchScore, 99);
    const err = await runTool("s2_match_title", {
      title: "No such paper",
    }).catch((e) => e);
    assert.instanceOf(err, ToolError);
  });
});

describe("zotero_enrich_items", function () {
  it("fills empty fields and records the S2 id", async function () {
    const item = new Zotero.Item("journalArticle");
    item.setField("title", "Deep Learning");
    item.setField("DOI", "10.1038/nature14539");
    item.setField("volume", "999");
    await item.saveTx();
    const res = await runTool("zotero_enrich_items", { item_keys: [item.key] });
    assert.isTrue(res.results[0].matched);
    assert.include(res.results[0].changed, "abstractNote");
    assert.notInclude(res.results[0].changed, "volume");
    assert.equal(item.getField("volume"), "999", "existing value kept");
    assert.equal(item.getField("publicationTitle"), "Nature");
    assert.include(
      item.getField("extra") as string,
      `S2 Paper ID: ${DEEP_LEARNING.paperId}`,
    );
  });

  it("matches an item without ids by its title", async function () {
    const item = new Zotero.Item("conferencePaper");
    item.setField("title", ATTENTION.title!);
    await item.saveTx();
    const calls: string[] = [];
    const res = await runTool(
      "zotero_enrich_items",
      { item_keys: [item.key] },
      calls,
    );
    assert.lengthOf(calls, 1, "no batch call, one title match");
    assert.isTrue(res.results[0].matched);
    assert.equal(res.results[0].paperId, ATTENTION.paperId);
    assert.include(res.results[0].changed, "creators");
  });

  it("rejects a title match for a different paper", async function () {
    const item = new Zotero.Item("journalArticle");
    item.setField("title", "Attention is all you need in survey form");
    await item.saveTx();
    // S2 answers with its closest title, which is another paper
    const s2 = new S2Client({
      apiKey: () => "test-key",
      transport: async () =>
        response(200, { data: [{ ...ATTENTION, matchScore: 40 }] }),
      limiter: new RateLimiter(0),
    });
    const tool = TOOLS_BY_NAME.get("zotero_enrich_items")!;
    const res = (await tool.handler(
      prepareArgs(tool.inputSchema, { item_keys: [item.key] }),
      { s2, stats: newStats() },
    )) as any;
    assert.isFalse(res.results[0].matched);
    assert.equal(item.getField("extra"), "", "no S2 id recorded");
  });

  it("rejects a title match whose year differs", async function () {
    const item = new Zotero.Item("book");
    item.setField("title", "Deep Learning");
    item.setField("date", "2016");
    await item.saveTx();
    const res = await runTool("zotero_enrich_items", { item_keys: [item.key] });
    assert.isFalse(res.results[0].matched);
    assert.equal(item.numCreators(), 0);
  });
});

describe("tool schemas", function () {
  it("declare additionalProperties: false, matching prepareArgs", function () {
    for (const tool of TOOLS_BY_NAME.values()) {
      assert.isFalse(tool.inputSchema.additionalProperties, tool.name);
    }
    const tool = TOOLS_BY_NAME.get("zotero_list_collections")!;
    assert.throws(
      () => prepareArgs(tool.inputSchema, { bogus: 1 }),
      /Unknown argument "bogus"/,
    );
  });
});
