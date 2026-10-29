// Against a running API: COSTFLUENT_SMOKE_BASE_URL and a COSTFLUENT_SMOKE_API_KEY that may create
// workspaces, folders and providers, manage alerts and read costs. It imports the built package, as
// an application would, and names every object it creates after the run.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, describe, it } from "node:test";

import { createClient, CostfluentError, paginate, type CostfluentClient } from "@costfluent/sdk";

const baseUrl = process.env.COSTFLUENT_SMOKE_BASE_URL ?? "";
const token = process.env.COSTFLUENT_SMOKE_API_KEY ?? "";
// Four days back keeps the day inside every plan's history and apart from the Python smoke's.
const costDay = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10);
const amount = "98.76543219";

describe("against the API", { skip: !(baseUrl && token) && "COSTFLUENT_SMOKE_BASE_URL and COSTFLUENT_SMOKE_API_KEY are not set" }, () => {
  let client: CostfluentClient;
  const name = `SDK smoke typescript ${randomUUID().slice(0, 8)}`;

  const firstWorkspace = async () => {
    const { data } = await client.GET("/v1/workspaces", { params: { query: { limit: 1 } } });
    const workspace = data?.data[0];
    assert.ok(workspace, "the organization has a workspace");
    return workspace;
  };

  before(() => {
    client = createClient({ token, baseUrl });
  });

  it("pages workspaces by links.next", async () => {
    const { data: created } = await client.POST("/v1/workspaces", {
      body: { name, currency: (await firstWorkspace()).currency },
    });

    const ids: string[] = [];
    for await (const workspace of paginate((querySerializer) =>
      client.GET("/v1/workspaces", { params: { query: { limit: 1 } }, querySerializer }),
    )) {
      ids.push(workspace.id);
    }

    assert.ok(ids.length >= 2, "one workspace a page, so at least two pages");
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(created && ids.includes(created.id));
  });

  it("creates once when a create is sent twice under one key", async () => {
    const workspaceId = (await firstWorkspace()).id;
    const key = randomUUID();
    const create = () =>
      client.POST("/v1/folders", { body: { workspaceId, title: name }, params: { header: { "Idempotency-Key": key } } });

    const first = await create();
    const second = await create();

    assert.deepEqual([first.response.status, second.response.status], [201, 201]);
    assert.equal(first.data?.id, second.data?.id);
    assert.equal(second.response.headers.get("Idempotent-Replayed"), "true");
    const titles: string[] = [];
    for await (const folder of paginate((querySerializer) =>
      client.GET("/v1/folders", { params: { query: { workspaceId } }, querySerializer }),
    )) {
      titles.push(folder.title);
    }
    assert.equal(titles.filter((title) => title === name).length, 1);
  });

  it("reads costs back as exact decimal strings", async () => {
    const currency = (await firstWorkspace()).currency;
    const { data: provider } = await client.POST("/v1/providers", { body: { key: "custom", displayName: name, credentials: {} } });
    assert.ok(provider);
    const { data: submitted } = await client.POST("/v1/custom-providers/{providerId}/costs", {
      params: { path: { providerId: provider.id } },
      body: {
        costs: [
          {
            chargePeriodStart: costDay,
            chargeCategory: "Usage",
            serviceName: "sdk-smoke",
            billedCost: amount,
            billingCurrency: currency,
            lineItemId: name,
          },
        ],
      },
    });
    assert.deepEqual([submitted?.acceptedRows, submitted?.rejectedRows], [1, 0]);

    const { data: costs } = await client.GET("/v1/costs", { params: { query: { startDate: costDay, endDate: costDay } } });

    const amounts = costs?.data.map((row) => row.cost) ?? [];
    assert.ok(amounts.length > 0 && amounts.every((value) => typeof value === "string"), String(amounts));
    // Summed in hundred-millionths, the API's precision, so no float rounding enters the check.
    const units = amounts.reduce((sum, value) => sum + toUnits(value), 0n);
    assert.equal(units, toUnits(amount));
  });

  it("throws the typed not-found error for a missing folder", async () => {
    const workspaceId = (await firstWorkspace()).id;

    const error = await client
      .GET("/v1/folders/{folderId}", { params: { path: { folderId: "fld_AAAAAAAAAAAAAAAAAAAAAA" }, query: { workspaceId } } })
      .catch((caught: unknown) => caught);

    assert.ok(error instanceof CostfluentError && error.isNotFound, String(error));
    assert.equal(error.code, "not_found");
  });

  it("names the field a refused command refused", async () => {
    // The command validator refuses a percentageIncrease alert with no comparison period under the
    // detail "One or more validation errors occurred", so only the field says what to change.
    const workspaceId = (await firstWorkspace()).id;

    const error = await client
      .POST("/v1/cost-alerts", { body: { workspaceId, name, thresholdType: "percentageIncrease", thresholdValue: "20" } })
      .catch((caught: unknown) => caught);

    assert.ok(error instanceof CostfluentError, String(error));
    assert.ok(error.fieldErrors.some((entry) => entry.name === "comparisonPeriod"), String(error));
    assert.match(error.message, /comparisonPeriod: /);
  });
});

function toUnits(value: string): bigint {
  const [whole = "0", fraction = ""] = value.replace(/^-/, "").split(".");
  const units = BigInt(whole) * 100_000_000n + BigInt(fraction.padEnd(8, "0").slice(0, 8));
  return value.startsWith("-") ? -units : units;
}
