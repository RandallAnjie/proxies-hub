import {
  contentLength,
  copyUpstreamHeaders,
  parseContentRangeTotal,
} from "./headers";
import type { FetchFn } from "./types";
import { fetchFollow } from "./upstream";

export type Reauth = () => Promise<Record<string, string>>;

export type RangeResult = {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  total: number;
};

export type RangeOpts = {
  fetch: FetchFn;
  url: string;
  headers: HeadersInit;
  chunkSize: number;
  /** Inclusive client range; omit for a full 200. */
  clientStart?: number;
  clientEnd?: number | null;
  reauth?: Reauth;
  signal?: AbortSignal;
};

/**
 * Sequential Range-chunk fetch stitched into one stream with a known
 * Content-Length. Mid-stream 401 calls `reauth` and retries the same offset.
 */
export async function rangedFetch(opts: RangeOpts): Promise<RangeResult> {
  const chunkSize = opts.chunkSize;
  const auth = new Headers(opts.headers);
  let pos = opts.clientStart ?? 0;
  const first = await fetchOneChunk(opts, auth, pos, pos + chunkSize - 1, true);
  if (first.status >= 400) {
    return {
      status: first.status,
      headers: copyUpstreamHeaders(first.headers, undefined, { keepEncoding: true }),
      body: first.body,
      total: contentLength(first.headers) ?? -1,
    };
  }

  let total: number;
  let rangeHonoured = first.status === 206;
  if (rangeHonoured) {
    total = parseContentRangeTotal(first.headers.get("Content-Range")) ?? -1;
  } else {
    total = contentLength(first.headers) ?? -1;
  }

  if (total < 0 || !rangeHonoured) {
    // Upstream ignored Range or hid the size: pass the first body through.
    // Slice a client range off a 200 if we must (skip/take, still streamed).
    const headers = copyUpstreamHeaders(first.headers, undefined, {
      keepEncoding: true,
      drop: ["content-range"],
    });
    const start = opts.clientStart ?? 0;
    const end = opts.clientEnd;
    if (first.status === 200 && (start > 0 || end != null) && first.body) {
      const take = end != null ? end - start + 1 : Infinity;
      const sliced = sliceStream(first.body, start, take);
      const known = end != null ? end - start + 1 : total > 0 ? total - start : -1;
      if (known > 0) headers.set("Content-Length", String(known));
      if (total > 0) {
        const last = end != null ? Math.min(end, total - 1) : total - 1;
        headers.set("Content-Range", `bytes ${start}-${last}/${total}`);
        return { status: 206, headers, body: sliced, total };
      }
      return { status: 200, headers, body: sliced, total };
    }
    if (total > 0) headers.set("Content-Length", String(total));
    return { status: first.status >= 400 ? first.status : 200, headers, body: first.body, total };
  }

  const last = opts.clientEnd != null ? Math.min(opts.clientEnd, total - 1) : total - 1;
  const start = pos;
  if (start > last) {
    if (first.body) await first.body.cancel();
    return {
      status: 416,
      headers: new Headers({
        "Content-Range": `bytes */${total}`,
        "X-Proxyhub": "1",
      }),
      body: null,
      total,
    };
  }
  const length = last - start + 1;
  const extra: Record<string, string> = {
    "Content-Length": String(length),
    "Accept-Ranges": "bytes",
  };
  const clientRange = opts.clientStart != null || opts.clientEnd != null;
  if (clientRange) extra["Content-Range"] = `bytes ${start}-${last}/${total}`;
  const headers = copyUpstreamHeaders(first.headers, extra, { drop: ["content-range"] });

  const body = stitch(opts, auth, first, pos, last, chunkSize, rangeHonoured);
  return {
    status: clientRange ? 206 : 200,
    headers,
    body,
    total,
  };
}

async function fetchOneChunk(
  opts: RangeOpts,
  auth: Headers,
  start: number,
  end: number,
  allowReauth: boolean,
): Promise<Response> {
  let reauthed = 0;
  while (true) {
    const headers = new Headers(auth);
    headers.set("Range", `bytes=${start}-${end}`);
    const resp = await fetchFollow(opts.fetch, opts.url, {
      method: "GET",
      headers,
      signal: opts.signal,
    });
    if (resp.status === 401 && allowReauth && opts.reauth && reauthed < 2) {
      if (resp.body) await resp.body.cancel();
      reauthed += 1;
      const fresh = await opts.reauth();
      for (const [k, v] of Object.entries(fresh)) auth.set(k, v);
      continue;
    }
    return resp;
  }
}

function stitch(
  opts: RangeOpts,
  auth: Headers,
  first: Response,
  startPos: number,
  last: number,
  chunkSize: number,
  rangeHonoured: boolean,
): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  void (async () => {
    const writer = writable.getWriter();
    try {
      let pos = startPos;
      let resp: Response | null = first;
      while (pos <= last) {
        if (!resp) {
          const windowEnd = Math.min(pos + chunkSize - 1, last);
          resp = await fetchOneChunk(opts, auth, pos, windowEnd, true);
          if (resp.status !== 200 && resp.status !== 206) {
            throw new Error(`range chunk ${pos} failed: ${resp.status}`);
          }
        }
        if (resp.body) await pipeTo(resp.body, writer);
        if (!rangeHonoured) break;
        pos += chunkSize;
        resp = null;
      }
      await writer.close();
    } catch (err) {
      await writer.abort(err);
    }
  })();
  return readable;
}

async function pipeTo(
  src: ReadableStream<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  const reader = src.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) await writer.write(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function sliceStream(
  src: ReadableStream<Uint8Array>,
  skip: number,
  take: number,
): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  void (async () => {
    const reader = src.getReader();
    const writer = writable.getWriter();
    let skipped = 0;
    let remain = take;
    try {
      while (remain > 0) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        let chunk: Uint8Array = value;
        if (skipped < skip) {
          const need = skip - skipped;
          if (chunk.byteLength <= need) {
            skipped += chunk.byteLength;
            continue;
          }
          chunk = chunk.subarray(need);
          skipped = skip;
        }
        if (chunk.byteLength > remain) chunk = chunk.subarray(0, remain);
        remain -= chunk.byteLength;
        await writer.write(chunk);
      }
      await writer.close();
    } catch (err) {
      await writer.abort(err);
    } finally {
      reader.releaseLock();
    }
  })();
  return readable;
}
