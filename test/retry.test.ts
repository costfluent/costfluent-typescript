import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CostfluentError } from "../src/index.ts";
import { FakeApi, json, problem } from "./fake-api.ts";

const folderRead = () => json(200, { id: "fld_1", title: "Finance", reportCount: 0 });
const unavailable = () => problem(503, "service_unavailable");
const getFolder = (api: FakeApi) =>
  api.client().GET("/v1/folders/{folderId}", { params: { path: { folderId: "fld_1" }, query: { workspaceId: "ws_1" } } });
const acknowledge = (api: FakeApi) =>
  api.client().POST("/v1/anomalies/{anomalyId}/acknowledge", { params: { path: { anomalyId: "anm_1" } } });
const caught = (call: Promise<unknown>) => call.then(() => undefined, (error: unknown) => error);

describe("retries", () => {
  it("resend a rate-limited trigger after the wait the API names", async () => {
    const api = new FakeApi(problem(429, "rate_limited", {}, { "Retry-After": "7" }), new Response(null, { status: 204 }));

    await acknowledge(api);

    assert.equal(api.requests.length, 2);
    assert.deepEqual(api.sleeps, [7_000]);
  });

  it("use RateLimit-Reset when Retry-After is missing", async () => {
    const api = new FakeApi(problem(429, "rate_limited", {}, { "RateLimit-Reset": "12" }), folderRead());

    await getFolder(api);

    assert.deepEqual(api.sleeps, [12_000]);
  });

  it("wait until a Retry-After HTTP date", async () => {
    const api = new FakeApi(
      problem(429, "rate_limited", {}, { "Retry-After": "Mon, 19 Oct 2026 12:00:30 GMT" }),
      folderRead(),
    );

    await getFolder(api);

    assert.deepEqual(api.sleeps, [30_000]);
  });

  it("throw at once rather than wait over a minute", async () => {
    const api = new FakeApi(problem(429, "rate_limited", {}, { "Retry-After": "3600" }));

    const error = await caught(getFolder(api));

    assert.ok(error instanceof CostfluentError && error.isRateLimited);
    assert.equal(api.requests.length, 1);
    assert.deepEqual(api.sleeps, []);
  });

  it("resend a read after a server error with growing backoff", async () => {
    const api = new FakeApi(unavailable(), unavailable(), unavailable(), folderRead());

    await getFolder(api);

    assert.equal(api.sleeps.length, 3);
    api.sleeps.forEach((delay, attempt) => {
      const base = 1_000 * 2 ** attempt;
      assert.ok(delay >= base && delay <= base * 1.25, `attempt ${attempt} waited ${delay}`);
    });
  });

  it("stop after three and throw the last status", async () => {
    const api = new FakeApi(unavailable(), unavailable(), unavailable(), problem(502, "bad_gateway"));

    const error = await caught(getFolder(api));

    assert.ok(error instanceof CostfluentError);
    assert.equal(error.status, 502);
    assert.equal(api.requests.length, 4);
  });

  it("do not resend a trigger after a server error", async () => {
    const api = new FakeApi(unavailable());

    assert.ok((await caught(acknowledge(api))) instanceof CostfluentError);
    assert.equal(api.requests.length, 1);
  });

  it("resend a create under the same key", async () => {
    const api = new FakeApi(unavailable(), json(201, { id: "fld_1", title: "Finance" }));

    await api.client().POST("/v1/folders", { body: { workspaceId: "ws_1", title: "Finance" } });

    const keys = new Set(api.requests.map((request) => request.headers.get("Idempotency-Key")));
    assert.equal(api.requests.length, 2);
    assert.equal(keys.size, 1);
    assert.equal(await api.requests[1]?.text(), JSON.stringify({ workspaceId: "ws_1", title: "Finance" }));
  });

  it("do not resend a conditional write", async () => {
    const api = new FakeApi(unavailable());

    const error = await caught(
      api.client().PUT("/v1/workspaces/{workspaceId}", {
        params: { path: { workspaceId: "ws_1" }, header: { "If-Match": '"7"' } },
        body: { name: "Finance" },
      }),
    );

    assert.ok(error instanceof CostfluentError);
    assert.equal(api.requests.length, 1);
  });

  it("resend a read, and only a read, after a lost connection", async () => {
    const read = new FakeApi(new TypeError("fetch failed"), folderRead());
    await getFolder(read);
    assert.equal(read.requests.length, 2);

    const trigger = new FakeApi(new TypeError("fetch failed"));
    assert.ok((await caught(acknowledge(trigger))) instanceof TypeError);
    assert.equal(trigger.requests.length, 1);
  });

  it("do not resend an attempt that timed out", async () => {
    const hang = (_request: Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const api = new FakeApi(hang);

    const error = await caught(
      api
        .client({ timeoutMs: 20 })
        .GET("/v1/folders/{folderId}", { params: { path: { folderId: "fld_1" }, query: { workspaceId: "ws_1" } } }),
    );

    assert.ok(error instanceof DOMException && error.name === "TimeoutError", String(error));
    assert.equal(api.requests.length, 1);
  });

  it("resend after a proxy's plain 404, which is not a missing object", async () => {
    const edge = () => new Response("404 page not found", { status: 404, headers: { "Content-Type": "text/plain" } });
    const api = new FakeApi(edge(), edge(), edge(), edge());

    const error = await caught(getFolder(api));

    assert.equal(api.requests.length, 4);
    assert.ok(error instanceof CostfluentError && !error.isNotFound);
  });

  it("do not resend the API's own 404", async () => {
    const api = new FakeApi(problem(404, "not_found"));

    await caught(getFolder(api));

    assert.equal(api.requests.length, 1);
  });
});
