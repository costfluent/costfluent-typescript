// A scripted stand-in for the API: each request gets the next reply, and every request is kept.
import { buildClient } from "../src/client.ts";
import type { CostfluentClient } from "../src/index.ts";

export const BASE_URL = "https://api.costfluent.test";
export const TOKEN = "cf_test_token";
export const NOW = Date.parse("2026-10-19T12:00:00Z");

type Reply = Response | Error | ((request: Request, init?: RequestInit) => Promise<Response>);

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export function problem(
  status: number,
  code: string,
  fields: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  const body = { type: "about:blank", title: "Problem", status, code, retryable: false, ...fields };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/problem+json; charset=utf-8", "X-Request-Id": "req_1", ...headers },
  });
}

export function foldersPage(ids: string[], next: string | null): Response {
  return json(200, {
    links: { self: `${BASE_URL}/v1/folders`, next },
    data: ids.map((id) => ({ id, title: id, reportCount: 0 })),
  });
}

export class FakeApi {
  readonly requests: Request[] = [];
  readonly sleeps: number[] = [];
  readonly #replies: Reply[];

  constructor(...replies: Reply[]) {
    this.#replies = replies;
  }

  readonly fetch = async (request: Request, init?: RequestInit): Promise<Response> => {
    this.requests.push(request);
    const reply = this.#replies.shift();
    if (reply === undefined) {
      throw new Error(`no reply scripted for ${request.method} ${request.url}`);
    }
    if (reply instanceof Error) {
      throw reply;
    }
    if (typeof reply === "function") {
      return reply(request, init);
    }
    // A fresh response rather than a clone: cancelling one side of a cloned body waits for the
    // other side, which a scripted reply never reads.
    const body = await reply.clone().arrayBuffer();
    return new Response(body.byteLength > 0 ? body : null, { status: reply.status, headers: reply.headers });
  };

  client(options: { baseUrl?: string; timeoutMs?: number } = {}): CostfluentClient {
    return buildClient(
      { token: TOKEN, baseUrl: options.baseUrl ?? BASE_URL, timeoutMs: options.timeoutMs, fetch: this.fetch },
      {
        sleep: async (ms) => {
          this.sleeps.push(ms);
        },
        now: () => NOW,
      },
    );
  }
}
