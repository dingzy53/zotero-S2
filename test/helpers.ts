import { S2Client, Transport, TransportResponse } from "../src/s2/client";
import { RateLimiter } from "../src/s2/rateLimiter";
import type { S2Paper } from "../src/s2/types";
import { FIXTURES } from "./fixtures";

/** Deterministic clock: `sleep` advances time instantly and is recorded. */
export function fakeClock() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

export function response(
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
): TransportResponse {
  return {
    status,
    body,
    header: (name) => headers[name] ?? headers[name.toLowerCase()] ?? null,
  };
}

/**
 * S2 client backed by the fixtures: `/paper/batch` resolves DOI:, ARXIV:,
 * CorpusId: and paperId. Searches, author papers, citations, references and
 * recommendations all return the fixture list (bulk search in two token
 * pages); anything else is a 404.
 */
export function fixtureClient(
  papers: S2Paper[] = FIXTURES,
  calls: string[] = [],
): S2Client {
  const clock = fakeClock();
  const find = (id: string) =>
    papers.find((p) => {
      const lower = id.toLowerCase();
      return (
        p.paperId === lower ||
        (p.externalIds?.DOI &&
          lower === `doi:${p.externalIds.DOI.toLowerCase()}`) ||
        (p.externalIds?.ArXiv && lower === `arxiv:${p.externalIds.ArXiv}`) ||
        lower === `corpusid:${p.corpusId}`
      );
    }) ?? null;
  const transport: Transport = async (method, url, _headers, body) => {
    calls.push(`${method} ${url}`);
    if (url.includes("/paper/batch")) {
      const ids: string[] = JSON.parse(body!).ids;
      return response(200, ids.map(find));
    }
    if (url.includes("/paper/search/match")) {
      const q = new URL(url).searchParams.get("query")?.toLowerCase();
      const hit = papers.find((p) => p.title?.toLowerCase() === q);
      return hit
        ? response(200, { data: [{ ...hit, matchScore: 99 }] })
        : response(404, { error: "Title match not found" });
    }
    const params = new URL(url).searchParams;
    const offset = Number(params.get("offset") ?? 0);
    const limit = Number(params.get("limit") ?? 100);
    const paged = (rows: unknown[]) => ({
      total: rows.length,
      offset,
      ...(offset + limit < rows.length ? { next: offset + limit } : {}),
      data: rows.slice(offset, offset + limit),
    });
    if (url.includes("/paper/search/bulk")) {
      const half = Math.ceil(papers.length / 2);
      return params.get("token") === "page2"
        ? response(200, { total: papers.length, data: papers.slice(half) })
        : response(200, {
            total: papers.length,
            token: "page2",
            data: papers.slice(0, half),
          });
    }
    if (url.includes("/paper/search")) return response(200, paged(papers));
    if (url.includes("/author/search")) {
      return response(
        200,
        paged([
          {
            authorId: "40348417",
            name: "Ashish Vaswani",
            affiliations: ["Google"],
            paperCount: 60,
            citationCount: 160000,
            hIndex: 30,
          },
        ]),
      );
    }
    if (/\/author\/[^/]+\/papers/.test(url))
      return response(200, paged(papers));
    if (/\/paper\/[^/]+\/citations/.test(url))
      return response(200, paged(papers.map((p) => ({ citingPaper: p }))));
    if (/\/paper\/[^/]+\/references/.test(url))
      return response(200, paged(papers.map((p) => ({ citedPaper: p }))));
    if (url.includes("/recommendations/"))
      return response(200, { recommendedPapers: papers });
    return response(404, { error: "not in fixtures" });
  };
  return new S2Client({
    apiKey: () => "test-key",
    transport,
    limiter: new RateLimiter(0, clock.now, clock.sleep),
    sleep: clock.sleep,
  });
}
