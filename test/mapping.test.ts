import { assert } from "chai";
import { mergeExtra, s2ToZotero, splitName } from "../src/zotero/s2ToZotero";
import { parseIdentifier } from "../src/zotero/identifiers";
import { ARXIV_ONLY, ATTENTION, DEEP_LEARNING } from "./fixtures";

describe("s2ToZotero", function () {
  it("maps a journal article", function () {
    const m = s2ToZotero(DEEP_LEARNING);
    assert.equal(m.itemType, "journalArticle");
    assert.equal(m.fields.title, "Deep Learning");
    assert.equal(m.fields.publicationTitle, "Nature");
    assert.equal(m.fields.volume, "521");
    assert.equal(m.fields.pages, "436-444");
    assert.equal(m.fields.DOI, "10.1038/nature14539");
    assert.equal(m.fields.date, "2015-05-27");
    assert.deepEqual(m.creators[2], {
      firstName: "Geoffrey E.",
      lastName: "Hinton",
      creatorType: "author",
    });
    assert.include(
      m.extra,
      "S2 Paper ID: a4cec122a08216fe8a3bc19b22e78fbaea096256",
    );
    assert.include(m.extra, "CorpusID: 1779661");
  });

  it("maps a conference paper that also has an arXiv id", function () {
    const m = s2ToZotero(ATTENTION);
    assert.equal(m.itemType, "conferencePaper");
    assert.equal(
      m.fields.proceedingsTitle,
      "Neural Information Processing Systems",
    );
    assert.isUndefined(m.fields.volume, "arXiv pseudo-volume is dropped");
    assert.include(m.extra, "arXiv: 1706.03762");
  });

  it("maps an arXiv-only paper to a preprint", function () {
    const m = s2ToZotero(ARXIV_ONLY);
    assert.equal(m.itemType, "preprint");
    assert.equal(m.fields.repository, "arXiv");
    assert.equal(m.fields.archiveID, "arXiv:2401.00001");
    assert.equal(m.fields.url, "https://arxiv.org/abs/2401.00001");
    assert.isUndefined(m.fields.abstractNote);
    assert.deepEqual(m.creators[0], {
      firstName: "Ludwig",
      lastName: "van Beethoven",
      creatorType: "author",
    });
  });
});

describe("splitName", function () {
  it("handles comma form, single names and suffixes", function () {
    assert.deepEqual(splitName("Curie, Marie"), {
      firstName: "Marie",
      lastName: "Curie",
      creatorType: "author",
    });
    assert.equal(splitName("Plato").lastName, "Plato");
    assert.equal(splitName("Martin Luther King Jr.").lastName, "King Jr.");
  });
});

describe("mergeExtra", function () {
  it("adds only missing keys", function () {
    assert.equal(
      mergeExtra("CorpusID: 1\nfoo", ["CorpusID: 2", "S2 Paper ID: abc"]),
      "CorpusID: 1\nfoo\nS2 Paper ID: abc",
    );
    assert.equal(mergeExtra("", ["A: 1"]), "A: 1");
  });
});

describe("parseIdentifier", function () {
  const cases: Array<[string, string]> = [
    ["DOI:10.1038/NATURE14539", "DOI:10.1038/nature14539"],
    ["https://doi.org/10.1038/nature14539", "DOI:10.1038/nature14539"],
    ["10.1038/nature14539", "DOI:10.1038/nature14539"],
    ["arXiv:1706.03762v5", "ARXIV:1706.03762"],
    ["https://arxiv.org/abs/1706.03762v2", "ARXIV:1706.03762"],
    ["https://arxiv.org/pdf/1706.03762.pdf", "ARXIV:1706.03762"],
    ["1706.03762", "ARXIV:1706.03762"],
    ["CorpusId:13756489", "CorpusId:13756489"],
    [
      "204E3073870FAE3D05BCBC2F6A8E263D9B72E776",
      "204e3073870fae3d05bcbc2f6a8e263d9b72e776",
    ],
    ["PMID:26017442", "PMID:26017442"],
    [
      "https://www.nature.com/articles/x",
      "URL:https://www.nature.com/articles/x",
    ],
  ];
  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, function () {
      assert.equal(parseIdentifier(input).s2Query, expected);
    });
  }
});
