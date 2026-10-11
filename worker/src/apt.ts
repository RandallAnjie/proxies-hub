import { config } from "./config";
import { text } from "./headers";
import { proxy } from "./proxy";
import type { Ctx } from "./types";

const PKG = [".deb", ".udeb", ".ddeb", ".rpm", ".apk"];

export async function handleApt(ctx: Ctx, path: string): Promise<Response> {
  const p = path.replace(/^\/+/, "").split("?")[0];
  if (!p.includes("/")) return text(400, "usage: /<host>/<path>\n");
  const slash = p.indexOf("/");
  const host = p.slice(0, slash);
  const rest = p.slice(slash + 1);
  const url = `${config.apt.scheme}://${host}/${rest}`;
  const srcQ = new URL(ctx.request.url).search;
  const target = srcQ ? url + srcQ : url;
  const cacheable =
    ctx.request.method.toUpperCase() === "GET" && PKG.some((ext) => rest.endsWith(ext));
  const headers = new Headers({
    "User-Agent": "Debian APT-HTTP/1.3 (proxyhub)",
  });
  const accept = ctx.request.headers.get("Accept");
  if (accept) headers.set("Accept", accept);
  return proxy(ctx, {
    url: target,
    headers,
    cacheKey: cacheable ? `apt:${host}/${rest}` : undefined,
    cacheMode: cacheable ? "immutable" : "none",
    ranged: cacheable,
  });
}
