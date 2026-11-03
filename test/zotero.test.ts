import { assert } from "chai";
import { TOOLS_BY_NAME } from "../src/mcp/tools";
import { ToolError } from "../src/mcp/errors";
import { prepareArgs } from "../src/mcp/schema";
import { S2Client } from "../src/s2/client";
import { RateLimiter } from "../src/s2/rateLimiter";
import { newStats } from "../src/s2/types";
import { resolveCollection } from "../src/zotero/collections";
import { createItem } from "../src/zotero/importer";
import { MAX_PDF_BYTES, writeTempPDF } from "../src/zotero/pdf";
import { getEntries } from "../src/log/activity";
import { runTool as runToolLogged } from "../src/mcp/runTool";
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

  it("creates a path once when asked in parallel", async function () {
    const lib = Zotero.Libraries.userLibraryID;
    const path = `${ROOT}/Parallel/Leaf`;
    const [a, b] = await Promise.all([
      resolveCollection(lib, path, true),
      resolveCollection(lib, path, true),
    ]);
    assert.equal(a.collection.id, b.collection.id);
    assert.deepEqual([a.created, b.created].sort(), [false, true]);
    const root = Zotero.Collections.getByLibrary(lib).find(
      (c) => c.name === ROOT,
    )!;
    assert.lengthOf(
      Zotero.Collections.getByParent(root.id).filter(
        (c) => c.name === "Parallel",
      ),
      1,
    );
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

  it("creates one item when the same paper is added in parallel", async function () {
    const paper = {
      ...ARXIV_ONLY,
      paperId: "fedcba9876543210fedcba9876543210fedcba98",
      corpusId: 999999002,
      externalIds: { ArXiv: "2401.99999", CorpusId: 999999002 },
      title: "Parallel adds must not duplicate this preprint",
    };
    const tool = TOOLS_BY_NAME.get("zotero_add_papers")!;
    const add = () =>
      tool.handler(
        prepareArgs(tool.inputSchema, {
          ids: ["ARXIV:2401.99999"],
          attach_pdf: false,
        }),
        { s2: fixtureClient([paper]), stats: newStats() },
      ) as Promise<any>;
    const [a, b] = await Promise.all([add(), add()]);
    assert.equal(a.results[0].itemKey, b.results[0].itemKey);
    assert.equal(a.summary.added + b.summary.added, 1);
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

describe("createItem (translator)", function () {
  it("keeps the translated item when tagging its Extra fails", async function () {
    const title = `Translated item ${Date.now()}`;
    // Offline stand-in for Zotero's DOI translator: it saves a real item,
    // whose next save (our Extra provenance) then fails
    const translate = Zotero.Translate as any;
    const original = translate.Search;
    translate.Search = class {
      setIdentifier() {}
      async getTranslators() {
        return [{}];
      }
      setTranslator() {}
      async translate({ libraryID }: { libraryID: number }) {
        const item = new Zotero.Item("journalArticle");
        item.libraryID = libraryID;
        item.setField("title", title);
        await item.saveTx();
        item.saveTx = async () => {
          throw new Error("save failed");
        };
        return [item];
      }
    };
    try {
      const lib = Zotero.Libraries.userLibraryID;
      const res = await createItem(
        lib,
        { ...DEEP_LEARNING, title },
        null,
        "translator",
      );
      assert.equal(res.source, "translator");
      const s = new Zotero.Search({ libraryID: lib });
      s.addCondition("title", "is", title);
      assert.lengthOf(await s.search(), 1, "no S2 fallback copy");
    } finally {
      translate.Search = original;
    }
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

  it("points to the PDF tools when nothing is found", async function () {
    const item = new Zotero.Item("journalArticle");
    item.setField("title", "PDF hint test");
    await item.saveTx();
    const api = Zotero.Attachments as any;
    const original = {
      add: api.addFileFromURLs,
      resolvers: api.getFileResolvers,
    };
    api.getFileResolvers = () => [];
    api.addFileFromURLs = async () => false;
    try {
      const res = await runTool("zotero_attach_pdf", { item_keys: [item.key] });
      assert.equal(res.results[0].pdf, "not_found");
      assert.match(res.hint, /zotero_add_pdf_file/);
    } finally {
      api.addFileFromURLs = original.add;
      api.getFileResolvers = original.resolvers;
      await item.eraseTx();
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

describe("fields override on recommendations and author papers", function () {
  it("returns raw S2 papers only when fields is set", async function () {
    const calls: string[] = [];
    const compact = await runTool(
      "s2_recommend",
      { positive_ids: [ATTENTION.paperId] },
      calls,
    );
    assert.notProperty(compact.papers[0], "externalIds");
    assert.match(calls[0], /fields=paperId%2CexternalIds/);
    const raw = await runTool(
      "s2_recommend",
      { positive_ids: [ATTENTION.paperId], fields: "title,abstract" },
      calls,
    );
    assert.deepEqual(raw.papers[0].externalIds, ATTENTION.externalIds);
    assert.match(calls[1], /fields=title%2Cabstract/);

    const authorRaw = await runTool(
      "s2_get_author_papers",
      { author_id: "40348417", fields: "title" },
      calls,
    );
    assert.equal(authorRaw.papers[0].paperId, ATTENTION.paperId);
    assert.property(authorRaw.papers[0], "externalIds");
    assert.match(calls[2], /\/author\/40348417\/papers\?.*fields=title/);
  });
});

describe("adding PDF files", function () {
  let dir: string;
  const created: number[] = [];
  let n = 0;

  /** A tiny PDF; `tag` makes each one hash differently. */
  function pdfBytes(tag = String(++n)) {
    return new TextEncoder().encode(
      `%PDF-1.4\n% ${tag}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
    );
  }
  async function file(name: string, bytes: Uint8Array) {
    const path = PathUtils.join(dir, name);
    await IOUtils.write(path, bytes);
    return path;
  }
  async function parentItem(title: string) {
    const item = new Zotero.Item("journalArticle");
    item.setField("title", title);
    await item.saveTx();
    created.push(item.id);
    return item;
  }
  function pdfChildren(item: Zotero.Item) {
    return item
      .getAttachments()
      .map((id) => Zotero.Items.get(id) as Zotero.Item)
      .filter((a) => a.isPDFAttachment());
  }
  async function tempLeftovers() {
    const names = await IOUtils.getChildren(PathUtils.tempDir);
    return names.filter((p) => /zotero-s2-[0-9a-f]+\.pdf$/.test(p)).length;
  }
  function track(res: any) {
    const att = Zotero.Items.getByLibraryAndKey(
      Zotero.Libraries.userLibraryID,
      res.attachmentKey,
    ) as Zotero.Item;
    if (att) created.push(att.id);
    return att;
  }

  before(async function () {
    dir = PathUtils.join(PathUtils.tempDir, `zs2-pdf-test-${Date.now()}`);
    await IOUtils.makeDirectory(dir);
  });

  after(async function () {
    await Zotero.Items.erase(created);
    await IOUtils.remove(dir, { recursive: true, ignoreAbsent: true });
  });

  it("attaches a local file to a parent, once per distinct file", async function () {
    const parent = await parentItem("PDF file test");
    const path = await file("paper.pdf", pdfBytes());
    const res = await runTool("zotero_add_pdf_file", {
      path,
      parent_item_key: parent.key,
    });
    assert.equal(res.status, "attached");
    const att = track(res);
    assert.equal(att.parentItemID, parent.id);
    assert.equal(att.attachmentContentType, "application/pdf");
    assert.isTrue(await IOUtils.exists(path), "the source file stays");

    const again = await runTool("zotero_add_pdf_file", {
      path,
      parent_item_key: parent.key,
    });
    assert.equal(again.status, "already");
    assert.equal(again.attachmentKey, res.attachmentKey);
    assert.lengthOf(pdfChildren(parent), 1);

    const other = await file("supplement.pdf", pdfBytes());
    track(
      await runTool("zotero_add_pdf_file", {
        path: other,
        parent_item_key: parent.key,
      }),
    );
    assert.lengthOf(pdfChildren(parent), 2);
  });

  it("attaches one copy when the same file is sent in parallel", async function () {
    const parent = await parentItem("PDF parallel test");
    const path = await file("parallel.pdf", pdfBytes());
    const args = { path, parent_item_key: parent.key };
    const results = await Promise.all([
      runTool("zotero_add_pdf_file", args),
      runTool("zotero_add_pdf_file", args),
    ]);
    results.forEach(track);
    assert.sameMembers(
      results.map((r) => r.status),
      ["attached", "already"],
    );
    assert.lengthOf(pdfChildren(parent), 1);
  });

  it("imports base64 bytes standalone into a collection", async function () {
    const before = await tempLeftovers();
    const bytes = pdfBytes();
    const b64 = btoa(String.fromCharCode(...bytes));
    const res = await runTool("zotero_add_pdf_file", {
      content_base64: `data:application/pdf;base64,${b64}`,
      filename: "Uploaded paper.pdf",
      collection: `${ROOT}/PDF`,
      recognize: false,
    });
    const att = track(res);
    assert.isTrue(att.isPDFAttachment());
    assert.isFalse(att.parentItemID);
    assert.equal(res.collection.path, `${ROOT}/PDF`);
    const coll = Zotero.Collections.getByLibraryAndKey(
      att.libraryID,
      res.collection.key,
    ) as Zotero.Collection;
    assert.isTrue(att.inCollection(coll.id));
    assert.equal(att.attachmentFilename, "Uploaded paper.pdf");
    assert.equal(await tempLeftovers(), before, "the temp file is removed");
  });

  it("rejects anything that isn't a single real PDF", async function () {
    const parent = await parentItem("PDF reject test");
    const html = await file("fake.pdf", new TextEncoder().encode("<html>"));
    const txt = await file("notes.txt", pdfBytes());
    const empty = await file("empty.pdf", new Uint8Array());
    const good = await file("good.pdf", pdfBytes());
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ path: "relative/paper.pdf" }, /absolute/],
      [{ path: PathUtils.join(dir, "missing.pdf") }, /No file/],
      [{ path: dir }, /not a file/],
      [{ path: txt }, /end in \.pdf/],
      [{ path: html }, /not a PDF/],
      [{ path: empty }, /empty/],
      [{ content_base64: "%%%" }, /not valid base64/],
      [{ content_base64: btoa("<html>") }, /not a PDF/],
      [{ path: good, content_base64: btoa("x") }, /exactly one/],
      [{}, /exactly one/],
      [
        { path: good, parent_item_key: parent.key, collection: ROOT },
        /not both/,
      ],
    ];
    for (const [args, msg] of cases) {
      let err: unknown;
      try {
        await runTool("zotero_add_pdf_file", args);
      } catch (e) {
        err = e;
      }
      assert.instanceOf(err, ToolError, JSON.stringify(args));
      assert.match((err as Error).message, msg, JSON.stringify(args));
    }
    assert.lengthOf(parent.getAttachments(), 0);
  });

  it("checks the base64 size before decoding", async function () {
    const huge = "A".repeat(Math.ceil((MAX_PDF_BYTES * 4) / 3) + 8);
    let err: unknown;
    try {
      await writeTempPDF(huge);
    } catch (e) {
      err = e;
    }
    assert.instanceOf(err, ToolError);
    assert.match((err as Error).message, /larger than/);
  });

  it("logs a base64 upload by length, not content", async function () {
    // Long enough to be shortened, as any real PDF is
    const b64 = btoa(String.fromCharCode(...pdfBytes("x".repeat(300))));
    const tool = TOOLS_BY_NAME.get("zotero_add_pdf_file")!;
    const outcome = await runToolLogged(
      tool,
      { content_base64: b64, recognize: false },
      fixtureClient(),
      "rest",
    );
    assert.isTrue(outcome.ok);
    track((outcome as any).value);
    const entry = getEntries()[0];
    assert.equal(entry.tool, "zotero_add_pdf_file");
    assert.include(entry.args, `<${b64.length} chars>`);
    assert.notInclude(entry.args, b64.slice(0, 40));
  });

  describe("from a URL", function () {
    let api: any;
    let original: any;
    let seen: any[];

    beforeEach(function () {
      api = Zotero.Attachments;
      original = api.downloadFirstAvailableFile;
      seen = [];
    });

    afterEach(function () {
      api.downloadFirstAvailableFile = original;
    });
    function stub(ok: boolean) {
      api.downloadFirstAvailableFile = async (
        resolvers: any[],
        path: string,
      ) => {
        seen.push(...resolvers);
        if (!ok) return false;
        await IOUtils.write(path, pdfBytes());
        return { url: "https://example.org/files/landing.pdf", props: {} };
      };
    }

    it("follows a landing page for a parent item", async function () {
      stub(true);
      const parent = await parentItem("PDF URL test");
      const res = await runTool("zotero_add_pdf_from_url", {
        url: "https://example.org/article/123",
        parent_item_key: parent.key,
      });
      track(res);
      assert.equal(res.status, "attached");
      assert.deepInclude(seen[0], {
        pageURL: "https://example.org/article/123",
      });
      assert.lengthOf(pdfChildren(parent), 1);
    });

    it("saves a landing page's PDF standalone", async function () {
      stub(true);
      const before = await tempLeftovers();
      const res = await runTool("zotero_add_pdf_from_url", {
        url: "https://example.org/article/456",
        recognize: false,
      });
      const att = track(res);
      assert.isTrue(att.isPDFAttachment());
      assert.equal(att.attachmentFilename, "landing.pdf");
      assert.equal(await tempLeftovers(), before);
    });

    it("explains what to do when no PDF can be fetched", async function () {
      stub(false);
      const parent = await parentItem("PDF URL fail test");
      for (const args of [
        { url: "https://example.org/paywalled", parent_item_key: parent.key },
        { url: "https://example.org/paywalled", recognize: false },
      ]) {
        let err: unknown;
        try {
          await runTool("zotero_add_pdf_from_url", args);
        } catch (e) {
          err = e;
        }
        assert.instanceOf(err, ToolError);
        assert.match((err as Error).message, /zotero_add_pdf_file/);
      }
      assert.lengthOf(parent.getAttachments(), 0);
    });
  });
});

describe("tool annotations", function () {
  it("state destructiveHint on every write tool", function () {
    // MCP assumes destructive when a non-read-only tool leaves it out
    for (const tool of TOOLS_BY_NAME.values()) {
      if (tool.annotations.readOnlyHint) continue;
      assert.isBoolean(tool.annotations.destructiveHint, tool.name);
    }
    for (const name of [
      "zotero_create_collection",
      "zotero_add_papers",
      "zotero_attach_pdf",
      "zotero_add_pdf_from_url",
      "zotero_add_pdf_file",
    ]) {
      assert.isFalse(TOOLS_BY_NAME.get(name)!.annotations.destructiveHint);
    }
    // A standalone import makes a new item each time
    assert.isFalse(
      TOOLS_BY_NAME.get("zotero_add_pdf_file")!.annotations.idempotentHint,
    );
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
