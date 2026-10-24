import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CostfluentError, paginate } from "../src/index.ts";
import { BASE_URL, FakeApi, foldersPage, json } from "./fake-api.ts";

async function folderIds(api: FakeApi, limit = 2): Promise<string[]> {
  const client = api.client();
  const ids: string[] = [];
  for await (const folder of paginate((querySerializer) =>
    client.GET("/v1/folders", { params: { query: { workspaceId: "ws_1", limit } }, querySerializer }),
  )) {
    ids.push(folder.id);
  }
  return ids;
}

describe("paginate", () => {
  it("reads every page by following links.next", async () => {
    const api = new FakeApi(
      foldersPage(["fld_1", "fld_2"], `${BASE_URL}/v1/folders?workspaceId=ws_1&page=2&limit=2`),
      foldersPage(["fld_3", "fld_4"], `${BASE_URL}/v1/folders?workspaceId=ws_1&page=3&limit=2`),
      foldersPage(["fld_5"], null),
    );

    assert.deepEqual(await folderIds(api), ["fld_1", "fld_2", "fld_3", "fld_4", "fld_5"]);
    assert.equal(api.requests[0]?.url, `${BASE_URL}/v1/folders?workspaceId=ws_1&limit=2`);
    assert.equal(api.requests[2]?.url, `${BASE_URL}/v1/folders?workspaceId=ws_1&page=3&limit=2`);
  });

  it("reads a link naming another host from the client's own", async () => {
    const api = new FakeApi(
      foldersPage(["fld_1"], "http://internal-host:8080/v1/folders?workspaceId=ws_1&page=2&limit=1"),
      foldersPage(["fld_2"], null),
    );

    await folderIds(api, 1);

    assert.equal(api.requests[1]?.url, `${BASE_URL}/v1/folders?workspaceId=ws_1&page=2&limit=1`);
    assert.equal(api.requests[1]?.headers.get("Authorization"), api.requests[0]?.headers.get("Authorization"));
  });

  it("stops at a page without a next link", async () => {
    const api = new FakeApi(
      json(200, { links: { self: "/v1/folders" }, data: [{ id: "fld_1", title: "A", reportCount: 0 }] }),
    );

    assert.deepEqual(await folderIds(api), ["fld_1"]);
    assert.equal(api.requests.length, 1);
  });

  it("throws an error a later page answers", async () => {
    const api = new FakeApi(
      foldersPage(["fld_1"], `${BASE_URL}/v1/folders?page=2`),
      json(403, { message: "forbidden" }),
    );

    await assert.rejects(folderIds(api), (error) => error instanceof CostfluentError && error.status === 403);
  });
});
