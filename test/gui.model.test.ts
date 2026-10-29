import { assert } from "chai";
import {
  activeFilterCount,
  canNext,
  canPrev,
  dateParam,
  detectIdentifier,
  emptyFilters,
  filterArgs,
  offsetPaging,
  pageArgs,
  pageRange,
  papersFromResult,
  planSearch,
  relevanceQuery,
  sortPapers,
  validateFilters,
  yearParam,
} from "../src/gui/model";
import { GUI_FIELDS } from "../src/s2/fields";
import { ATTENTION, DEEP_LEARNING, ARXIV_ONLY } from "./fixtures";

const form = (over: Partial<Parameters<typeof planSearch>[0]> = {}) => ({
  mode: "simple" as const,
  query: "attention",
  filters: emptyFilters(),
  sort: "",
  pageSize: 25,
  ...over,
});

describe("gui model: filters", function () {
  it("builds S2 year and date ranges", function () {
    assert.equal(yearParam("2016", "2020"), "2016-2020");
    assert.equal(yearParam("2010", ""), "2010-");
    assert.equal(yearParam("", "2015"), "-2015");
    assert.equal(yearParam("2019", "2019"), "2019");
    assert.isUndefined(yearParam(" ", ""));
    assert.equal(dateParam("2019-03-05", "2020-06"), "2019-03-05:2020-06");
    assert.equal(dateParam("2021", ""), "2021:");
    assert.isUndefined(dateParam("", ""));
  });

  it("maps every filter onto the tools' argument names", function () {
    const args = filterArgs({
      ...emptyFilters(),
      yearFrom: "2017",
      venue: " Nature , ,NeurIPS ",
      fieldsOfStudy: ["Computer Science", "Medicine"],
      publicationTypes: ["Review"],
      minCitations: "50",
      openAccess: true,
    });
    assert.deepEqual(args, {
      year: "2017-",
      publicationDateOrYear: undefined,
      venue: "Nature,NeurIPS",
      fieldsOfStudy: "Computer Science,Medicine",
      publicationTypes: "Review",
      minCitationCount: 50,
      openAccessPdf: true,
    });
    assert.equal(activeFilterCount(emptyFilters()), 0);
    assert.isUndefined(filterArgs(emptyFilters()).openAccessPdf);
  });

  it("rejects malformed or reversed ranges", function () {
    const f = emptyFilters();
    assert.isNull(validateFilters(f));
    assert.equal(validateFilters({ ...f, yearFrom: "17" }), "year-format");
    assert.equal(
      validateFilters({ ...f, yearFrom: "2020", yearTo: "2019" }),
      "year-order",
    );
    assert.equal(validateFilters({ ...f, dateFrom: "2019/03" }), "date-format");
    assert.equal(
      validateFilters({ ...f, dateFrom: "2020", dateTo: "2019-05" }),
      "date-order",
    );
    assert.isNull(
      validateFilters({ ...f, dateFrom: "2019-03", dateTo: "2019" }),
    );
    assert.equal(validateFilters({ ...f, minCitations: "ten" }), "citations");
  });
});

describe("gui model: queries", function () {
  it("replaces hyphens for relevance search only", function () {
    assert.equal(
      relevanceQuery("self-supervised  learning"),
      "self supervised learning",
    );
    const simple = planSearch(form({ query: "self-supervised" }));
    assert.equal(simple.kind, "papers");
    if (simple.kind !== "papers") return;
    assert.isTrue(simple.rewritten);
    assert.equal(simple.request.args.query, "self supervised");

    const bulk = planSearch(form({ mode: "bulk", query: "graph -quantum" }));
    assert.equal(bulk.kind, "papers");
    if (bulk.kind !== "papers") return;
    assert.equal(bulk.request.tool, "s2_search_papers_bulk");
    assert.equal(bulk.request.args.query, "graph -quantum");
    assert.equal(bulk.request.args.max_results, 1000);

    const authors = planSearch(form({ mode: "authors", query: "Jean-Paul" }));
    assert.equal(authors.kind, "authors");
    if (authors.kind === "authors")
      assert.equal(authors.request.args.query, "Jean Paul");
  });

  it("detects ids typed into simple search", function () {
    assert.equal(
      detectIdentifier("10.1038/nature14539"),
      "DOI:10.1038/nature14539",
    );
    assert.equal(
      detectIdentifier("https://doi.org/10.1038/NATURE14539"),
      "DOI:10.1038/nature14539",
    );
    assert.equal(detectIdentifier("1706.03762v5"), "ARXIV:1706.03762");
    assert.equal(
      detectIdentifier("arxiv.org/abs/1706.03762"),
      "ARXIV:1706.03762",
    );
    assert.equal(detectIdentifier("CorpusId:13756489"), "CorpusId:13756489");
    assert.equal(detectIdentifier(ATTENTION.paperId), ATTENTION.paperId);
    assert.equal(detectIdentifier("PMID:19872477"), "PMID:19872477");
    assert.equal(
      detectIdentifier("https://example.org/paper"),
      "URL:https://example.org/paper",
    );
    assert.isNull(detectIdentifier("Transformers: a survey"));
    assert.isNull(detectIdentifier("Transformers:survey"));
    assert.isNull(detectIdentifier("attention is all you need"));
    assert.isNull(detectIdentifier("see 10.1038/nature14539"));

    const plan = planSearch(form({ query: " 10.1038/nature14539 " }));
    assert.equal(plan.kind, "lookup");
    if (plan.kind === "lookup")
      assert.deepEqual(plan.request, {
        tool: "s2_get_papers",
        args: { ids: ["DOI:10.1038/nature14539"], fields: GUI_FIELDS },
      });
    // Advanced mode always searches
    assert.equal(
      planSearch(form({ mode: "advanced", query: "1706.03762" })).kind,
      "papers",
    );
  });

  it("applies filters only in advanced and boolean modes", function () {
    const filters = { ...emptyFilters(), yearFrom: "2017" };
    const simple = planSearch(form({ filters }));
    const advanced = planSearch(form({ mode: "advanced", filters }));
    assert.isTrue(simple.kind === "papers" && !("year" in simple.request.args));
    assert.isTrue(
      advanced.kind === "papers" && advanced.request.args.year === "2017-",
    );
    const bad = planSearch(
      form({ mode: "advanced", filters: { ...filters, yearTo: "2000" } }),
    );
    assert.deepEqual(bad, { kind: "error", error: "year-order" });
    assert.deepEqual(planSearch(form({ query: "  " })), {
      kind: "error",
      error: "empty",
    });
    assert.deepEqual(planSearch(form({ query: " - " })), {
      kind: "error",
      error: "empty",
    });
  });
});

describe("gui model: paging", function () {
  it("stops relevance paging at 1,000 results", function () {
    let p = offsetPaging({ offset: 0, next: 25, total: 5000 }, 25, 1000);
    assert.isFalse(canPrev(p));
    assert.isTrue(canNext(p));
    assert.deepEqual(pageArgs(p, "next"), { offset: 25, limit: 25 });
    assert.isNull(pageArgs(p, "prev"));
    p = offsetPaging({ offset: 975, next: 1000, total: 5000 }, 25, 1000);
    assert.isFalse(canNext(p));
    assert.deepEqual(pageArgs(p, "prev"), { offset: 950, limit: 25 });
    p = offsetPaging({ offset: 900, next: 1000, total: 5000 }, 100, 1000);
    assert.isFalse(canNext(p));
    p = offsetPaging({ offset: 30, next: 60, total: 5000 }, 30, 1000);
    assert.deepEqual(pageArgs(p, "prev"), { offset: 0, limit: 30 });
    assert.deepEqual(pageRange(p, 30), { first: 31, last: 60 });
  });

  it("follows bulk tokens until there are none", function () {
    assert.deepEqual(pageArgs({ kind: "token", token: "abc" }, "next"), {
      token: "abc",
    });
    assert.isFalse(canNext({ kind: "token", token: null }));
    assert.isFalse(canPrev({ kind: "token", token: "abc" }));
  });
});

describe("gui model: results", function () {
  it("unwraps citations and drops stubs without a paperId", function () {
    const value = {
      data: [
        { citingPaper: ATTENTION },
        { citingPaper: { paperId: null, title: "stub" } },
      ],
    };
    assert.deepEqual(papersFromResult("s2_get_citations", value), [ATTENTION]);
    assert.deepEqual(
      papersFromResult("s2_get_references", {
        data: [{ citedPaper: DEEP_LEARNING }],
      }),
      [DEEP_LEARNING],
    );
    assert.deepEqual(
      papersFromResult("s2_get_papers", {
        papers: [
          { id: "x", found: false, paper: null },
          { id: "y", found: true, paper: ATTENTION },
        ],
      }),
      [ATTENTION],
    );
    assert.deepEqual(
      papersFromResult("s2_search_papers", { papers: [ARXIV_ONLY] }),
      [ARXIV_ONLY],
    );
  });

  it("sorts on the client, keeping missing values last", function () {
    const noYear = { ...ARXIV_ONLY, paperId: "n", year: null };
    const list = [ATTENTION, noYear, DEEP_LEARNING];
    assert.deepEqual(
      sortPapers(list, "year", false).map((p) => p.paperId),
      [DEEP_LEARNING.paperId, ATTENTION.paperId, "n"],
    );
    assert.equal(sortPapers(list, "year", true).at(-1)!.paperId, "n");
    assert.deepEqual(sortPapers(list, null, false), list);
  });
});
