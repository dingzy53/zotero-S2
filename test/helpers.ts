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
 * CorpusId: and paperId; everything else returns `fallback`.
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
    return response(404, { error: "not in fixtures" });
  };
  return new S2Client({
    apiKey: () => "test-key",
    transport,
    limiter: new RateLimiter(0, clock.now, clock.sleep),
    sleep: clock.sleep,
  });
}
