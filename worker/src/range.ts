import {
  contentLength,
  copyUpstreamHeaders,
  parseContentRange,
  parseContentRangeTotal,
  resolveByteRange,
  type ClientRange,
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
  /**
   * Inclusive client start, or `null` for a suffix range (`bytes=-N`).
   * Omit (with `clientEnd`) for a full 200.
   */
  clientStart?: number | null;
  clientEnd?: number | null;
  reauth?: Reauth;
  signal?: AbortSignal;
};

type FixedLengthStreamLike = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

type FixedLengthStreamCtor = new (expectedLength: number) => FixedLengthStreamLike;

function fixedLengthStreamCtor(): FixedLengthStreamCtor | undefined {
  const ctor = (globalThis as unknown as { FixedLengthStream?: FixedLengthStreamCtor }).FixedLengthStream;
  return typeof ctor === "function" ? ctor : undefined;
}

/**
 * Preserve Content-Length on a streamed body. workerd drops the header unless
 * the body is a FixedLengthStream (or a buffer). Falls back to the original
 * stream when the constructor is missing or throws.
 */
export function asFixedLength(
  body: ReadableStream<Uint8Array>,
  length: number,
): ReadableStream<Uint8Array> {
  const Ctor = fixedLengthStreamCtor();
  if (!Ctor || !Number.isFinite(length) || length < 0) return body;
  try {
    const fls = new Ctor(length);
    void body.pipeTo(fls.writable).catch(() => {
      try {
        fls.writable.abort();
      } catch {
        /* already closed */
      }
    });
    return fls.readable;
  } catch {
    return body;
  }
}

export function responseWithKnownLength(
  status: number,
  headers: Headers,
  body: ReadableStream<Uint8Array> | null,
  length: number | null,
): Response {
  if (length != null && length >= 0) headers.set("Content-Length", String(length));
  const out = body && length != null && length >= 0 ? asFixedLength(body, length) : body;
  return new Response(out, { status, headers });
}

function clientRangeOf(opts: RangeOpts): ClientRange | null {
  if (opts.clientStart === undefined && opts.clientEnd === undefined) return null;
  return {
    start: opts.clientStart === undefined ? 0 : opts.clientStart,
    end: opts.clientEnd === undefined ? null : opts.clientEnd,
  };
}

function isSuffix(range: ClientRange | null): boolean {
  return range != null && range.start == null && range.end != null;
}

function unsatisfiable(total: number, extra?: Record<string, string>): RangeResult {
  const headers = new Headers({
    "Content-Range": `bytes */${total >= 0 ? total : "*"}`,
    "X-Proxyhub": "1",
  });
  if (extra) for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return { status: 416, headers, body: null, total };
}

/**
 * Sequential Range-chunk fetch stitched into one stream with a known
 * Content-Length. Mid-stream 401 calls `reauth` and retries the same offset.
 * A client Range is honoured exactly: upstream windows are capped at the
 * requested end and the stitched body is trimmed to `last`.
 */
export async function rangedFetch(opts: RangeOpts): Promise<RangeResult> {
  const chunkSize = opts.chunkSize;
  const auth = new Headers(opts.headers);
  const client = clientRangeOf(opts);

  let first: Response;
  if (isSuffix(client)) {
    const suffix = client!.end!;
    if (suffix <= 0) {
      const probe = await fetchOneChunk(opts, auth, 0, 0, true);
      const total =
        parseContentRangeTotal(probe.headers.get("Content-Range")) ??
        contentLength(probe.headers) ??
        -1;
      if (probe.body) await probe.body.cancel();
      return unsatisfiable(total);
    }
    if (suffix > chunkSize) {
      const probe = await fetchOneChunk(opts, auth, 0, 0, true);
      if (probe.status >= 400) {
        return {
          status: probe.status,
          headers: copyUpstreamHeaders(probe.headers, undefined, { keepEncoding: true }),
          body: probe.body,
          total: contentLength(probe.headers) ?? parseContentRangeTotal(probe.headers.get("Content-Range")) ?? -1,
        };
      }
      const total =
        parseContentRangeTotal(probe.headers.get("Content-Range")) ??
        contentLength(probe.headers) ??
        -1;
      if (probe.body) await probe.body.cancel();
      const resolved = total > 0 ? resolveByteRange(client!, total) : null;
      if (!resolved) return unsatisfiable(total);
      const windowEnd = Math.min(resolved.start + chunkSize - 1, resolved.last);
      first = await fetchOneChunk(opts, auth, resolved.start, windowEnd, true);
    } else {
      first = await fetchRangeSpec(opts, auth, `bytes=-${suffix}`, true);
    }
  } else {
    const pos = client?.start ?? 0;
    const cappedEnd =
      client?.end != null ? Math.min(client.end, pos + chunkSize - 1) : pos + chunkSize - 1;
    first = await fetchOneChunk(opts, auth, pos, cappedEnd, true);
  }

  if (first.status >= 400) {
    return {
      status: first.status,
      headers: copyUpstreamHeaders(first.headers, undefined, { keepEncoding: true }),
      body: first.body,
      total: contentLength(first.headers) ?? parseContentRangeTotal(first.headers.get("Content-Range")) ?? -1,
    };
  }

  let total: number;
  let rangeHonoured = first.status === 206;
  const firstCr = parseContentRange(first.headers.get("Content-Range"));
  if (rangeHonoured) {
    total = firstCr?.total ?? parseContentRangeTotal(first.headers.get("Content-Range")) ?? -1;
  } else {
    total = contentLength(first.headers) ?? -1;
  }

  if (total < 0 || !rangeHonoured) {
    return fallbackPassthrough(first, client, total);
  }

  const resolved = client ? resolveByteRange(client, total) : { start: 0, last: total - 1 };
  if (!resolved) {
    if (first.body) await first.body.cancel();
    return unsatisfiable(total);
  }

  const start = resolved.start;
  const last = resolved.last;
  if (start > last) {
    if (first.body) await first.body.cancel();
    return unsatisfiable(total);
  }
  const length = last - start + 1;
  const extra: Record<string, string> = {
    "Content-Length": String(length),
    "Accept-Ranges": "bytes",
  };
  if (client) extra["Content-Range"] = `bytes ${start}-${last}/${total}`;
  const headers = copyUpstreamHeaders(first.headers, extra, { drop: ["content-range"] });

  const raw = stitch(opts, auth, first, start, last, chunkSize, rangeHonoured, firstCr);
  const body = asFixedLength(raw, length);
  return {
    status: client ? 206 : 200,
    headers,
    body,
    total,
  };
}

async function fallbackPassthrough(
  first: Response,
  client: ClientRange | null,
  total: number,
): Promise<RangeResult> {
  const headers = copyUpstreamHeaders(first.headers, undefined, {
    keepEncoding: true,
    drop: ["content-range"],
  });
  if (!client) {
    if (total > 0) headers.set("Content-Length", String(total));
    const body = first.body && total > 0 ? asFixedLength(first.body, total) : first.body;
    return { status: first.status >= 400 ? first.status : 200, headers, body, total };
  }
  if (total > 0) {
    const resolved = resolveByteRange(client, total);
    if (!resolved) {
      if (first.body) await first.body.cancel();
      return unsatisfiable(total);
    }
    const length = resolved.last - resolved.start + 1;
    if (first.body) {
      const sliced = sliceStream(first.body, resolved.start, length);
      headers.set("Content-Length", String(length));
      headers.set("Content-Range", `bytes ${resolved.start}-${resolved.last}/${total}`);
      headers.set("Accept-Ranges", "bytes");
      return { status: 206, headers, body: asFixedLength(sliced, length), total };
    }
    headers.set("Content-Length", String(length));
    headers.set("Content-Range", `bytes ${resolved.start}-${resolved.last}/${total}`);
    return { status: 206, headers, body: null, total };
  }
  if (first.body && client.start != null) {
    const take = client.end != null ? client.end - client.start + 1 : Infinity;
    const sliced = sliceStream(first.body, client.start, take);
    const known = client.end != null ? client.end - client.start + 1 : -1;
    if (known > 0) headers.set("Content-Length", String(known));
    return {
      status: 200,
      headers,
      body: known > 0 ? asFixedLength(sliced, known) : sliced,
      total,
    };
  }
  return { status: 200, headers, body: first.body, total };
}

async function fetchOneChunk(
  opts: RangeOpts,
  auth: Headers,
  start: number,
  end: number,
  allowReauth: boolean,
): Promise<Response> {
  return fetchRangeSpec(opts, auth, `bytes=${start}-${end}`, allowReauth);
}

async function fetchRangeSpec(
  opts: RangeOpts,
  auth: Headers,
  spec: string,
  allowReauth: boolean,
): Promise<Response> {
  let reauthed = 0;
  while (true) {
    const headers = new Headers(auth);
    headers.set("Range", spec);
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
  firstCr: { start: number; end: number; total: number } | null,
): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  void (async () => {
    const writer = writable.getWriter();
    try {
      let pos = startPos;
      let resp: Response | null = first;
      let skip = 0;
      if (firstCr && firstCr.start < startPos) skip = startPos - firstCr.start;
      let remain = last - startPos + 1;
      while (remain > 0) {
        if (!resp) {
          const windowEnd = Math.min(pos + chunkSize - 1, last);
          resp = await fetchOneChunk(opts, auth, pos, windowEnd, true);
          if (resp.status !== 200 && resp.status !== 206) {
            throw new Error(`range chunk ${pos} failed: ${resp.status}`);
          }
          skip = 0;
        }
        if (resp.body) {
          const wrote = await pipeLimited(resp.body, writer, remain, skip);
          remain -= wrote;
          skip = 0;
        } else {
          break;
        }
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

async function pipeLimited(
  src: ReadableStream<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  limit: number,
  skip = 0,
): Promise<number> {
  if (limit <= 0) {
    await src.cancel();
    return 0;
  }
  const reader = src.getReader();
  let written = 0;
  let skipped = 0;
  try {
    while (written < limit) {
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
      const room = limit - written;
      if (chunk.byteLength > room) chunk = chunk.subarray(0, room);
      written += chunk.byteLength;
      await writer.write(chunk);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
    reader.releaseLock();
  }
  return written;
}

export function sliceStream(
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
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
      reader.releaseLock();
    }
  })();
  return readable;
}

/** Trim a 200/206 upstream reply to the exact client range (small/direct path). */
export async function constrainResponseToRange(
  resp: Response,
  range: ClientRange,
  extraOut?: Record<string, string>,
): Promise<Response> {
  if (resp.status === 416) {
    const headers = copyUpstreamHeaders(resp.headers, extraOut, { keepEncoding: true });
    const cr = resp.headers.get("Content-Range");
    if (cr) headers.set("Content-Range", cr);
    if (resp.body) await resp.body.cancel();
    return new Response(null, { status: 416, headers });
  }
  const cr = parseContentRange(resp.headers.get("Content-Range"));
  const total =
    (cr && cr.total >= 0 ? cr.total : null) ??
    parseContentRangeTotal(resp.headers.get("Content-Range")) ??
    (resp.status === 200 ? contentLength(resp.headers) : null) ??
    -1;
  if (total < 0) {
    const headers = copyUpstreamHeaders(resp.headers, extraOut, { keepEncoding: true });
    const cl = resp.headers.get("Content-Length");
    if (cl) headers.set("Content-Length", cl);
    const crh = resp.headers.get("Content-Range");
    if (crh) headers.set("Content-Range", crh);
    return new Response(resp.body, { status: resp.status, headers });
  }
  const resolved = resolveByteRange(range, total);
  if (!resolved) {
    if (resp.body) await resp.body.cancel();
    const headers = new Headers({
      "Content-Range": `bytes */${total}`,
      "X-Proxyhub": "1",
    });
    if (extraOut) for (const [k, v] of Object.entries(extraOut)) headers.set(k, v);
    return new Response(null, { status: 416, headers });
  }
  const length = resolved.last - resolved.start + 1;
  const alreadyExact =
    resp.status === 206 &&
    cr != null &&
    cr.start === resolved.start &&
    cr.end === resolved.last &&
    contentLength(resp.headers) === length;
  const headers = copyUpstreamHeaders(resp.headers, extraOut, {
    keepEncoding: true,
    drop: ["content-range"],
  });
  headers.set("Content-Length", String(length));
  headers.set("Content-Range", `bytes ${resolved.start}-${resolved.last}/${total}`);
  headers.set("Accept-Ranges", "bytes");
  let body: ReadableStream<Uint8Array> | null = resp.body;
  if (body && !alreadyExact) {
    const skip = resp.status === 200 ? resolved.start : cr ? Math.max(0, resolved.start - cr.start) : 0;
    body = sliceStream(body, skip, length);
  }
  return responseWithKnownLength(206, headers, body, length);
}
