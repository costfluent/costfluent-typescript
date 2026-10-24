import { isProblem } from "./errors.ts";

export type Fetch = (input: Request, init?: RequestInit) => Promise<Response>;

export interface RetryOptions {
  maxRetries: number;
  /** Milliseconds each attempt may take. */
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
/**
 * The longest Retry-After a request waits out. A longer one means the token's hourly quota is
 * spent, and the 429 is thrown rather than held for most of an hour.
 */
export const MAX_RETRY_WAIT_MS = 60_000;

/**
 * Whether a request is safe to resend after a lost response or a 5xx. A POST triggers, so
 * resending one the server may have run could run it twice unless it carries an Idempotency-Key,
 * and a request with If-Match the server applied would be refused by its own now stale precondition.
 */
function retryable(request: Request): boolean {
  if (request.headers.has("If-Match")) {
    return false;
  }
  if (["GET", "HEAD", "PUT", "DELETE"].includes(request.method)) {
    return true;
  }
  return request.method === "POST" && request.headers.has("Idempotency-Key");
}

/**
 * A 429 is retried for every method: the rate limiter refuses a request before any endpoint runs
 * it. A 404 without problem details is the proxy's, not the API's, and is retried as a 5xx is.
 */
function shouldRetry(request: Request, response: Response): boolean {
  const edgeNotFound = response.status === 404 && !isProblem(response);
  return response.status === 429 || ((response.status >= 500 || edgeNotFound) && retryable(request));
}

/** Retry-After in seconds or as an HTTP date, or else the RateLimit-Reset seconds the API sends beside it. */
function retryAfterMs(headers: Headers, now: number): number | undefined {
  const value = (headers.get("Retry-After") || headers.get("RateLimit-Reset"))?.trim();
  if (!value) {
    return undefined;
  }
  if (/^-?\d+$/.test(value)) {
    return Math.max(Number(value) * 1_000, 0);
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(at - now, 0);
}

function backoffMs(attempt: number): number {
  const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return delay + Math.random() * (delay / 4);
}

/** A fetch that resends what the API turned away for now, as the Go and Python clients do. */
export function retryingFetch(inner: Fetch, options: RetryOptions): (input: Request) => Promise<Response> {
  return async (request) => {
    for (let attempt = 0; ; attempt++) {
      const last = attempt >= options.maxRetries;
      const timeout = AbortSignal.timeout(options.timeoutMs);
      let response: Response | undefined;
      try {
        response = await inner(request.clone(), { signal: AbortSignal.any([request.signal, timeout]) });
      } catch (error) {
        // The timeout bounds each try and the caller's signal the call; neither is retried.
        if (last || timeout.aborted || request.signal.aborted || !retryable(request)) {
          throw error;
        }
      }
      if (response !== undefined && (last || !shouldRetry(request, response))) {
        return response;
      }
      const delay = (response && retryAfterMs(response.headers, options.now())) ?? backoffMs(attempt);
      if (response !== undefined) {
        if (delay > MAX_RETRY_WAIT_MS) {
          return response;
        }
        await response.body?.cancel();
      }
      await options.sleep(delay);
    }
  };
}
