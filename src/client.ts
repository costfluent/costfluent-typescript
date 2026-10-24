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
  baseUrl?: string;
  /** Milliseconds each attempt may take, 30 seconds unless set. */
  timeoutMs?: number;
  /** Retries after the first attempt, 3 unless set. */
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
  return buildClient(options, {
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  });
}

/** `createClient` with its sleep and clock replaced, for the tests. */
export function buildClient(options: ClientOptions, seams: Pick<RetryOptions, "sleep" | "now">): CostfluentClient {
  // Called through a wrapper: a browser's fetch throws when called detached from the window.
  const inner: Fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const client = createOpenApiClient<paths>({
    baseUrl: (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
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
