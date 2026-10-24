/** One page of a list as `client.GET` answers it: `data` is set once the call has not thrown. */
export interface PageResult<Item> {
  data?: { links: { next?: string | null }; data: Item[] };
}

/**
 * Every item of a list, following `links.next` page by page. `readPage` makes the typed call and
 * passes the `querySerializer` it is given on, which is undefined for the first page and carries
 * the next link's query after that:
 *
 * ```ts
 * for await (const workspace of paginate((querySerializer) =>
 *   client.GET("/v1/workspaces", { params: { query: { limit: 100 } }, querySerializer }),
 * )) { ... }
 * ```
 *
 * The next page is requested on the client's own base URL with the link's query, so the token goes
 * nowhere the client was not pointed.
 */
export async function* paginate<Item>(
  readPage: (querySerializer: (() => string) | undefined) => Promise<PageResult<Item>>,
): AsyncGenerator<Item, void, undefined> {
  let page = await read(readPage, undefined);
  while (true) {
    yield* page.data;
    const next = page.links.next;
    if (!next) {
      return;
    }
    const search = new URL(next).search.slice(1);
    page = await read(readPage, () => search);
  }
}

async function read<Item>(
  readPage: (querySerializer: (() => string) | undefined) => Promise<PageResult<Item>>,
  querySerializer: (() => string) | undefined,
): Promise<NonNullable<PageResult<Item>["data"]>> {
  const { data } = await readPage(querySerializer);
  if (data === undefined) {
    throw new TypeError("the list answered no page");
  }
  return data;
}
