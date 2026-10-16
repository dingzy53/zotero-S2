import { assert } from "chai";
import {
  MAX_RETRIES,
  S2Client,
  S2Error,
  Transport,
  backoffDelay,
} from "../src/s2/client";
import { RateLimiter } from "../src/s2/rateLimiter";
import { newStats } from "../src/s2/types";
import { fakeClock, response } from "./helpers";

function client(replies: Array<() => ReturnType<Transport>>, apiKey = "k") {
  const clock = fakeClock();
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  let i = 0;
  const transport: Transport = (_m, url, headers) => {
    seen.push({ url, headers });
    const next = replies[Math.min(i++, replies.length - 1)];
    return next();
  };
  const s2 = new S2Client({
    apiKey: () => apiKey,
    transport,
    limiter: new RateLimiter(1050, clock.now, clock.sleep),
    sleep: clock.sleep,
    random: () => 0,
  });
  return { s2, clock, seen };
}

describe("RateLimiter", function () {
  it("spaces request starts at least 1050 ms apart", async function () {
    const clock = fakeClock();
    const limiter = new RateLimiter(1050, clock.now, clock.sleep);
    const starts: number[] = [];
    await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        limiter.schedule(async () => {
          starts.push(clock.now());
        }),
      ),
    );
    assert.lengthOf(starts, 5);
    for (let i = 1; i < starts.length; i++) {
      assert.isAtLeast(starts[i] - starts[i - 1], 1050);
    }
  });

  it("keeps going after a task throws", async function () {
    const clock = fakeClock();
    const limiter = new RateLimiter(1050, clock.now, clock.sleep);
    const failed = limiter.schedule(async () => {
      throw new Error("boom");
    });
    const ok = limiter.schedule(async () => "ok");
    await failed.catch(() => {});
    assert.equal(await ok, "ok");
  });
});

describe("backoffDelay", function () {
  it("doubles from 1 s and caps at 60 s", function () {
    const zero = () => 0;
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 6, 7].map((n) => backoffDelay(n, null, zero)),
      [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000],
    );
  });

  it("adds at most 500 ms of jitter", function () {
    assert.equal(
      backoffDelay(0, null, () => 0.999),
      1000 + 0.999 * 500,
    );
  });

  it("honors a larger Retry-After", function () {
    assert.equal(
      backoffDelay(0, "5", () => 0),
      5000,
    );
    assert.equal(
      backoffDelay(3, "1", () => 0),
      8000,
    );
  });
});

describe("S2Client", function () {
  it("sends the API key header", async function () {
    const { s2, seen } = client([async () => response(200, { data: [] })]);
    await s2.searchPapers(newStats(), { query: "x" });
    assert.equal(seen[0].headers["x-api-key"], "k");
  });

  it("refuses to call without an API key", async function () {
    const { s2, seen } = client([async () => response(200, {})], "  ");
    const err = await s2
      .searchPapers(newStats(), { query: "x" })
      .catch((e) => e);
    assert.instanceOf(err, S2Error);
    assert.match(err.message, /No Semantic Scholar API key/);
    assert.lengthOf(seen, 0);
  });

  it("retries 429 and 503 with backoff, honoring Retry-After", async function () {
    const { s2, clock } = client([
      async () =>
        response(429, { message: "Too Many Requests" }, { "Retry-After": "3" }),
      async () => response(503, {}),
      async () => response(200, { data: ["ok"] }),
    ]);
    const stats = newStats();
    const body = await s2.searchPapers(stats, { query: "x" });
    assert.deepEqual(body, { data: ["ok"] });
    assert.equal(stats.s2Calls, 3);
    assert.equal(stats.retries, 2);
    // Backoff sleeps (3000 from Retry-After, then 2000) interleave with limiter waits
    assert.include(clock.sleeps, 3000);
    assert.include(clock.sleeps, 2000);
  });

  it("retries network errors (status 0 / thrown)", async function () {
    const { s2 } = client([
      async () => {
        throw new Error("offline");
      },
      async () => response(0, null),
      async () => response(200, { ok: true }),
    ]);
    const stats = newStats();
    assert.deepEqual(await s2.searchPapers(stats, { query: "x" }), {
      ok: true,
    });
    assert.equal(stats.retries, 2);
  });

  it(`gives up after ${MAX_RETRIES} retries`, async function () {
    const { s2, clock } = client([
      async () => response(503, { message: "busy" }),
    ]);
    const stats = newStats();
    const err = await s2.searchPapers(stats, { query: "x" }).catch((e) => e);
    assert.instanceOf(err, S2Error);
    assert.equal(err.status, 503);
    assert.equal(err.attempts, MAX_RETRIES + 1);
    assert.equal(stats.s2Calls, MAX_RETRIES + 1);
    for (const d of [1000, 2000, 4000, 8000, 16000, 32000]) {
      assert.include(clock.sleeps, d);
    }
  });

  it("does not retry 4xx and explains auth failures", async function () {
    const { s2 } = client([
      async () => response(403, { message: "Forbidden" }),
    ]);
    const stats = newStats();
    const err = await s2.searchPapers(stats, { query: "x" }).catch((e) => e);
    assert.equal(err.attempts, 1);
    assert.equal(stats.s2Calls, 1);
    assert.match(err.message, /Forbidden.*Check the API key/);
  });

  it("keeps request spacing across retries (real timers, scaled down)", async function () {
    // Limiter at 100 ms; backoff sleeps scaled 1/20 so 1000 ms → 50 ms
    const starts: number[] = [];
    let n = 0;
    const s2 = new S2Client({
      apiKey: () => "k",
      transport: async () => {
        starts.push(Date.now());
        return n++ < 3 ? response(429, {}) : response(200, {});
      },
      limiter: new RateLimiter(100),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms / 20)),
      random: () => 0,
    });
    await Promise.all(
      ["a", "b", "c"].map((q) => s2.searchPapers(newStats(), { query: q })),
    );
    assert.isAtLeast(starts.length, 6);
    for (let i = 1; i < starts.length; i++) {
      // 5 ms of timer slack
      assert.isAtLeast(starts[i] - starts[i - 1], 95);
    }
  });

  it("builds the batch request and flag-style query params", async function () {
    const { s2, seen } = client([async () => response(200, [null])]);
    await s2.paperBatch(newStats(), ["DOI:10.1/x"]);
    assert.match(seen[0].url, /\/paper\/batch\?fields=/);
    const { s2: s2b, seen: seenB } = client([async () => response(200, {})]);
    await s2b.searchPapers(newStats(), {
      query: "q",
      openAccessPdf: "",
      year: undefined,
    });
    assert.match(seenB[0].url, /openAccessPdf=(&|$)/);
    assert.notMatch(seenB[0].url, /year=/);
  });
});
