import { text } from "./headers";
import { proxy } from "./proxy";
import type { Ctx } from "./types";

const GEN = /^\/+(https?)[:/]+([^/]+)(\/.*)?$/;

export async function handleGeneric(ctx: Ctx, path: string): Promise<Response> {
  const p = path.split("?")[0];
  const m = GEN.exec(p);
  if (!m) return text(400, "usage: /https/<host>/<path>\n");
  const scheme = m[1];
  const host = m[2];
  const rest = m[3] || "/";
  const url = new URL(`${scheme}://${host}${rest}`);
  new URL(ctx.request.url).searchParams.forEach((v, k) => url.searchParams.append(k, v));
  const method = ctx.request.method.toUpperCase();
  const cacheable =
    (method === "GET" || method === "HEAD") &&
    !rest.endsWith("/") &&
    !rest.endsWith(".html") &&
    !rest.endsWith("index.yaml");
  return proxy(ctx, {
    url: url.href,
    headers: { "User-Agent": "proxyhub-cache" },
    cacheKey: cacheable ? `gen:${host}${rest}` : undefined,
    cacheMode: cacheable ? "immutable" : "none",
    ranged: cacheable,
  });
}
