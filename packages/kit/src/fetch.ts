import { effectiveConcurrency, HEAVY_METHODS } from "./constants.js";
import { Throttle, sleep, type ThrottleStats } from "./rate-limit.js";

export type FetchLike = (input: any, init?: any) => Promise<Response>;

export interface RateLimitInfo {
  status: number;
  /** Requests used in the current 5s window. */
  short?: number;
  shortLimit?: number;
  shortWindowMs?: number;
  /** Requests used in the current 1h window. */
  long?: number;
  longLimit?: number;
  longWindowMs?: number;
  /** Heavy-method requests used in the current 5s window. */
  heavy?: number;
  heavyLimit?: number;
  heavyWindowMs?: number;
  /** Open connections right now. */
  connections?: number;
  connectionLimit?: number;
}

export interface RetryInfo {
  attempt: number;
  method: string | null;
  reason: string;
  delayMs: number;
  status?: number;
}

export interface X1FetchOptions {
  throttle: Throttle;
  /** Retries after the first attempt. Default 4. */
  maxRetries?: number;
  /**
   * Learn the real caps from the `X-RateLimit-*` headers instead of trusting
   * the documented defaults. Default true. Only turn this off if you are
   * wrapping an endpoint that sends misleading headers.
   */
  adaptive?: boolean;
  onRateLimit?: (info: RateLimitInfo) => void;
  onRetry?: (info: RetryInfo) => void;
  baseFetch?: FetchLike;
  userAgent?: string;
}

export interface X1Fetch extends FetchLike {
  throttle: Throttle;
  stats(): ThrottleStats;
}

function headerNumber(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** Parses `5s`, `1h`, `250ms` into milliseconds. */
function parseDuration(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/i.exec(raw.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  switch (match[2]!.toLowerCase()) {
    case "ms":
      return value;
    case "s":
      return value * 1_000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    default:
      return undefined;
  }
}

export function parseRateLimitHeaders(status: number, headers: Headers): RateLimitInfo {
  return {
    status,
    short: headerNumber(headers, "x-ratelimit-rate-short"),
    shortLimit: headerNumber(headers, "x-ratelimit-limit-short"),
    shortWindowMs: parseDuration(headers.get("x-ratelimit-reset-short")),
    long: headerNumber(headers, "x-ratelimit-rate-long"),
    longLimit: headerNumber(headers, "x-ratelimit-limit-long"),
    longWindowMs: parseDuration(headers.get("x-ratelimit-reset-long")),
    heavy: headerNumber(headers, "x-ratelimit-rate-heavy"),
    heavyLimit: headerNumber(headers, "x-ratelimit-limit-heavy"),
    heavyWindowMs: parseDuration(headers.get("x-ratelimit-reset-heavy")),
    connections: headerNumber(headers, "x-conn-current"),
    connectionLimit: headerNumber(headers, "x-conn-limit"),
  };
}

/** Pull the JSON-RPC method out of a request body so we can tell heavy calls apart. */
function inspectBody(init: any): { method: string | null; heavy: boolean } {
  const body = init?.body;
  if (typeof body !== "string") return { method: null, heavy: false };

  try {
    const parsed = JSON.parse(body);
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    const methods = calls.map((call: any) => String(call?.method ?? ""));
    return {
      method: methods.length === 1 ? methods[0]! : methods.join(","),
      heavy: methods.some((method: string) => HEAVY_METHODS.has(method)),
    };
  } catch {
    return { method: null, heavy: false };
  }
}

function retryAfterMs(response: Response, attempt: number): number {
  const raw = response.headers.get("retry-after");
  if (raw !== null) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const backoff = 500 * 2 ** attempt;
  return backoff + Math.floor(Math.random() * 250);
}

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function isRetryableNetworkError(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code
    ?? (error as { cause?: { code?: string } })?.cause?.code;
  return code ? RETRYABLE_NETWORK_CODES.has(code) : false;
}

/**
 * A drop-in `fetch` that respects X1's public RPC limits.
 *
 * Pass it straight into `new Connection(url, { fetch: x1Fetch })` or use
 * `createX1Connection()` which wires it up for you.
 */
export function createX1Fetch(options: X1FetchOptions): X1Fetch {
  const { throttle } = options;
  const maxRetries = options.maxRetries ?? 4;
  const adaptive = options.adaptive ?? true;
  const baseFetch: FetchLike = options.baseFetch ?? ((input, init) => globalThis.fetch(input, init));

  const x1Fetch = async (input: any, init?: any): Promise<Response> => {
    const { method, heavy } = inspectBody(init);

    for (let attempt = 0; ; attempt += 1) {
      const release = await throttle.acquire(heavy);

      let response: Response | undefined;
      let networkError: unknown;

      try {
        response = await baseFetch(input, init);
      } catch (error) {
        networkError = error;
      } finally {
        release();
      }

      if (networkError !== undefined) {
        const retryable = isRetryableNetworkError(networkError);
        if (retryable && attempt < maxRetries) {
          const delayMs = Math.min(8_000, 400 * 2 ** attempt) + Math.floor(Math.random() * 200);
          options.onRetry?.({
            attempt: attempt + 1,
            method,
            reason: `network error: ${(networkError as Error)?.message ?? String(networkError)}`,
            delayMs,
          });
          await sleep(delayMs);
          continue;
        }
        throw networkError;
      }

      const res = response!;
      const info = parseRateLimitHeaders(res.status, res.headers);

      if (adaptive) {
        throttle.adopt({
          shortCap: info.shortLimit,
          longCap: info.longLimit,
          heavyCap: info.heavyLimit,
          maxConcurrent: effectiveConcurrency(info.connectionLimit),
          shortWindowMs: info.shortWindowMs,
          heavyWindowMs: info.heavyWindowMs,
        });
      }

      options.onRateLimit?.(info);

      const retryableStatus = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
      if (!retryableStatus || attempt >= maxRetries) return res;

      const delayMs = retryAfterMs(res, attempt);

      if (res.status === 429) {
        // Back off every caller, not just this one. Retrying early only
        // extends the throttle because denied requests still count.
        throttle.penalize();
        throttle.pauseFor(delayMs);
      }

      options.onRetry?.({
        attempt: attempt + 1,
        method,
        reason: res.status === 429 ? "rate limited (429)" : `upstream ${res.status}`,
        delayMs,
        status: res.status,
      });
      await sleep(delayMs);
    }
  };

  return Object.assign(x1Fetch, {
    throttle,
    stats: () => throttle.stats(),
  });
}
