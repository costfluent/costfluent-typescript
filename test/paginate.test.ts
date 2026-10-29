import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CostfluentError, paginate } from "../src/index.ts";
import { BASE_URL, FakeApi, foldersPage, json } from "./fake-api.ts";

const GATEWAY_URL = "https://gateway.example/costfluent";
// Each next link names the next page by its query; the path in it is the server's view of itself.
const NEXT_LINKS: Record<string, (page: number) => string> = {
  "on another host": (page) => `http://internal-host:8080/v1/folders?workspaceId=ws_1&page=${page}&limit=1`,
  "on the gateway's host without the prefix": (page) =>
    `https://gateway.example/v1/folders?workspaceId=ws_1&page=${page}&limit=1`,
  "carrying the prefix": (page) => `${GATEWAY_URL}/v1/folders?workspaceId=ws_1&page=${page}&limit=1`,
  "under another path": (page) => `https://gateway.example/elsewhere/v1/folders?workspaceId=ws_1&page=${page}&limit=1`,
};

async function folderIds(api: FakeApi, limit = 2, baseUrl = BASE_URL): Promise<string[]> {
  const client = api.client({ baseUrl });
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

  it("keeps a base URL's path prefix for every page", async () => {
    for (const base of [GATEWAY_URL, `${GATEWAY_URL}/`]) {
      for (const [name, link] of Object.entries(NEXT_LINKS)) {
        const api = new FakeApi(
          foldersPage(["fld_1"], link(2)),
          foldersPage(["fld_2"], link(3)),
          foldersPage(["fld_3"], null),
        );

        assert.deepEqual(await folderIds(api, 1, base), ["fld_1", "fld_2", "fld_3"], `${base}, link ${name}`);
        assert.deepEqual(
          api.requests.slice(1).map((request) => request.url),
          [
            `${GATEWAY_URL}/v1/folders?workspaceId=ws_1&page=2&limit=1`,
            `${GATEWAY_URL}/v1/folders?workspaceId=ws_1&page=3&limit=1`,
          ],
          `${base}, link ${name}`,
        );
      }
    }
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
