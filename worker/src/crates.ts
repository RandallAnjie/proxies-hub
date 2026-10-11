import { proxy } from "./proxy";
import { rewriteCratesConfig } from "./rewrite";
import type { Ctx } from "./types";
import { fetchJson } from "./upstream";

const INDEX = "https://index.crates.io";
const STATIC = "https://static.crates.io/crates";
const UA = { "User-Agent": "proxyhub-crates" };

export async function handleCrates(ctx: Ctx, path: string, prefix: string): Promise<Response> {
  const p = path.split("?")[0];

  if (p === "/config.json" || p === "/config.json/") {
    const { status, data } = await fetchJson(ctx.runtime.fetch, `${INDEX}/config.json`, UA);
    if (!data || typeof data !== "object") {
      return new Response("crates config unavailable\n", {
        status: 502,
        headers: { "Content-Type": "text/plain", "X-Proxyhub": "1" },
      });
    }
    const rewritten = rewriteCratesConfig(data as Record<string, unknown>, `${ctx.origin}${prefix}/dl`);
    return new Response(JSON.stringify(rewritten), {
      status: status === 200 ? 200 : status,
      headers: { "Content-Type": "application/json", "X-Proxyhub": "1" },
    });
  }

  if (p.startsWith("/dl/")) {
    const rest = p.slice("/dl/".length);
    return proxy(ctx, {
      url: `${STATIC}/${rest}`,
      headers: UA,
      cacheKey: `crates:file:${rest}`,
      cacheMode: "immutable",
      ranged: true,
    });
  }

  return proxy(ctx, {
    url: `${INDEX}${p}`,
    headers: UA,
    cacheKey: `crates:idx:${p}`,
    cacheMode: "revalidate",
  });
}
