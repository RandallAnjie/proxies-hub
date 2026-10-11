import { cachedGet, serveCachedRange } from "./cache";
import { MAX_CACHE_BYTES, RANGE_CHUNK } from "./config";
import {
  contentLength,
  copyUpstreamHeaders,
  parseContentRangeTotal,
  parseRange,
  text,
} from "./headers";
import { constrainResponseToRange, rangedFetch, responseWithKnownLength } from "./range";
import type { CacheMode } from "./cache";
import type { Ctx } from "./types";
import { fetchFollow } from "./upstream";

export type ProxyOpts = {
  url: string;
  headers: HeadersInit;
  cacheKey?: string;
  cacheMode?: CacheMode;
  /** Use sequential Range chunks (large blobs / packages). */
  ranged?: boolean;
  reauth?: () => Promise<Record<string, string>>;
  rewrite?: (resp: Response) => Promise<Response>;
  extraOut?: Record<string, string>;
};

function cacheReq(key: string): Request {
  return new Request("https://ph.cache/" + encodeURIComponent(key), { method: "GET" });
}

async function matchSafe(ctx: Ctx, key: string): Promise<Response | undefined> {
  try {
    return await ctx.runtime.cache.match(cacheReq(key));
  } catch {
    // SafeCache already swallows this; keep a miss if an unwrapped cache throws.
    return undefined;
  }
}

function applyExtra(resp: Response, extra?: Record<string, string>): Response {
  const headers = new Headers(resp.headers);
  headers.set("X-Proxyhub", "1");
  if (extra) for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  const cl = contentLength(headers);
  const body = resp.body;
  if (body && cl != null) return responseWithKnownLength(resp.status, headers, body, cl);
  return new Response(body, { status: resp.status, headers });
}

function finish(
  resp: Response,
  extraOut?: Record<string, string>,
): Response {
  const headers = copyUpstreamHeaders(resp.headers, extraOut, { keepEncoding: true });
  const cl = resp.headers.get("Content-Length");
  if (cl) headers.set("Content-Length", cl);
  const cr = resp.headers.get("Content-Range");
  if (cr) headers.set("Content-Range", cr);
  const n = contentLength(headers);
  if (resp.body && n != null) return responseWithKnownLength(resp.status, headers, resp.body, n);
  return new Response(resp.body, { status: resp.status, headers });
}

function headReply(status: number, headers: Headers): Response {
  return new Response(null, { status, headers });
}

async function putIfSmall(ctx: Ctx, key: string, resp: Response): Promise<Response> {
  const max = ctx.runtime.maxCacheBytes ?? MAX_CACHE_BYTES;
  const cl = contentLength(resp.headers);
  if (resp.status !== 200 || cl == null || cl > max) return resp;
  const headers = new Headers(resp.headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("X-Proxyhub", "1");
  const stored = new Response(resp.body, { status: 200, headers });
  const out = stored.clone();
  try {
    await ctx.runtime.cache.put(cacheReq(key), stored);
  } catch {
    /* best-effort: oversized, uncacheable, or a broken Cache API */
  }
  return out;
}

async function headProxy(ctx: Ctx, opts: ProxyOpts, mode: CacheMode): Promise<Response> {
  if (mode === "immutable" && opts.cacheKey) {
    const hit = await matchSafe(ctx, opts.cacheKey);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set("X-Proxyhub-Cache", "HIT");
      if (opts.extraOut) for (const [k, v] of Object.entries(opts.extraOut)) headers.set(k, v);
      if (hit.body) await hit.body.cancel();
      return headReply(200, headers);
    }
  }
  const resp = await fetchFollow(ctx.runtime.fetch, opts.url, {
    method: "HEAD",
    headers: opts.headers,
    signal: ctx.request.signal,
  });
  const headers = copyUpstreamHeaders(resp.headers, opts.extraOut, { keepEncoding: true });
  let cl = contentLength(resp.headers);
  if (resp.body) await resp.body.cancel();

  const headOk = resp.status === 200 || resp.status === 204;
  const tryProbe = cl == null && opts.ranged && (headOk || resp.status === 405);
  if (tryProbe) {
    const h = new Headers(opts.headers);
    h.set("Range", "bytes=0-0");
    const probe = await fetchFollow(ctx.runtime.fetch, opts.url, {
      method: "GET",
      headers: h,
      signal: ctx.request.signal,
    });
    const total = parseContentRangeTotal(probe.headers.get("Content-Range"));
    const probeCl = contentLength(probe.headers);
    if (probe.body) await probe.body.cancel();
    if (total != null && total >= 0) cl = total;
    else if (probe.status === 200 && probeCl != null) cl = probeCl;
    if (cl != null) headers.set("Content-Length", String(cl));
    const status = resp.status === 405 && (probe.status === 200 || probe.status === 206) ? 200 : resp.status;
    return headReply(status, headers);
  }

  if (cl != null) headers.set("Content-Length", String(cl));
  return headReply(resp.status, headers);
}

/** GET/HEAD proxy: optional caches.default, optional Range stitch, client Range. */
export async function proxy(ctx: Ctx, opts: ProxyOpts): Promise<Response> {
  const method = ctx.request.method.toUpperCase();
  const clientRange = method === "GET" ? parseRange(ctx.request.headers.get("Range")) : null;
  const mode = opts.cacheMode ?? "none";

  if (method === "HEAD") {
    return headProxy(ctx, opts, mode);
  }

  if (method !== "GET") {
    return passthrough(ctx, opts.url, opts.headers, opts.extraOut);
  }

  if (mode === "revalidate" && opts.cacheKey) {
    return cachedGet(
      ctx,
      opts.cacheKey,
      (cond) => {
        const h = new Headers(opts.headers);
        if (cond) cond.forEach((v, k) => h.set(k, v));
        return fetchFollow(ctx.runtime.fetch, opts.url, {
          method: "GET",
          headers: h,
          signal: ctx.request.signal,
        });
      },
      "revalidate",
      { rewrite: opts.rewrite },
    ).then((r) => applyExtra(r, opts.extraOut));
  }

  if (mode === "immutable" && opts.cacheKey) {
    const hit = await matchSafe(ctx, opts.cacheKey);
    if (hit) {
      if (clientRange) return serveCachedRange(hit, clientRange.start, clientRange.end);
      const headers = new Headers(hit.headers);
      headers.set("X-Proxyhub-Cache", "HIT");
      if (opts.extraOut) for (const [k, v] of Object.entries(opts.extraOut)) headers.set(k, v);
      return new Response(hit.body, { status: 200, headers });
    }
  }

  if (opts.ranged) {
    const result = await rangedFetch({
      fetch: ctx.runtime.fetch,
      url: opts.url,
      headers: opts.headers,
      chunkSize: ctx.runtime.rangeChunk || RANGE_CHUNK,
      clientStart: clientRange ? clientRange.start : undefined,
      clientEnd: clientRange ? clientRange.end : undefined,
      reauth: opts.reauth,
      signal: ctx.request.signal,
    });
    if (opts.extraOut) {
      for (const [k, v] of Object.entries(opts.extraOut)) result.headers.set(k, v);
    }
    const length = contentLength(result.headers);
    const resp = responseWithKnownLength(result.status, result.headers, result.body, length);
    if (mode === "immutable" && opts.cacheKey && !clientRange) {
      return putIfSmall(ctx, opts.cacheKey, resp);
    }
    return resp;
  }

  if (clientRange) {
    const h = new Headers(opts.headers);
    h.set("Range", ctx.request.headers.get("Range")!);
    const resp = await fetchFollow(ctx.runtime.fetch, opts.url, {
      method: "GET",
      headers: h,
      signal: ctx.request.signal,
    });
    return constrainResponseToRange(resp, clientRange, opts.extraOut);
  }

  const resp = await fetchFollow(ctx.runtime.fetch, opts.url, {
    method: "GET",
    headers: opts.headers,
    signal: ctx.request.signal,
  });
  if (opts.rewrite && resp.status === 200) {
    return applyExtra(await opts.rewrite(resp), opts.extraOut);
  }
  const out = finish(resp, opts.extraOut);
  if (mode === "immutable" && opts.cacheKey) return putIfSmall(ctx, opts.cacheKey, out);
  return out;
}

export async function passthrough(
  ctx: Ctx,
  url: string,
  headers: HeadersInit,
  extraOut?: Record<string, string>,
): Promise<Response> {
  const method = ctx.request.method.toUpperCase();
  const h = new Headers(headers);
  const rng = ctx.request.headers.get("Range");
  if (rng) h.set("Range", rng);
  let body: BodyInit | undefined;
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    body = ctx.request.body ?? undefined;
  }
  const init: RequestInit = {
    method,
    headers: h,
    body,
    signal: ctx.request.signal,
    redirect: "manual",
  };
  if (body != null) (init as RequestInit & { duplex?: string }).duplex = "half";
  const resp = await fetchFollow(ctx.runtime.fetch, url, init);
  return finish(resp, extraOut);
}

export function methodNotAllowed(): Response {
  return text(405, "method not allowed\n");
}
