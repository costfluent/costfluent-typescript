import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { CONTRACT_SHA256, CostfluentError, VERSION } from "../src/index.ts";
import { FakeApi, TOKEN, json, problem } from "./fake-api.ts";

const folder = () => json(201, { id: "fld_1", title: "Finance" });
const newFolder = { workspaceId: "ws_1", title: "Finance" };

describe("requests", () => {
  it("carry the token and the package version", async () => {
    const api = new FakeApi(folder());
    await api.client().POST("/v1/folders", { body: newFolder });

    assert.equal(api.requests[0]?.headers.get("Authorization"), `Bearer ${TOKEN}`);
    assert.equal(api.requests[0]?.headers.get("User-Agent"), `costfluent-typescript/${VERSION}`);
  });

  it("give each create its own idempotency key", async () => {
    const api = new FakeApi(folder(), folder());
    const client = api.client();
    await client.POST("/v1/folders", { body: newFolder });
    await client.POST("/v1/folders", { body: newFolder });

    const keys = api.requests.map((request) => request.headers.get("Idempotency-Key"));
    assert.match(keys[0] ?? "", /^[0-9a-f-]{36}$/);
    assert.notEqual(keys[0], keys[1]);
  });

  it("send a caller's idempotency key unchanged", async () => {
    const api = new FakeApi(folder());
    await api.client().POST("/v1/folders", {
      body: newFolder,
      params: { header: { "Idempotency-Key": "nightly-run" } },
    });

    assert.equal(api.requests[0]?.headers.get("Idempotency-Key"), "nightly-run");
  });

  it("give a POST that is not a create no key", async () => {
    const api = new FakeApi(new Response(null, { status: 204 }));
    await api.client().POST("/v1/anomalies/{anomalyId}/acknowledge", { params: { path: { anomalyId: "anm_1" } } });

    assert.equal(api.requests[0]?.headers.has("Idempotency-Key"), false);
  });

  it("reach a base URL with a path prefix", async () => {
    const api = new FakeApi(folder());
    await api.client({ baseUrl: "https://gateway.example/costfluent/" }).POST("/v1/folders", { body: newFolder });

    assert.equal(api.requests[0]?.url, "https://gateway.example/costfluent/v1/folders");
    assert.equal(api.requests[0]?.headers.has("Idempotency-Key"), true);
  });
});

describe("errors", () => {
  it("throw the typed not-found error for a missing object", async () => {
    const api = new FakeApi(problem(404, "not_found", { detail: "No folder fld_9.", traceId: "00-abc-01" }));

    const error = await api
      .client()
      .GET("/v1/folders/{folderId}", { params: { path: { folderId: "fld_9" }, query: { workspaceId: "ws_1" } } })
      .catch((caught: unknown) => caught);

    assert.ok(error instanceof CostfluentError);
    assert.equal(error.status, 404);
    assert.equal(error.code, "not_found");
    assert.equal(error.isNotFound, true);
    assert.equal(error.problem?.traceId, "00-abc-01");
    assert.equal(error.requestId, "req_1");
    assert.match(error.message, /not_found: No folder fld_9\./);
  });

  it("carry a validation error's fields", async () => {
    const api = new FakeApi(
      problem(400, "validation_failed", { errors: [{ name: "title", reason: "Title must not be empty." }] }),
    );

    const error = await api
      .client()
      .POST("/v1/folders", { body: { workspaceId: "ws_1", title: "" } })
      .catch((caught: unknown) => caught);

    assert.ok(error instanceof CostfluentError);
    assert.deepEqual(
      error.fieldErrors.map((entry) => entry.name),
      ["title"],
    );
    assert.equal(error.isNotFound, false);
  });

  // The API's problems as each source writes them: the command validator's generic detail beside
  // the fields it refused, the endpoint validator's fields with no detail, and the refusals whose
  // detail already states their one entry.
  for (const [name, response, want] of [
    [
      "command validator",
      () =>
        problem(400, "validation_failed", {
          detail: "One or more validation errors occurred",
          errors: [
            { name: "comparisonPeriod", reason: "'comparison Period' must not be empty." },
            { name: "filter", reason: "Unknown field 'cost.provider' at position 1" },
          ],
        }),
      "One or more validation errors occurred; comparisonPeriod: 'comparison Period' must not be empty.; " +
        "filter: Unknown field 'cost.provider' at position 1",
    ],
    [
      "endpoint validator",
      () =>
        problem(400, "validation_failed", {
          errors: [
            { name: "currency", reason: "'Currency' must be 3 characters in length." },
            { name: "generalErrors", reason: "Exactly one of amount and amountByMonth is required." },
          ],
        }),
      "currency: 'Currency' must be 3 characters in length.; Exactly one of amount and amountByMonth is required.",
    ],
    [
      "one handler failure",
      () =>
        problem(400, "validation_failed", {
          detail: "Unknown app",
          errors: [{ name: "appIds", reason: "Unknown app" }],
        }),
      "Unknown app",
    ],
    [
      "missing capability",
      () =>
        problem(403, "forbidden", {
          detail: "API token lacks capability: ManageTeam",
          errors: [{ name: "capability", reason: "manageTeam", code: "missing_capability" }],
        }),
      "API token lacks capability: ManageTeam",
    ],
    ["no detail or errors", () => problem(400, "validation_failed"), "Problem"],
  ] as const) {
    it(`name the field errors the detail leaves out: ${name}`, async () => {
      const sent = response();
      const error = await new FakeApi(sent)
        .client()
        .POST("/v1/folders", { body: newFolder })
        .catch((caught: unknown) => caught);

      assert.ok(error instanceof CostfluentError);
      assert.equal(error.message, `Costfluent API answered ${sent.status} ${error.code}: ${want}`);
    });
  }

  it("recognise a reused idempotency key", async () => {
    const api = new FakeApi(problem(422, "idempotency_key_reused"));

    const error = await api.client().POST("/v1/folders", { body: newFolder }).catch((caught: unknown) => caught);

    assert.ok(error instanceof CostfluentError && error.isIdempotencyKeyReused);
  });

  it("still throw for an error without problem details", async () => {
    const api = new FakeApi(json(401, { message: "no" }));

    const error = await api.client().GET("/v1/workspaces").catch((caught: unknown) => caught);

    assert.ok(error instanceof CostfluentError);
    assert.equal(error.code, "");
    assert.equal(error.problem, undefined);
  });
});

describe("money", () => {
  it("stays the exact decimal string the API sent", async () => {
    const point = {
      date: "2026-10-01",
      cost: "123456789012.12345678",
      listCost: "0.10000001",
      amortizedCost: "-0.5",
      currency: "EUR",
      dimensions: { service: "Compute" },
    };
    const meta = {
      startDate: "2026-10-01",
      endDate: "2026-10-01",
      granularity: "day",
      measure: "cost",
      totalRecords: 1,
      presentation: { conversions: [], unconverted: [], totalsByCurrency: [] },
      totalCost: "123456789012.12345678",
    };
    const api = new FakeApi(json(200, { links: { self: "/v1/costs" }, data: [point], meta }));

    const { data } = await api
      .client()
      .GET("/v1/costs", { params: { query: { startDate: "2026-10-01", endDate: "2026-10-01" } } });

    const row = data?.data[0];
    assert.deepEqual([row?.cost, row?.listCost, row?.amortizedCost], ["123456789012.12345678", "0.10000001", "-0.5"]);
    assert.equal(data?.meta.totalCost, "123456789012.12345678");
  });
});

describe("the package", () => {
  it("names the document it was generated from", () => {
    assert.match(CONTRACT_SHA256, /^[0-9a-f]{64}$/);
  });

  it("reports the version package.json carries, which the release stamps into both", async () => {
    const manifest: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    assert.ok(typeof manifest === "object" && manifest !== null && "version" in manifest);
    assert.equal(manifest.version, VERSION);
  });
});
