import { assert } from "chai";
import { joinBibtex, toCSV, toRIS } from "../src/gui/export";
import {
  HISTORY_MAX,
  addHistory,
  defaultState,
  parseHistory,
  parseState,
} from "../src/gui/state";
import { ATTENTION, ARXIV_ONLY, DEEP_LEARNING } from "./fixtures";

describe("gui export", function () {
  it("writes RFC 4180 CSV", function () {
    const tricky = {
      ...ATTENTION,
      title: 'A "quoted", title',
      abstract: "line one\nline two",
    };
    const csv = toCSV([tricky, ARXIV_ONLY]);
    const lines = csv.split("\r\n");
    assert.match(lines[0], /^Title,Authors,Year,Venue,/);
    assert.isTrue(lines[1].startsWith('"A ""quoted"", title",'));
    assert.include(csv, '"line one\nline two"');
    assert.include(csv, "Ashish Vaswani; Noam M. Shazeer; Niki Parmar");
    assert.isTrue(csv.endsWith("\r\n"));
  });

  it("writes one RIS record per paper", function () {
    const ris = toRIS([DEEP_LEARNING, ARXIV_ONLY]);
    const records = ris.split("ER  - ").filter((r) => r.trim());
    assert.lengthOf(records, 2);
    assert.match(ris, /^TY {2}- JOUR\r\n/);
    assert.include(ris, "DO  - 10.1038/nature14539");
    assert.include(ris, "JO  - Nature");
    assert.include(ris, "DA  - 2015/05/27");
    assert.match(records[1], /TY {2}- UNPB/);
    assert.include(records[1], "N1  - arXiv: ");
    // Abstracts stay on one line
    const multi = toRIS([{ ...DEEP_LEARNING, abstract: "a\n\nb" }]);
    assert.include(multi, "AB  - a b");
  });

  it("joins BibTeX and reports papers without it", function () {
    const { text, missing } = joinBibtex([
      { id: "a", paper: { citationStyles: { bibtex: "@article{a}\n" } } },
      { id: "b", paper: null },
      { id: "c", paper: { citationStyles: { bibtex: "@inproceedings{c}" } } },
    ]);
    assert.equal(text, "@article{a}\n\n@inproceedings{c}\n");
    assert.deepEqual(missing, ["b"]);
    assert.equal(joinBibtex([]).text, "");
  });
});

describe("gui state", function () {
  it("parses saved state defensively", function () {
    assert.deepEqual(parseState(""), defaultState());
    assert.deepEqual(parseState("not json"), defaultState());
    assert.deepEqual(parseState("[1,2]"), defaultState());
    const s = parseState(
      JSON.stringify({
        mode: "bulk",
        query: "x",
        filters: {
          yearFrom: "2017",
          fieldsOfStudy: ["Physics", 3],
          openAccess: "yes",
        },
        target: { libraryID: 1, collection: "ABCD2345" },
        metadata: "bogus",
        attachPdf: false,
      }),
    );
    assert.equal(s.mode, "bulk");
    assert.equal(s.filters.yearFrom, "2017");
    assert.deepEqual(s.filters.fieldsOfStudy, ["Physics"]);
    assert.isFalse(s.filters.openAccess);
    assert.deepEqual(s.target, { libraryID: 1, collection: "ABCD2345" });
    assert.equal(s.metadata, "s2");
    assert.isFalse(s.attachPdf);
    assert.equal(parseState(JSON.stringify({ mode: "nope" })).mode, "simple");
    assert.isNull(
      parseState(JSON.stringify({ target: { libraryID: "1" } })).target,
    );
  });

  it("keeps a short, deduplicated, newest-first history", function () {
    let h = addHistory([], { mode: "simple", query: " Attention " });
    h = addHistory(h, { mode: "bulk", query: "attention" });
    h = addHistory(h, { mode: "simple", query: "ATTENTION" });
    assert.deepEqual(h, [
      { mode: "simple", query: "ATTENTION" },
      { mode: "bulk", query: "attention" },
    ]);
    assert.deepEqual(addHistory(h, { mode: "simple", query: "  " }), h);
    for (let i = 0; i < 30; i++)
      h = addHistory(h, { mode: "simple", query: `q${i}` });
    assert.lengthOf(h, HISTORY_MAX);
    assert.equal(h[0].query, "q29");
    assert.deepEqual(parseHistory(JSON.stringify(h)), h);
    assert.deepEqual(
      parseHistory('[{"mode":"x","query":"y"},{"mode":"simple"}]'),
      [],
    );
    assert.deepEqual(parseHistory("{}"), []);
  });
});
