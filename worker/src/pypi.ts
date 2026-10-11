import { cachedGet } from "./cache";
import { bufferedHeaders, joinHeader } from "./headers";
import { proxy } from "./proxy";
import { rewritePypiIndex } from "./rewrite";
import type { Ctx } from "./types";
import { fetchFollow } from "./upstream";

export const PYPI_SIMPLE = "https://pypi.org/simple";
export const PYPI_FILES = "https://files.pythonhosted.org";

export async function handlePypi(ctx: Ctx, path: string, prefix: string): Promise<Response> {
  const pathname = path.split("?")[0];

  if (pathname.startsWith("/files/")) {
    const rest = pathname.slice("/files/".length);
    const url = new URL(`${PYPI_FILES}/${rest}`);
    const src = new URL(ctx.request.url);
    src.searchParams.forEach((v, k) => url.searchParams.append(k, v));
    return proxy(ctx, {
      url: url.href,
      headers: { "User-Agent": "proxyhub-pypi" },
      cacheKey: `pypi:files:${rest}`,
      cacheMode: "immutable",
      ranged: true,
    });
  }

  let sub = pathname;
  for (const pfx of ["/index", "/simple"]) {
    if (sub === pfx || sub.startsWith(pfx + "/")) {
      sub = sub.slice(pfx.length) || "/";
      break;
    }
  }
  if (!sub.startsWith("/")) sub = "/" + sub;
  const url = PYPI_SIMPLE + sub;
  const accept = joinHeader(ctx.request.headers, "Accept", "text/html");
  const filesBase = `${ctx.origin}${prefix}/files/`;
  return cachedGet(
    ctx,
    `pypi:idx:${sub}:${accept}`,
    () =>
      fetchFollow(ctx.runtime.fetch, url, {
        method: "GET",
        headers: {
          Accept: accept,
          "User-Agent": "proxyhub-pypi",
          "Accept-Encoding": "identity",
        },
        signal: ctx.request.signal,
      }),
    "revalidate",
    {
      rewrite: async (resp) => {
        const ctype = resp.headers.get("Content-Type") || "text/html";
        const body = await resp.text();
        const rewritten = rewritePypiIndex(body, filesBase);
        const headers = bufferedHeaders(resp.headers);
        headers.set("Content-Type", ctype);
        headers.set("Content-Length", String(new TextEncoder().encode(rewritten).byteLength));
        return new Response(rewritten, { status: resp.status, headers });
      },
    },
  );
}
