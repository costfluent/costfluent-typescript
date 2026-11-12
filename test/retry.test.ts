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
const removeMember = (api: FakeApi) =>
  api.client().DELETE("/v1/teams/{teamId}/members/{userId}", { params: { path: { teamId: "team_1", userId: "usr_1" } } });
const caught = (call: Promise<unknown>) => call.then(() => undefined, (error: unknown) => error);
// A real fetch holds its socket open while it waits; the ref'd timer stands in for it. Without one,
// Node 20.3 to 20.12 drain the event loop before the client's unref'd timeout fires and cancel the test.
const hang = (_request: Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const socket = setInterval(() => undefined, 60_000);
    init?.signal?.addEventListener("abort", () => {
      clearInterval(socket);
      reject(init.signal?.reason);
    });
  });

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

  it("do not resend the API's 404 whatever its code, and read only not_found as missing", async () => {
    const folder = { params: { path: { folderId: "fld_1" }, query: { workspaceId: "ws_1" } } };
    const calls = {
      GET: (api: FakeApi) => api.client().GET("/v1/folders/{folderId}", folder),
      PUT: (api: FakeApi) =>
        api.client().PUT("/v1/folders/{folderId}", {
          params: { path: { folderId: "fld_1" } },
          body: { workspaceId: "ws_1", title: "Finance" },
        }),
      DELETE: (api: FakeApi) => api.client().DELETE("/v1/folders/{folderId}", folder),
    };
    for (const [method, call] of Object.entries(calls)) {
      // The API's 404 for something other than a missing object, such as a path it does not serve.
      const api = new FakeApi(problem(404, "operation_not_found"));

      const error = await caught(call(api));

      assert.deepEqual(api.requests.map((request) => request.method), [method]);
      assert.ok(error instanceof CostfluentError, `${method}: ${String(error)}`);
      assert.equal(error.code, "operation_not_found", method);
      assert.equal(error.isNotFound, false, method);
    }
  });

  it("report not found when a resent DELETE finds the object already gone", async () => {
    const failures = { "a 503": unavailable, "a lost connection": () => new TypeError("fetch failed") };
    for (const [first, failure] of Object.entries(failures)) {
      const api = new FakeApi(failure(), problem(404, "not_found"));

      const error = await caught(removeMember(api));

      assert.ok(error instanceof CostfluentError && error.isNotFound, `${first}: ${String(error)}`);
      assert.equal(api.requests.length, 2, first);
    }
  });

  it("do not resend a DELETE the API answered not found", async () => {
    const api = new FakeApi(problem(404, "not_found"), new Response(null, { status: 204 }));

    const error = await caught(removeMember(api));

    assert.ok(error instanceof CostfluentError && error.isNotFound, String(error));
    assert.equal(api.requests.length, 1);
  });

  it("do not resend a conditional DELETE", async () => {
    const api = new FakeApi(unavailable(), new Response(null, { status: 204 }));

    const error = await caught(
      api.client().DELETE("/v1/folders/{folderId}", {
        params: { path: { folderId: "fld_1" }, query: { workspaceId: "ws_1" }, header: { "If-Match": '"7"' } },
      }),
    );

    assert.ok(error instanceof CostfluentError && error.status === 503, String(error));
    assert.equal(api.requests.length, 1);
  });

  it("resend an unconditional PUT and a DELETE after a server error or a lost connection", async () => {
    const member = { params: { path: { teamId: "team_1", userId: "usr_1" } } };
    const calls = {
      PUT: (api: FakeApi) => api.client().PUT("/v1/teams/{teamId}/members/{userId}", { ...member, body: { role: "editor" } }),
      DELETE: (api: FakeApi) => api.client().DELETE("/v1/teams/{teamId}/members/{userId}", member),
    };
    for (const [method, call] of Object.entries(calls)) {
      for (const failure of [unavailable, () => new TypeError("fetch failed")]) {
        const api = new FakeApi(failure(), new Response(null, { status: 204 }));

        const { response } = await call(api);

        assert.equal(response.status, 204, method);
        assert.equal(api.requests.length, 2, method);
      }
    }
  });

  it("do not resend a PATCH", async () => {
    const api = new FakeApi(unavailable(), json(200, {}));

    const error = await caught(
      api.client().PATCH("/v1/virtual-tags/{virtualTagId}", {
        params: { path: { virtualTagId: "vt_1" } },
        body: { workspaceId: "ws_1" },
      }),
    );

    assert.ok(error instanceof CostfluentError && error.status === 503, String(error));
    assert.equal(api.requests.length, 1);
  });

  it("wait nothing on a negative or past Retry-After and back off on one it cannot read", async () => {
    const cases: [string, number, number][] = [
      ["-5", 0, 0],
      ["Mon, 19 Oct 2026 11:59:00 GMT", 0, 0],
      ["soon", 1_000, 1_250],
    ];
    for (const [value, low, high] of cases) {
      const api = new FakeApi(problem(429, "rate_limited", {}, { "Retry-After": value }), folderRead());

      await getFolder(api);

      assert.equal(api.sleeps.length, 1, value);
      const [delay = Number.NaN] = api.sleeps;
      assert.ok(delay >= low && delay <= high, `${value} waited ${delay}`);
    }
  });

  it("send once with maxRetries 0", async () => {
    const api = new FakeApi(unavailable(), unavailable(), unavailable(), unavailable());

    const error = await caught(
      api
        .client({ maxRetries: 0 })
        .GET("/v1/folders/{folderId}", { params: { path: { folderId: "fld_1" }, query: { workspaceId: "ws_1" } } }),
    );

    assert.ok(error instanceof CostfluentError);
    assert.equal(api.requests.length, 1);
    assert.deepEqual(api.sleeps, []);
  });

  it("cap the backoff at thirty seconds", async () => {
    const api = new FakeApi(...Array.from({ length: 7 }, unavailable), folderRead());

    await api
      .client({ maxRetries: 7 })
      .GET("/v1/folders/{folderId}", { params: { path: { folderId: "fld_1" }, query: { workspaceId: "ws_1" } } });

    assert.equal(api.sleeps.length, 7);
    api.sleeps.forEach((delay, attempt) => {
      const base = Math.min(1_000 * 2 ** attempt, 30_000);
      assert.ok(delay >= base && delay <= base * 1.25, `attempt ${attempt} waited ${delay}`);
    });
  });

  it("do not resend a call the caller aborted", async () => {
    const controller = new AbortController();
    const api = new FakeApi((request, init) => {
      const reply = hang(request, init);
      controller.abort();
      return reply;
    }, folderRead());

    const error = await caught(
      api.client({ timeoutMs: 1_000 }).GET("/v1/folders/{folderId}", {
        params: { path: { folderId: "fld_1" }, query: { workspaceId: "ws_1" } },
        signal: controller.signal,
      }),
    );

    assert.ok(error instanceof DOMException && error.name === "AbortError", String(error));
    assert.equal(api.requests.length, 1);
  });
});
