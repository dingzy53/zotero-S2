import { assert } from "chai";
import {
  joinBibtex,
  normalizeBibtexEntry,
  toCSV,
  toRIS,
} from "../src/gui/export";
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

  it("rewrites S2's @Article with booktitle as @inproceedings", function () {
    const raw =
      "@Article{Vaswani2017AttentionIA,\n" +
      " author = {Ashish Vaswani and Noam M. Shazeer},\n" +
      " booktitle = {Neural Information Processing Systems},\n" +
      " title = {Attention is All you Need},\n" +
      " year = {2017}\n}\n";
    const paper = {
      ...ATTENTION,
      externalIds: { ...ATTENTION.externalIds, DOI: "10.5555/3295222" },
    };
    const bib = normalizeBibtexEntry(raw, paper);
    assert.match(bib, /^@inproceedings\{Vaswani2017AttentionIA,\n/);
    assert.include(bib, "booktitle = {Neural Information Processing Systems}");
    assert.include(bib, " year = {2017},\n  doi = {10.5555/3295222}\n}");
    assert.notInclude(bib, "journal");
    // Without metadata the booktitle still decides
    assert.match(normalizeBibtexEntry(raw), /^@inproceedings\{/);
    assert.notInclude(normalizeBibtexEntry(raw), "doi");
    // A journal article keeps @Article and gets a journal instead
    const journal = normalizeBibtexEntry(raw, {
      ...paper,
      publicationTypes: ["JournalArticle"],
    });
    assert.match(journal, /^@Article\{/);
    assert.include(journal, " journal = {Neural Information Processing");
    assert.notInclude(journal, "booktitle");
    // @Article with a journal is left alone, whatever the paper type
    const arxiv = "@article{x,\n journal = {ArXiv},\n booktitle = {B}\n}";
    assert.match(
      normalizeBibtexEntry(arxiv, {
        ...ATTENTION,
        publicationTypes: ["Conference"],
      }),
      /^@article\{/,
    );
  });

  it("adds a missing DOI to S2's BibTeX once", function () {
    const raw =
      "@Article{LeCun2015DeepL,\n journal = {Nature},\n title = {Deep Learning},\n year = {2015}\n}";
    const bib = normalizeBibtexEntry(raw, DEEP_LEARNING);
    assert.match(bib, /^@Article\{LeCun2015DeepL,/);
    assert.isTrue(
      bib.endsWith(" year = {2015},\n  doi = {10.1038/nature14539}\n}"),
    );
    // Already there, in any case: not duplicated
    const has = raw.replace("}\n}", "},\n DOI = {10.1038/NATURE14539}\n}");
    assert.equal(normalizeBibtexEntry(has, DEEP_LEARNING), has);
    // A trailing comma is not doubled
    const trailing = raw.replace("{2015}\n}", "{2015},\n}");
    assert.include(
      normalizeBibtexEntry(trailing, DEEP_LEARNING),
      "{2015},\n  doi = {10.1038/nature14539}\n}",
    );
    // An entry with no fields gets the comma after its key
    assert.equal(
      normalizeBibtexEntry("@misc{k}", DEEP_LEARNING),
      "@misc{k,\n  doi = {10.1038/nature14539}\n}",
    );
    const { text } = joinBibtex(
      [
        {
          id: DEEP_LEARNING.paperId,
          paper: { citationStyles: { bibtex: raw } },
        },
      ],
      [DEEP_LEARNING],
    );
    assert.include(text, "doi = {10.1038/nature14539}");
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
