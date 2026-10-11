import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rangedFetch } from "../src/range";

type Step = {
  status: number;
  headers?: Record<string, string>;
  body?: string;
};

function mockFetch(steps: Step[]) {
  const calls: { url: string; headers: Headers }[] = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, headers });
    const step = steps.shift();
    if (!step) throw new Error(`unexpected fetch ${url} ${headers.get("Range")}`);
    return new Response(step.body ?? "", {
      status: step.status,
      headers: step.headers,
    });
  };
  return { fetchFn, calls, steps };
}

describe("rangedFetch stitching", () => {
  it("stitches two 206 chunks into one 200 with Content-Length", async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 206, headers: { "Content-Range": "bytes 0-3/8", "Content-Type": "application/octet-stream" }, body: "ABCD" },
      { status: 206, headers: { "Content-Range": "bytes 4-7/8" }, body: "EFGH" },
    ]);
    const result = await rangedFetch({
      fetch: fetchFn,
      url: "https://o/blob",
      headers: {},
      chunkSize: 4,
    });
    assert.equal(result.status, 200);
    assert.equal(result.total, 8);
    assert.equal(result.headers.get("Content-Length"), "8");
    assert.equal(await new Response(result.body).text(), "ABCDEFGH");
    assert.equal(calls[0].headers.get("Range"), "bytes=0-3");
    assert.equal(calls[1].headers.get("Range"), "bytes=4-7");
  });

  it("refreshes a bearer token on mid-stream 401 and resumes the same offset", async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 401, body: "expired" },
      { status: 206, headers: { "Content-Range": "bytes 0-3/8" }, body: "ABCD" },
      { status: 206, headers: { "Content-Range": "bytes 4-7/8" }, body: "EFGH" },
    ]);
    let n = 0;
    const result = await rangedFetch({
      fetch: fetchFn,
      url: "https://o/blob",
      headers: { Authorization: "Bearer OLD" },
      chunkSize: 4,
      reauth: async () => {
        n += 1;
        return { Authorization: "Bearer NEW" };
      },
    });
    assert.equal(await new Response(result.body).text(), "ABCDEFGH");
    assert.equal(n, 1);
    assert.equal(calls[0].headers.get("Authorization"), "Bearer OLD");
    assert.equal(calls[0].headers.get("Range"), "bytes=0-3");
    assert.equal(calls[1].headers.get("Authorization"), "Bearer NEW");
    assert.equal(calls[1].headers.get("Range"), "bytes=0-3");
  });

  it("gives up after reauth retries on a later chunk", async () => {
    const { fetchFn } = mockFetch([
      { status: 206, headers: { "Content-Range": "bytes 0-3/8" }, body: "ABCD" },
      { status: 401 },
      { status: 401 },
      { status: 401 },
    ]);
    const result = await rangedFetch({
      fetch: fetchFn,
      url: "https://o/blob",
      headers: {},
      chunkSize: 4,
      reauth: async () => ({ Authorization: "Bearer STILL-BAD" }),
    });
    await assert.rejects(async () => {
      await new Response(result.body).arrayBuffer();
    }, /range chunk 4 failed: 401/);
  });

  it("honours a client Range as 206 with the slice length", async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 206, headers: { "Content-Range": "bytes 2-5/8" }, body: "CDEF" },
    ]);
    const result = await rangedFetch({
      fetch: fetchFn,
      url: "https://o/blob",
      headers: {},
      chunkSize: 4,
      clientStart: 2,
      clientEnd: 5,
    });
    assert.equal(result.status, 206);
    assert.equal(result.headers.get("Content-Length"), "4");
    assert.equal(result.headers.get("Content-Range"), "bytes 2-5/8");
    assert.equal(await new Response(result.body).text(), "CDEF");
    assert.equal(calls[0].headers.get("Range"), "bytes=2-5");
  });

  it("falls back to a single 200 when Range is ignored", async () => {
    const { fetchFn } = mockFetch([
      { status: 200, headers: { "Content-Length": "4" }, body: "FULL" },
    ]);
    const result = await rangedFetch({
      fetch: fetchFn,
      url: "https://o/blob",
      headers: {},
      chunkSize: 4,
    });
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("Content-Length"), "4");
    assert.equal(await new Response(result.body).text(), "FULL");
  });
});
