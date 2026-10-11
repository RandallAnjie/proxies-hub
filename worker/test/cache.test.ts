import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHandler, MemoryCache } from "../src/index";

describe("caches.default policy", () => {
  it("never stores a non-200", async () => {
    let n = 0;
    const fetchFn = async () => {
      n += 1;
      return new Response("nope", { status: 503, headers: { "Content-Length": "4" } });
    };
    const cache = new MemoryCache();
    const handle = createHandler({ fetch: fetchFn, cache });
    assert.equal((await handle(new Request("https://ph.test/crates/se/rd/serde"))).status, 503);
    assert.equal((await handle(new Request("https://ph.test/crates/se/rd/serde"))).status, 503);
    assert.equal(n, 2);
  });

  it("serves stale-if-error for a revalidated index", async () => {
    let n = 0;
    const body = '{"name":"serde"}\n';
    const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
      n += 1;
      const headers = new Headers(init?.headers);
      if (n === 1) {
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "text/plain",
            "Content-Length": String(body.length),
            ETag: '"e1"',
          },
        });
      }
      assert.equal(headers.get("If-None-Match"), '"e1"');
      return new Response("upstream down", { status: 502 });
    };
    const cache = new MemoryCache();
    const handle = createHandler({ fetch: fetchFn, cache });
    const a = await handle(new Request("https://ph.test/crates/se/rd/serde"));
    assert.equal(a.status, 200);
    assert.equal(await a.text(), body);
    const b = await handle(new Request("https://ph.test/crates/se/rd/serde"));
    assert.equal(b.status, 200);
    assert.equal(b.headers.get("X-Proxyhub-Cache"), "STALE");
    assert.equal(await b.text(), body);
    assert.equal(n, 2);
  });

  it("uses 304 to keep the cached index", async () => {
    let n = 0;
    const body = "line\n";
    const fetchFn = async () => {
      n += 1;
      if (n === 1) {
        return new Response(body, {
          status: 200,
          headers: { "Content-Length": String(body.length), ETag: '"x"' },
        });
      }
      return new Response(null, { status: 304, headers: { ETag: '"x"' } });
    };
    const handle = createHandler({ fetch: fetchFn, cache: new MemoryCache() });
    await handle(new Request("https://ph.test/crates/se/rd/serde"));
    const b = await handle(new Request("https://ph.test/crates/se/rd/serde"));
    assert.equal(b.status, 200);
    assert.equal(await b.text(), body);
    assert.equal(b.headers.get("X-Proxyhub-Cache"), "REVALIDATED");
  });
});
