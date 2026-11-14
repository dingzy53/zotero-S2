import { assert } from "chai";
import {
  classifyItemType,
  mergeExtra,
  s2ToZotero,
  splitName,
} from "../src/zotero/s2ToZotero";
import type { S2Paper } from "../src/s2/types";
import { parseIdentifier } from "../src/zotero/identifiers";
import { compactSnippet } from "../src/s2/fields";
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

// [what it is, paper, expected type, certain]
const TYPE_CASES: Array<[string, Omit<S2Paper, "paperId">, string, boolean]> = [
  [
    // Saved as a journal article before; S2 had no type for it
    "IEEE conference DOI, no type from S2",
    {
      externalIds: { DOI: "10.1109/ICPSAsia55496.2022.9949832" },
      venue:
        "2022 IEEE/IAS Industrial and Commercial Power System Asia (I&CPS Asia)",
      publicationTypes: null,
    },
    "conferencePaper",
    true,
  ],
  [
    "IEEE conference DOI that S2 files as a journal article",
    {
      externalIds: { DOI: "10.1109/PESGM58988.2026.11693499" },
      venue: "IEEE Power & Energy Society General Meeting",
      publicationTypes: ["JournalArticle"],
    },
    "conferencePaper",
    true,
  ],
  [
    "IEEE journal DOI",
    {
      externalIds: { DOI: "10.1109/TPWRS.2020.2971234" },
      venue: "IEEE Transactions on Power Systems",
      publicationTypes: null,
    },
    "journalArticle",
    false,
  ],
  [
    "a journal with Proceedings in its name",
    {
      externalIds: { DOI: "10.1109/JPROC.2015.2494218" },
      venue: "Proceedings of the IEEE",
      publicationTypes: [],
    },
    "journalArticle",
    false,
  ],
  [
    "conference venue name, no type from S2",
    {
      venue: "International Conference on Machine Learning",
      publicationTypes: null,
    },
    "conferencePaper",
    true,
  ],
  [
    "workshop named only in publicationVenue",
    {
      publicationVenue: {
        name: "NeurIPS Workshop on Tackling Climate Change",
      },
    },
    "conferencePaper",
    true,
  ],
  [
    // The venue name is only consulted when S2 is silent
    "S2 says journal article, venue mentions a symposium",
    {
      venue: "Symposium on Theory of Computing Review",
      publicationTypes: ["JournalArticle"],
    },
    "journalArticle",
    true,
  ],
  [
    "S2 venue type journal",
    { publicationVenue: { name: "Nature", type: "journal" } },
    "journalArticle",
    true,
  ],
  ["nothing known", {}, "journalArticle", false],
  [
    "S2 type Conference",
    { publicationTypes: ["JournalArticle", "Conference"] },
    "conferencePaper",
    true,
  ],
  ["book", { publicationTypes: ["Book"] }, "book", true],
];

describe("classifyItemType", function () {
  for (const [label, p, itemType, certain] of TYPE_CASES) {
    it(`${label} → ${itemType}`, function () {
      assert.deepEqual(classifyItemType({ paperId: "x", ...p }), {
        itemType,
        certain,
      });
    });
  }

  it("maps a detected conference paper's venue to proceedingsTitle", function () {
    const m = s2ToZotero({ paperId: "x", ...TYPE_CASES[0][1] });
    assert.equal(m.itemType, "conferencePaper");
    assert.match(m.fields.proceedingsTitle, /Power System Asia/);
    assert.isUndefined(m.fields.publicationTitle);
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

describe("compactSnippet", function () {
  it("keeps the text and a usable paper id, drops the disclaimer", function () {
    const row = compactSnippet({
      score: 0.56,
      snippet: {
        text: "We describe deployed models.",
        snippetKind: "body",
        section: "Conclusion",
      },
      paper: {
        corpusId: "19170988",
        title: "Construction of the Literature Graph in Semantic Scholar",
        authors: Array.from({ length: 10 }, (_, i) => `Author ${i}`),
        openAccessInfo: { disclaimer: "Notice: …" },
      } as any,
    });
    assert.deepEqual(row.paper.id, "CorpusId:19170988");
    assert.equal(row.kind, "body");
    assert.lengthOf(row.paper.authors, 9);
    assert.equal(row.paper.authors[8], "+2 more");
    assert.notProperty(row.paper, "openAccessInfo");
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
    ["pmid: 26017442", "PMID:26017442"],
    ["pmcid:2323736", "PMCID:2323736"],
    [
      "https://www.nature.com/articles/x",
      "URL:https://www.nature.com/articles/x",
    ],
    // S2 answers 400 to a doi.org URL behind `URL:`, so we unwrap it
    [
      "URL:https://doi.org/10.1016/j.tra.2023.103774",
      "DOI:10.1016/j.tra.2023.103774",
    ],
    ["url:https://arxiv.org/abs/1706.03762v2", "ARXIV:1706.03762"],
    ["URL:10.1038/nature14539", "DOI:10.1038/nature14539"],
    [
      "URL: https://www.nature.com/articles/x",
      "URL:https://www.nature.com/articles/x",
    ],
  ];
  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, function () {
      assert.equal(parseIdentifier(input).s2Query, expected);
    });
  }
});
