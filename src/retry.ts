import { isProblem } from "./errors.ts";

export type Fetch = (input: Request, init?: RequestInit) => Promise<Response>;

export interface RetryOptions {
  maxRetries: number;
  /** Milliseconds each attempt may take. */
  timeoutMs: number;
  /** Waits `ms`, and rejects with the signal's reason once the call is aborted. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;
/**
 * The longest a call waits out rate limits in all, and the longest wait a server error asks for that
 * is waited out: one per-minute window, the longest a per-minute refusal takes to clear. A single
 * longer Retry-After means the token's hourly quota is spent, and the 429 is thrown at once rather
 * than held for most of an hour.
 */
export const MAX_RETRY_WAIT_MS = 60_000;

/**
 * Whether a request is safe to resend after a lost response or a 5xx. A POST triggers, so
 * resending one the server may have run could run it twice unless it carries an Idempotency-Key,
 * and a request with If-Match the server applied would be refused by its own now stale precondition.
 * An unconditional DELETE is resent, and when the first attempt removed the object before its
 * answer was lost, the resend's not-found is reported as the API answered it: a success made up
 * here would also be reported for an id that never existed or that the token cannot see.
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

function backoffMs(step: number): number {
  const delay = Math.min(BASE_DELAY_MS * 2 ** step, MAX_DELAY_MS);
  return delay + Math.random() * (delay / 4);
}

/**
 * A fetch that resends what the API turned away for now, as the Go and Python clients do. A 429 is
 * resent while the waits it asks for stay within MAX_RETRY_WAIT_MS in all, whatever their count:
 * under contention the API's limiter frees one slot at a time and answers each refusal with about a
 * second, so a count would give up while the budget refills. Each wait counts at least a second,
 * which ends a 429 that asks for none, as an intermediary's Retry-After: 0 does, after 61 attempts.
 * Server and connection errors keep their count of `maxRetries`, and 0 turns every retry off, rate
 * limits included.
 */
export function retryingFetch(inner: Fetch, options: RetryOptions): (input: Request) => Promise<Response> {
  return async (request) => {
    let retries = 0;
    // The waits the API did not ask for: the backoff's exponent, so a server error after rate
    // limits backs off from its first step.
    let backoffs = 0;
    let rateLimitedMs = 0;
    for (;;) {
      const timeout = AbortSignal.timeout(options.timeoutMs);
      let response: Response | undefined;
      try {
        response = await inner(request.clone(), { signal: AbortSignal.any([request.signal, timeout]) });
      } catch (error) {
        // The timeout bounds each try and the caller's signal the call; neither is retried.
        if (retries >= options.maxRetries || timeout.aborted || request.signal.aborted || !retryable(request)) {
          throw error;
        }
      }
      const limited = response?.status === 429 ? response : undefined;
      if (
        response !== undefined &&
        (!shouldRetry(request, response) || options.maxRetries <= 0 || (!limited && retries >= options.maxRetries))
      ) {
        return response;
      }
      const asked = response && retryAfterMs(response.headers, options.now());
      const delay = asked ?? backoffMs(backoffs++);
      if (limited) {
        const counted = Math.max(delay, 1_000);
        if (rateLimitedMs + counted > MAX_RETRY_WAIT_MS) {
          return limited;
        }
        rateLimitedMs += counted;
      } else {
        retries++;
        if (response !== undefined && delay > MAX_RETRY_WAIT_MS) {
          return response;
        }
      }
      await response?.body?.cancel();
      await options.sleep(delay, request.signal);
    }
  };
}
