import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { serveCachedRange } from "../src/cache";
import { parseRange, resolveByteRange } from "../src/headers";
import { constrainResponseToRange, rangedFetch } from "../src/range";

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

function objectFetch(payload: string) {
  const calls: { range: string | null }[] = [];
  const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const range = headers.get("Range");
    calls.push({ range });
    const total = payload.length;
    if (!range) {
      return new Response(payload, { status: 200, headers: { "Content-Length": String(total) } });
    }
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) return new Response("bad range", { status: 400 });
    let start: number;
    let end: number;
    if (m[1] === "") {
      const n = Number(m[2]);
      if (!Number.isFinite(n) || n <= 0) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
      }
      start = Math.max(0, total - n);
      end = total - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === "" ? total - 1 : Number(m[2]);
    }
    if (start >= total || start < 0) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    }
    end = Math.min(end, total - 1);
    const slice = payload.slice(start, end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Content-Length": String(slice.length),
      },
    });
  };
  return { fetchFn, calls };
}

async function bodyOf(result: { body: ReadableStream<Uint8Array> | null }): Promise<string> {
  return new Response(result.body).text();
}

describe("parseRange", () => {
  it("parses closed, open-ended, and suffix forms", () => {
    assert.deepEqual(parseRange("bytes=0-1023"), { start: 0, end: 1023 });
    assert.deepEqual(parseRange("bytes=170000000-170001023"), { start: 170000000, end: 170001023 });
    assert.deepEqual(parseRange("bytes=100-"), { start: 100, end: null });
    assert.deepEqual(parseRange("bytes=-512"), { start: null, end: 512 });
    assert.equal(parseRange("bytes=-"), null);
    assert.equal(parseRange("bytes=1-2,3-4"), null);
  });

  it("resolves against a known total and rejects unsatisfiable ranges", () => {
    assert.deepEqual(resolveByteRange({ start: 0, end: 1023 }, 3619), { start: 0, last: 1023 });
    assert.deepEqual(resolveByteRange({ start: 100, end: null }, 3619), { start: 100, last: 3618 });
    assert.deepEqual(resolveByteRange({ start: null, end: 4 }, 20), { start: 16, last: 19 });
    assert.deepEqual(resolveByteRange({ start: null, end: 100 }, 20), { start: 0, last: 19 });
    assert.equal(resolveByteRange({ start: 3619, end: 4000 }, 3619), null);
    assert.equal(resolveByteRange({ start: null, end: 0 }, 20), null);
    assert.equal(resolveByteRange({ start: 0, end: 10 }, 0), null);
  });
});

describe("rangedFetch honours the exact client window", () => {
  const small = "0123456789ABCDEFGHIJ"; // 20 bytes
  const large = "L".repeat(5000);

  it("returns exactly 0-1023 with matching Content-Length and a capped upstream Range", async () => {
    const { fetchFn, calls } = objectFetch(large);
    const result = await rangedFetch({
      fetch: fetchFn,
      url: "https://o/wheel",
      headers: {},
      chunkSize: 4096,
      clientStart: 0,
      clientEnd: 1023,
    });
    assert.equal(result.status, 206);
    assert.equal(result.headers.get("Content-Length"), "1024");
    assert.equal(result.headers.get("Content-Range"), "bytes 0-1023/5000");
    const body = await bodyOf(result);
    assert.equal(body.length, 1024);
    assert.equal(body, large.slice(0, 1024));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].range, "bytes=0-1023");
  });

  it("returns a mid-file window without reading to EOF", async () => {
    const { fetchFn, calls } = objectFetch(small);
    const result = await rangedFetch({
      fetch: fetchFn,
      url: "https://o/blob",
      headers: {},
      chunkSize: 16,
      clientStart: 10,
      clientEnd: 13,
    });
    assert.equal(result.status, 206);
    assert.equal(result.headers.get("Content-Length"), "4");
    assert.equal(result.headers.get("Content-Range"), "bytes 10-13/20");
    assert.equal(await bodyOf(result), "ABCD");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].range, "bytes=10-13");
  });

  it("honours a suffix range with a bytes=-N upstream request", async () => {
    const { fetchFn, calls } = objectFetch(small);
    const result = await rangedFetch({
      fetch: fetchFn,
      url: "https://o/blob",
      headers: {},
      chunkSize: 16,
      clientStart: null,
      clientEnd: 4,
    });
    assert.equal(result.status, 206);
    assert.equal(result.headers.get("Content-Length"), "4");
    assert.equal(result.headers.get("Content-Range"), "bytes 16-19/20");
    assert.equal(await bodyOf(result), "GHIJ");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].range, "bytes=-4");
  });

  it("honours an open-ended range as the suffix of the object", async () => {
    const { fetchFn, calls } = objectFetch(small);
    const result = await rangedFetch({
      fetch: fetchFn,
      url: "https://o/blob",
      headers: {},
      chunkSize: 8,
      clientStart: 16,
      clientEnd: null,
    });
    assert.equal(result.status, 206);
    assert.equal(result.headers.get("Content-Length"), "4");
    assert.equal(result.headers.get("Content-Range"), "bytes 16-19/20");
    assert.equal(await bodyOf(result), "GHIJ");
    // Total is unknown until the first 206, so the window is start..start+chunk-1.
    assert.equal(calls[0].range, "bytes=16-23");
    assert.equal(calls.length, 1);
  });

  it("stitches a cross-chunk-boundary client range and stops at last", async () => {
    const { fetchFn, calls } = objectFetch(small);
    const result = await rangedFetch({
      fetch: fetchFn,
      url: "https://o/blob",
      headers: {},
      chunkSize: 4,
      clientStart: 2,
      clientEnd: 6,
    });
    assert.equal(result.status, 206);
    assert.equal(result.headers.get("Content-Length"), "5");
    assert.equal(result.headers.get("Content-Range"), "bytes 2-6/20");
    assert.equal(await bodyOf(result), "23456");
    assert.deepEqual(calls.map((c) => c.range), ["bytes=2-5", "bytes=6-6"]);
  });

  it("returns 416 for an unsatisfiable range", async () => {
    const { fetchFn } = objectFetch(small);
    const result = await rangedFetch({
      fetch: fetchFn,
      url: "https://o/blob",
      headers: {},
      chunkSize: 8,
      clientStart: 50,
      clientEnd: 60,
    });
    assert.equal(result.status, 416);
    assert.equal(result.headers.get("Content-Range"), "bytes */20");
    assert.equal(result.body, null);
  });

  it("trims an oversized first chunk down to the client end", async () => {
    const payload = "0123456789ABCDEFGHIJ";
    const calls: string[] = [];
    const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const range = new Headers(init?.headers).get("Range") || "";
      calls.push(range);
      const m = /^bytes=(\d+)-/.exec(range);
      const start = Number(m?.[1] ?? 0);
      const end = Math.min(start + 7, payload.length - 1);
      const slice = payload.slice(start, end + 1);
      return new Response(slice, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${payload.length}`,
          "Content-Length": String(slice.length),
        },
      });
    };
    const result = await rangedFetch({
      fetch: fetchFn,
      url: "https://o/blob",
      headers: {},
      chunkSize: 8,
      clientStart: 0,
      clientEnd: 3,
    });
    assert.equal(result.status, 206);
    assert.equal(result.headers.get("Content-Length"), "4");
    assert.equal(result.headers.get("Content-Range"), "bytes 0-3/20");
    assert.equal(await bodyOf(result), "0123");
    assert.equal(calls[0], "bytes=0-3");
  });

  it("keeps Content-Length on the full 200 path and uses FixedLengthStream when present", async () => {
    const lengths: number[] = [];
    class FakeFixedLengthStream {
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
      constructor(n: number) {
        lengths.push(n);
        const t = new TransformStream<Uint8Array, Uint8Array>();
        this.readable = t.readable;
        this.writable = t.writable;
      }
    }
    const g = globalThis as typeof globalThis & { FixedLengthStream?: unknown };
    const prev = g.FixedLengthStream;
    g.FixedLengthStream = FakeFixedLengthStream;
    try {
      const { fetchFn } = objectFetch(small);
      const result = await rangedFetch({
        fetch: fetchFn,
        url: "https://o/blob",
        headers: {},
        chunkSize: 8,
      });
      assert.equal(result.status, 200);
      assert.ok(result.headers.get("Content-Length"), "Content-Length must be present");
      assert.equal(result.headers.get("Content-Length"), "20");
      assert.ok(lengths.includes(20), "FixedLengthStream should be constructed with the object size");
      assert.equal(await bodyOf(result), small);
    } finally {
      if (prev !== undefined) g.FixedLengthStream = prev;
      else delete g.FixedLengthStream;
    }
  });
});

describe("small/direct and cached range paths", () => {
  it("constrainResponseToRange trims a 206 that returned the whole object", async () => {
    const payload = "abcdefghijklmnopqrstuvwxyz"; // 26
    const resp = new Response(payload, {
      status: 206,
      headers: {
        "Content-Range": "bytes 0-25/26",
        "Content-Length": "26",
        "Content-Type": "application/octet-stream",
      },
    });
    const out = await constrainResponseToRange(resp, { start: 0, end: 9 });
    assert.equal(out.status, 206);
    assert.equal(out.headers.get("Content-Length"), "10");
    assert.equal(out.headers.get("Content-Range"), "bytes 0-9/26");
    assert.equal(await out.text(), "abcdefghij");
  });

  it("constrainResponseToRange slices a 200 that ignored Range", async () => {
    const payload = "abcdefghijklmnopqrstuvwxyz";
    const resp = new Response(payload, {
      status: 200,
      headers: { "Content-Length": "26", "Content-Type": "application/octet-stream" },
    });
    const out = await constrainResponseToRange(resp, { start: 0, end: 9 });
    assert.equal(out.status, 206);
    assert.equal(out.headers.get("Content-Length"), "10");
    assert.equal(out.headers.get("Content-Range"), "bytes 0-9/26");
    assert.equal(await out.text(), "abcdefghij");
  });

  it("serveCachedRange honours suffix, open-ended, and 416", async () => {
    const payload = "0123456789";
    const cached = () =>
      new Response(payload, { status: 200, headers: { "Content-Type": "text/plain", "Content-Length": "10" } });
    const suffix = await serveCachedRange(cached(), null, 3);
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get("Content-Length"), "3");
    assert.equal(suffix.headers.get("Content-Range"), "bytes 7-9/10");
    assert.equal(await suffix.text(), "789");

    const open = await serveCachedRange(cached(), 7, null);
    assert.equal(open.status, 206);
    assert.equal(open.headers.get("Content-Length"), "3");
    assert.equal(await open.text(), "789");

    const miss = await serveCachedRange(cached(), 40, 50);
    assert.equal(miss.status, 416);
    assert.equal(miss.headers.get("Content-Range"), "bytes */10");
  });
});
