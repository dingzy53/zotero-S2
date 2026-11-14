import { RateLimiter, Sleep, defaultSleep } from "./rateLimiter";
import {
  AUTHOR_FIELDS,
  FULL_FIELDS,
  SEARCH_FIELDS,
  SNIPPET_FIELDS,
} from "./fields";
import { CallStats, S2Paper } from "./types";

export const GRAPH_BASE = "https://api.semanticscholar.org/graph/v1";
export const RECS_BASE = "https://api.semanticscholar.org/recommendations/v1";

/** S2 keyed limit is 1 req/s; the margin absorbs clock jitter. */
export const S2_INTERVAL_MS = 1050;
export const MAX_RETRIES = 6;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;
const JITTER_MS = 500;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const TRANSPORT_TIMEOUT_MS = 30_000;
/** A request needs some time to be worth starting. */
const MIN_TIMEOUT_MS = 1000;

export interface TransportResponse {
  status: number;
  body: any;
  header(name: string): string | null;
}

export type Transport = (
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
  timeoutMs?: number,
) => Promise<TransportResponse>;

export class S2Error extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly attempts: number,
  ) {
    super(message);
    this.name = "S2Error";
  }
}

const zoteroTransport: Transport = async (
  method,
  url,
  headers,
  body,
  timeoutMs = TRANSPORT_TIMEOUT_MS,
) => {
  const xhr = await Zotero.HTTP.request(method, url, {
    headers,
    body,
    responseType: "json",
    successCodes: false,
    // Retries are ours, so they stay inside the rate limit
    errorDelayMax: 0,
    timeout: timeoutMs,
  } as any);
  return {
    status: xhr.status,
    body: xhr.response,
    header: (name) => xhr.getResponseHeader(name),
  };
};

/** Delay before retry `attempt` (0-based): exponential, capped, jittered. */
export function backoffDelay(
  attempt: number,
  retryAfterHeader: string | null,
  random: () => number = Math.random,
): number {
  let delay =
    Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt) + random() * JITTER_MS;
  const retryAfter = parseRetryAfter(retryAfterHeader);
  if (retryAfter !== null && retryAfter > delay) {
    delay = Math.min(retryAfter, MAX_DELAY_MS);
  }
  return delay;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function encodeId(id: string): string {
  return encodeURIComponent(id.trim())
    .replace(/%2F/gi, "/")
    .replace(/%3A/gi, ":");
}

type Query = Record<string, string | number | boolean | undefined | null>;

export interface S2ClientOptions {
  apiKey: () => string;
  transport?: Transport;
  limiter?: RateLimiter;
  sleep?: Sleep;
  random?: () => number;
  now?: () => number;
}

export class S2Client {
  private readonly transport: Transport;
  private readonly limiter: RateLimiter;
  private readonly sleep: Sleep;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(private readonly opts: S2ClientOptions) {
    this.transport = opts.transport ?? zoteroTransport;
    this.limiter = opts.limiter ?? new RateLimiter(S2_INTERVAL_MS);
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * With `stats.deadline` set, the call fails with an `S2Error` instead of
   * running past it: MCP clients give up after about a minute, and the agent
   * would then get no answer at all.
   */
  async request(
    url: string,
    stats: CallStats,
    options: { method?: "GET" | "POST"; query?: Query; body?: unknown } = {},
  ): Promise<any> {
    const apiKey = this.opts.apiKey().trim();
    if (!apiKey) {
      throw new S2Error(
        "No Semantic Scholar API key set. Add one in Zotero → Settings → Zotero S2.",
        null,
        0,
      );
    }
    const method = options.method ?? "GET";
    const fullURL = url + buildQuery(options.query);
    const headers: Record<string, string> = { "x-api-key": apiKey };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const { deadline } = stats;
    const outOfTime = (status: number | null, attempts: number) => {
      const why = !attempts
        ? "requests are queued (1 per second, shared by all calls) and this one's turn came too late"
        : status === 429
          ? `is rate-limiting this API key; stopped after ${attempts} attempt(s)`
          : `${status ? `is failing (status ${status})` : "did not answer"}; stopped after ${attempts} attempt(s)`;
      return new S2Error(
        `Semantic Scholar ${why} to stay within this call's time limit. Nothing is wrong with the request: wait a few seconds and call again.`,
        status,
        attempts,
      );
    };

    for (let attempt = 0; ; attempt++) {
      let res: TransportResponse | null = null;
      let networkError: unknown = null;
      // Decided when our slot comes up: the queue may have used up the budget
      let skipped = false;
      try {
        res = await this.limiter.schedule(async () => {
          if (deadline === undefined) {
            return this.transport(method, fullURL, headers, body);
          }
          const left = deadline - this.now();
          if (left < MIN_TIMEOUT_MS) {
            skipped = true;
            return null;
          }
          return this.transport(
            method,
            fullURL,
            headers,
            body,
            Math.min(TRANSPORT_TIMEOUT_MS, left),
          );
        });
      } catch (e) {
        networkError = e;
      }
      if (skipped) throw outOfTime(null, attempt);
      stats.s2Calls++;

      if (res && res.status >= 200 && res.status < 300) return res.body;

      const status = res?.status || null;
      const retriable =
        !res || res.status === 0 || RETRY_STATUSES.has(res.status);
      if (!retriable || attempt >= MAX_RETRIES) {
        throw new S2Error(
          describeFailure(status, res?.body, networkError, attempt + 1),
          status,
          attempt + 1,
        );
      }
      const retryAfterHeader = res?.header("Retry-After") ?? null;
      const retryAfter = parseRetryAfter(retryAfterHeader);
      // Waiting longer would stall this call and, via pause(), every other one
      if (retryAfter !== null && retryAfter > MAX_DELAY_MS) {
        const why =
          status === 429 ? "is rate-limiting this API key" : "is unavailable";
        throw new S2Error(
          `Semantic Scholar ${why} and asked to wait ${Math.ceil(retryAfter / 1000)} s (status ${status}). Try again later.`,
          status,
          attempt + 1,
        );
      }
      const delay = backoffDelay(attempt, retryAfterHeader, this.random);
      // A 429 is about the key, not this request: hold every caller back
      if (res?.status === 429) this.limiter.pause(delay);
      // Sleeping past the deadline can't produce an answer the client reads
      if (deadline !== undefined && this.now() + delay > deadline) {
        throw outOfTime(status, attempt + 1);
      }
      stats.retries++;
      await this.sleep(delay);
    }
  }

  // --- Graph API wrappers ---

  searchPapers(stats: CallStats, query: Query) {
    return this.request(`${GRAPH_BASE}/paper/search`, stats, {
      query: { fields: SEARCH_FIELDS, ...query },
    });
  }

  searchPapersBulk(stats: CallStats, query: Query) {
    return this.request(`${GRAPH_BASE}/paper/search/bulk`, stats, {
      query: { fields: SEARCH_FIELDS, ...query },
    });
  }

  /** The closest title match, or `null` when S2 finds none. */
  async matchTitle(
    stats: CallStats,
    title: string,
    fields = SEARCH_FIELDS,
  ): Promise<(S2Paper & { matchScore?: number }) | null> {
    try {
      const res = await this.request(
        `${GRAPH_BASE}/paper/search/match`,
        stats,
        {
          query: { query: title, fields },
        },
      );
      return res?.data?.[0] ?? null;
    } catch (e) {
      // S2 answers 404 "Title match not found"; anything else is a real failure
      if (e instanceof S2Error && e.status === 404) return null;
      throw e;
    }
  }

  /** Returns one entry per id, `null` where S2 has no match. */
  async paperBatch(
    stats: CallStats,
    ids: string[],
    fields = FULL_FIELDS,
  ): Promise<Array<S2Paper | null>> {
    if (!ids.length) return [];
    return this.request(`${GRAPH_BASE}/paper/batch`, stats, {
      method: "POST",
      query: { fields },
      body: { ids: ids.map((id) => id.trim()) },
    });
  }

  paperRelations(
    stats: CallStats,
    kind: "citations" | "references",
    id: string,
    query: Query,
  ) {
    return this.request(`${GRAPH_BASE}/paper/${encodeId(id)}/${kind}`, stats, {
      query,
    });
  }

  recommendForPaper(stats: CallStats, id: string, query: Query) {
    return this.request(`${RECS_BASE}/papers/forpaper/${encodeId(id)}`, stats, {
      query: { fields: SEARCH_FIELDS, ...query },
    });
  }

  recommendFromLists(
    stats: CallStats,
    positive: string[],
    negative: string[],
    query: Query,
  ) {
    return this.request(`${RECS_BASE}/papers/`, stats, {
      method: "POST",
      query: { fields: SEARCH_FIELDS, ...query },
      body: { positivePaperIds: positive, negativePaperIds: negative },
    });
  }

  searchAuthors(stats: CallStats, query: Query) {
    return this.request(`${GRAPH_BASE}/author/search`, stats, {
      query: { fields: AUTHOR_FIELDS, ...query },
    });
  }

  authorPapers(stats: CallStats, authorId: string, query: Query) {
    return this.request(
      `${GRAPH_BASE}/author/${encodeId(authorId)}/papers`,
      stats,
      { query: { fields: SEARCH_FIELDS, ...query } },
    );
  }

  snippetSearch(stats: CallStats, query: Query) {
    return this.request(`${GRAPH_BASE}/snippet/search`, stats, {
      query: { fields: SNIPPET_FIELDS, ...query },
    });
  }
}

function buildQuery(query?: Query): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    // `""` is kept: flags like `openAccessPdf` take no value
    if (value === undefined || value === null || value === false) continue;
    params.set(key, String(value));
  }
  const str = params.toString();
  return str ? `?${str}` : "";
}

function describeFailure(
  status: number | null,
  body: any,
  networkError: unknown,
  attempts: number,
): string {
  const detail =
    (body && (body.error || body.message)) ||
    (networkError instanceof Error ? networkError.message : networkError) ||
    "no response";
  let msg = `Semantic Scholar request failed (${status ?? "network error"}) after ${attempts} attempt(s): ${detail}`;
  if (status === 401 || status === 403) {
    msg += ". Check the API key in Zotero → Settings → Zotero S2.";
  }
  return msg;
}
