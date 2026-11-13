import createOpenApiClient, { type Client, type Middleware } from "openapi-fetch";

import { IDEMPOTENT_CREATES } from "./contract.ts";
import { CostfluentError } from "./errors.ts";
import { type Fetch, type RetryOptions, retryingFetch } from "./retry.ts";
import type { paths } from "./schema.ts";
import { VERSION } from "./version.ts";

export const DEFAULT_BASE_URL = "https://api.costfluent.com";

export type CostfluentClient = Client<paths>;

export interface ClientOptions {
  /** The API token, sent as a bearer token. */
  token: string;
  /** https, or plain http to localhost, 127.0.0.1 or ::1 only; any other throws a `TypeError`. */
  baseUrl?: string;
  /** Milliseconds each attempt may take, 30 seconds unless set. */
  timeoutMs?: number;
  /**
   * Retries of a server or connection error after the first attempt, 3 unless set. A rate limit is
   * waited out for up to 60 seconds in all instead, and 0 turns every retry off, rate limits included.
   */
  maxRetries?: number;
  /** Replaces the global fetch, as a stub does in a test. */
  fetch?: Fetch;
}

/** Every create gets a fresh key unless the caller set one, so a retry is answered with the first response. */
const idempotencyKeys: Middleware = {
  onRequest({ request, schemaPath }) {
    if (request.method === "POST" && IDEMPOTENT_CREATES.has(schemaPath) && !request.headers.has("Idempotency-Key")) {
      request.headers.set("Idempotency-Key", crypto.randomUUID());
    }
    return request;
  },
};

const typedErrors: Middleware = {
  async onResponse({ response }) {
    if (response.status >= 400) {
      throw await CostfluentError.fromResponse(response);
    }
    return response;
  },
};

/**
 * A client for every Public API operation, addressed by path: `client.GET("/v1/workspaces")`. Calls
 * retry as the README describes, give each create an Idempotency-Key, and throw `CostfluentError`
 * for any error status, so a call that returns has its `data`.
 */
export function createClient(options: ClientOptions): CostfluentClient {
  return buildClient(options, { sleep: sleepUnlessAborted, now: Date.now });
}

/**
 * Waits `ms`, or rejects with the signal's reason as soon as the caller aborts, at once when it
 * already has: a rate limit can hold a call for a minute, which an abort must not sit out. Whichever
 * comes first removes the other's timer or listener.
 */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Refuses a base URL that would send the token in clear: the Go client's rule, which the Terraform
 * provider and the MCP server apply to the same setting.
 */
function checkBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (cause) {
    throw new TypeError(`costfluent: base URL ${JSON.stringify(baseUrl)} is not a URL; write it as https://<host>`, {
      cause,
    });
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    return;
  }
  throw new TypeError(
    `costfluent: base URL ${JSON.stringify(baseUrl)} must use https, because the API key travels with every request; plain http is allowed only for localhost, 127.0.0.1 and ::1`,
  );
}

/** `createClient` with its sleep and clock replaced, for the tests. */
export function buildClient(options: ClientOptions, seams: Pick<RetryOptions, "sleep" | "now">): CostfluentClient {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  checkBaseUrl(baseUrl);
  // Called through a wrapper: a browser's fetch throws when called detached from the window.
  const inner: Fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const client = createOpenApiClient<paths>({
    baseUrl: baseUrl.replace(/\/+$/, ""),
    headers: {
      Authorization: `Bearer ${options.token}`,
      "User-Agent": `costfluent-typescript/${VERSION}`,
      Accept: "application/json",
    },
    fetch: retryingFetch(inner, {
      maxRetries: options.maxRetries ?? 3,
      timeoutMs: options.timeoutMs ?? 30_000,
      ...seams,
    }),
  });
  client.use(idempotencyKeys, typedErrors);
  return client;
}
