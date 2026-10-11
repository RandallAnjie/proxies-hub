import { MAX_CACHE_BYTES } from "./config";
import { contentLength } from "./headers";
import type { Ctx } from "./types";

export type CacheMode = "none" | "immutable" | "revalidate";

function cacheRequest(key: string): Request {
  return new Request("https://ph.cache/" + encodeURIComponent(key), { method: "GET" });
}

function cacheableSize(resp: Response, maxBytes: number): boolean {
  if (resp.status !== 200) return false;
  const cl = contentLength(resp.headers);
  if (cl == null) return false;
  return cl <= maxBytes;
}

function storedResponse(resp: Response, ttl: number, immutable: boolean): Response {
  const headers = new Headers(resp.headers);
  headers.set(
    "Cache-Control",
    immutable
      ? `public, max-age=${ttl}, immutable`
      : `public, max-age=${ttl}`,
  );
  headers.set("X-Proxyhub", "1");
  return new Response(resp.body, { status: resp.status, headers });
}

async function putSafe(ctx: Ctx, key: string, resp: Response): Promise<void> {
  try {
    await ctx.runtime.cache.put(cacheRequest(key), resp);
  } catch {
    // best-effort: oversized, uncacheable, or a broken Cache API
  }
}

/**
 * Cache helper. Never stores non-200. Indexes keep a long stored TTL so
 * stale-if-error still has a body after our short freshness window; we
 * always revalidate those ourselves. `match` / `put` are best-effort — a
 * thrown Cache API (e.g. workerd with no cache binding) is a miss, not a 502.
 */
export async function cachedGet(
  ctx: Ctx,
  key: string,
  doFetch: (cond?: Headers) => Promise<Response>,
  mode: CacheMode,
  opts?: {
    maxBytes?: number;
    rewrite?: (resp: Response) => Promise<Response>;
    immutableTtl?: number;
    indexTtl?: number;
  },
): Promise<Response> {
  const maxBytes = opts?.maxBytes ?? ctx.runtime.maxCacheBytes ?? MAX_CACHE_BYTES;
  if (mode === "none") {
    const resp = await doFetch();
    return opts?.rewrite && resp.status === 200 ? opts.rewrite(resp) : resp;
  }

  let hit: Response | undefined;
  try {
    hit = await ctx.runtime.cache.match(cacheRequest(key));
  } catch {
    // SafeCache already swallows this; keep a miss if an unwrapped cache throws.
    hit = undefined;
  }

  if (mode === "immutable" && hit) {
    const headers = new Headers(hit.headers);
    headers.set("X-Proxyhub-Cache", "HIT");
    return new Response(hit.body, { status: hit.status, headers });
  }

  if (mode === "revalidate" && hit) {
    const cond = new Headers();
    const et = hit.headers.get("ETag") || hit.headers.get("Etag");
    const lm = hit.headers.get("Last-Modified");
    if (et) cond.set("If-None-Match", et);
    if (lm) cond.set("If-Modified-Since", lm);
    let fresh: Response;
    try {
      fresh = await doFetch(cond);
    } catch {
      const headers = new Headers(hit.headers);
      headers.set("X-Proxyhub-Cache", "STALE");
      return new Response(hit.body, { status: 200, headers });
    }
    if (fresh.status === 304 || fresh.status >= 500 || fresh.status === 429) {
      if (fresh.body) await fresh.body.cancel();
      const headers = new Headers(hit.headers);
      headers.set("X-Proxyhub-Cache", fresh.status === 304 ? "REVALIDATED" : "STALE");
      return new Response(hit.body, { status: 200, headers });
    }
    if (fresh.status !== 200) return fresh;
    const rewritten = opts?.rewrite ? await opts.rewrite(fresh) : fresh;
    if (cacheableSize(rewritten, maxBytes)) {
      const stored = storedResponse(rewritten.clone(), opts?.indexTtl ?? 7 * 24 * 3600, false);
      await putSafe(ctx, key, stored);
    }
    const headers = new Headers(rewritten.headers);
    headers.set("X-Proxyhub-Cache", "MISS");
    return new Response(rewritten.body, { status: rewritten.status, headers });
  }

  const fresh = await doFetch();
  if (fresh.status !== 200) return fresh;
  const rewritten = opts?.rewrite ? await opts.rewrite(fresh) : fresh;
  if (cacheableSize(rewritten, maxBytes)) {
    const ttl = mode === "immutable" ? (opts?.immutableTtl ?? 31536000) : (opts?.indexTtl ?? 7 * 24 * 3600);
    const stored = storedResponse(rewritten.clone(), ttl, mode === "immutable");
    await putSafe(ctx, key, stored);
  }
  const headers = new Headers(rewritten.headers);
  headers.set("X-Proxyhub-Cache", "MISS");
  return new Response(rewritten.body, { status: rewritten.status, headers });
}

export async function serveCachedRange(
  cached: Response,
  start: number,
  end: number | null,
): Promise<Response> {
  const buf = await cached.arrayBuffer();
  const total = buf.byteLength;
  const last = end == null ? total - 1 : Math.min(end, total - 1);
  if (start < 0 || start > last) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${total}`, "X-Proxyhub": "1" },
    });
  }
  const slice = buf.slice(start, last + 1);
  const headers = new Headers(cached.headers);
  headers.set("Content-Length", String(slice.byteLength));
  headers.set("Content-Range", `bytes ${start}-${last}/${total}`);
  headers.set("Accept-Ranges", "bytes");
  headers.set("X-Proxyhub-Cache", "HIT");
  headers.set("X-Proxyhub", "1");
  return new Response(slice, { status: 206, headers });
}
