import { assert } from "chai";
import {
  bibtexFromPaper,
  joinBibtex,
  normalizeBibtexEntry,
  removeBibField,
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
  });

  it("resolves @Article entries that have both journal and booktitle", function () {
    // Journal article with both fields: drop booktitle, keep journal
    const journalRaw =
      "@Article{LeCun2015DeepL,\n" +
      " author = {Yann LeCun and Yoshua Bengio and Geoffrey E. Hinton},\n" +
      " booktitle = {Nature},\n" +
      " journal = {Nature},\n" +
      " pages = {436-444},\n" +
      " title = {Deep Learning},\n" +
      " volume = {521},\n" +
      " year = {2015}\n}\n";
    const journalBib = normalizeBibtexEntry(journalRaw, DEEP_LEARNING);
    assert.match(journalBib, /^@Article\{LeCun2015DeepL,\n/);
    assert.include(journalBib, " journal = {Nature},");
    assert.notInclude(journalBib, "booktitle");
    assert.include(journalBib, " doi = {10.1038/nature14539}");

    // Conference-only paper with both fields: rewrite to @inproceedings, drop journal
    const confRaw =
      "@article{Vaswani2017AttentionIA,\n" +
      " author = {Ashish Vaswani and Noam M. Shazeer},\n" +
      " booktitle = {Neural Information Processing Systems},\n" +
      " journal = {ArXiv},\n" +
      " title = {Attention is All you Need},\n" +
      " year = {2017}\n}\n";
    const confBib = normalizeBibtexEntry(confRaw, {
      ...ATTENTION,
      publicationTypes: ["Conference"],
    });
    assert.match(confBib, /^@inproceedings\{Vaswani2017AttentionIA,\n/);
    assert.include(
      confBib,
      " booktitle = {Neural Information Processing Systems},",
    );
    assert.notInclude(confBib, "journal");

    // Both JournalArticle and Conference, or no metadata: keep @Article, drop booktitle
    const mixedBib = normalizeBibtexEntry(confRaw, ATTENTION);
    assert.match(mixedBib, /^@article\{Vaswani2017AttentionIA,\n/);
    assert.include(mixedBib, " journal = {ArXiv},");
    assert.notInclude(mixedBib, "booktitle");

    const noMetaBib = normalizeBibtexEntry(confRaw);
    assert.match(noMetaBib, /^@article\{Vaswani2017AttentionIA,\n/);
    assert.include(noMetaBib, " journal = {ArXiv},");
    assert.notInclude(noMetaBib, "booktitle");

    // Entry with neither journal nor booktitle is unchanged
    const neither =
      "@Article{Bare2020,\n" +
      " author = {Jane Doe},\n" +
      " title = {Minimal Entry},\n" +
      " year = {2020}\n}";
    assert.equal(normalizeBibtexEntry(neither), neither);
  });

  it("removes BibTeX fields across nested braces, quotes and multiple lines", function () {
    // Nested braces and multi-line value
    const multiBraced =
      "@Article{X,\n" +
      "  author = {Alice},\n" +
      "  booktitle = {Proceedings of the\n" +
      "    {IEEE/CVF} Conference on {Computer Vision}},\n" +
      "  journal = {IEEE TPAMI},\n" +
      "  year = {2025}\n}";
    assert.equal(
      removeBibField(multiBraced, "booktitle"),
      "@Article{X,\n" +
        "  author = {Alice},\n" +
        "  journal = {IEEE TPAMI},\n" +
        "  year = {2025}\n}",
    );

    // Multi-line quoted value with escaped quotes and nested braces
    const multiQuoted =
      "@Article{X,\n" +
      '  BookTitle = "Proceedings of \\"Foo\\",\n' +
      '    {Bar, "Baz"} Workshop",\n' +
      "  journal = {Nature},\n" +
      "  year = {2025}\n}";
    assert.equal(
      removeBibField(multiQuoted, "booktitle"),
      "@Article{X,\n  journal = {Nature},\n  year = {2025}\n}",
    );

    // Last field without trailing comma drops the previous field's comma cleanly
    const lastField =
      "@Article{X,\n" +
      "  journal = {ArXiv},\n" +
      "  booktitle = {arXiv.org}\n}";
    assert.equal(
      removeBibField(lastField, "booktitle"),
      "@Article{X,\n  journal = {ArXiv}\n}",
    );

    // Inline fields on one line
    assert.equal(
      removeBibField(
        "@Article{X, booktitle = {arXiv.org}, journal = {ArXiv}}",
        "booktitle",
      ),
      "@Article{X, journal = {ArXiv}}",
    );
    assert.equal(
      removeBibField(
        "@Article{X, journal = {ArXiv}, booktitle = {arXiv.org}}",
        "booktitle",
      ),
      "@Article{X, journal = {ArXiv}}",
    );

    // Text resembling a field inside another field's value is untouched
    const inTitle =
      "@Article{X,\n" +
      "  title = {Why booktitle = {foo} breaks BibTeX},\n" +
      "  booktitle = {arXiv.org},\n" +
      "  journal = {ArXiv}\n}";
    assert.equal(
      removeBibField(inTitle, "booktitle"),
      "@Article{X,\n" +
        "  title = {Why booktitle = {foo} breaks BibTeX},\n" +
        "  journal = {ArXiv}\n}",
    );

    // Missing field returns the entry unchanged
    assert.equal(removeBibField(lastField, "volume"), lastField);
  });

  it("turns S2 arXiv volume = {abs/...} into eprint and archivePrefix", function () {
    const raw =
      "@Article{Beethoven2026Preprint,\n" +
      " author = {Ludwig van Beethoven},\n" +
      " booktitle = {arXiv.org},\n" +
      " journal = {ArXiv},\n" +
      " title = {A Preprint About Zotero Plugins for Agents},\n" +
      " volume = {abs/2604.21816},\n" +
      " year = {2026}\n}\n";
    const paper = {
      ...ARXIV_ONLY,
      externalIds: {
        ArXiv: "2604.21816",
        DOI: "10.48550/arXiv.2604.21816",
      },
    };
    const bib = normalizeBibtexEntry(raw, paper);
    assert.match(bib, /^@Article\{Beethoven2026Preprint,\n/);
    assert.include(bib, " journal = {ArXiv},");
    assert.notInclude(bib, "booktitle");
    assert.notInclude(bib, "volume");
    assert.include(bib, "doi = {10.48550/arXiv.2604.21816}");
    assert.include(bib, "eprint = {2604.21816}");
    assert.include(bib, "archivePrefix = {arXiv}");

    // Prefers paper.externalIds.ArXiv when present
    const preferred = normalizeBibtexEntry(raw, {
      ...paper,
      externalIds: { ArXiv: "2604.21816v2" },
    });
    assert.include(preferred, "eprint = {2604.21816v2}");
    assert.notInclude(preferred, "volume");

    // Falls back to the id in volume when paper metadata is absent, including quoted values
    const quoted =
      "@Article{X,\n" +
      "  journal = {ArXiv},\n" +
      '  volume = "abs/2604.21816",\n' +
      "  year = {2026}\n}";
    const fromVolume = normalizeBibtexEntry(quoted);
    assert.notInclude(fromVolume, "volume");
    assert.include(fromVolume, "eprint = {2604.21816}");
    assert.include(fromVolume, "archivePrefix = {arXiv}");

    // Existing eprint or archivePrefix (any case) is not duplicated
    const hasEprint =
      "@Article{X,\n" +
      "  journal = {ArXiv},\n" +
      "  volume = {abs/2604.21816},\n" +
      "  Eprint = {2604.21816}\n}";
    const deduped = normalizeBibtexEntry(hasEprint, paper);
    assert.lengthOf(deduped.match(/eprint\s*=/gi) ?? [], 1);
    assert.include(deduped, "archivePrefix = {arXiv}");

    // Normal integer volumes stay untouched
    const normal =
      "@Article{LeCun2015DeepL,\n" +
      "  journal = {Nature},\n" +
      "  volume = {521},\n" +
      "  year = {2015}\n}";
    assert.equal(normalizeBibtexEntry(normal), normal);
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

  it("builds BibTeX from metadata when S2 has none", function () {
    const deep = bibtexFromPaper(DEEP_LEARNING);
    assert.equal(
      deep,
      "@article{LeCun2015Deep,\n" +
        "  author = {Yann LeCun and Yoshua Bengio and Geoffrey E. Hinton},\n" +
        "  title = {Deep Learning},\n" +
        "  journal = {Nature},\n" +
        "  volume = {521},\n" +
        "  pages = {436-444},\n" +
        "  year = {2015},\n" +
        "  doi = {10.1038/nature14539}\n}",
    );
    const attention = bibtexFromPaper(ATTENTION);
    assert.match(attention, /^@inproceedings\{Vaswani2017Attention,\n/);
    assert.include(
      attention,
      "booktitle = {Neural Information Processing Systems}",
    );
    assert.include(attention, "eprint = {1706.03762}");
    const arxivBuilt = bibtexFromPaper(ARXIV_ONLY);
    assert.include(arxivBuilt, "@article{Beethoven2024A,");
    assert.notInclude(arxivBuilt, "volume = {abs/");
    assert.include(arxivBuilt, "eprint = {2401.00001}");
    assert.include(arxivBuilt, "archivePrefix = {arXiv}");
    const bare = bibtexFromPaper({
      paperId: "0123456789abcdef",
      title: "Braces {in} a } title",
      publicationTypes: null,
    });
    assert.match(bare, /^@misc\{Braces,\n/);
    assert.include(bare, "title = {Braces \\{in\\} a \\} title}");
    assert.equal(
      bibtexFromPaper({ paperId: "0123456789abcdef", year: 2020 }),
      "@misc{S20123456789,\n  year = {2020}\n}",
    );

    const { text, missing } = joinBibtex(
      [
        { id: DEEP_LEARNING.paperId, paper: { citationStyles: null } },
        { id: ATTENTION.paperId, paper: null },
        { id: "unknown", paper: null },
      ],
      [DEEP_LEARNING, ATTENTION],
    );
    assert.equal(text, `${deep}\n\n${attention}\n`);
    assert.deepEqual(missing, ["unknown"]);
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
