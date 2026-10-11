import { config, type WebMirror } from "./config";
import { proxy } from "./proxy";
import { rewriteAbsoluteOrigin } from "./rewrite";
import type { Ctx } from "./types";

const compiled = new Map<string, { revalidate: RegExp[]; noCache: RegExp[] }>();

function rules(name: string, mirror: WebMirror) {
  let c = compiled.get(name);
  if (!c) {
    c = {
      revalidate: (mirror.revalidate || []).map((p) => new RegExp(p)),
      noCache: (mirror.noCache || []).map((p) => new RegExp(p)),
    };
    compiled.set(name, c);
  }
  return c;
}

export async function handleWeb(ctx: Ctx, name: string, path: string, prefix: string): Promise<Response> {
  const mirror = config.web[name];
  if (!mirror) {
    return new Response(`unknown web mirror: ${name}\n`, { status: 404 });
  }
  const pathname = path.split("?")[0];
  const url = mirror.upstream.replace(/\/$/, "") + path;
  const srcQ = new URL(ctx.request.url).search;
  const target = srcQ && !url.includes("?") ? url + srcQ : url;
  const headers = new Headers({
    "User-Agent": "proxyhub-web",
  });
  const accept = ctx.request.headers.get("Accept");
  if (accept) headers.set("Accept", accept);

  const r = rules(name, mirror);
  const revalidatable = r.revalidate.some((re) => re.test(pathname));
  const cacheable = !r.noCache.some((re) => re.test(pathname));
  const method = ctx.request.method.toUpperCase();

  const rewrite = mirror.rewriteOrigin
    ? async (resp: Response) => {
        const ctype = resp.headers.get("Content-Type") || "";
        if (!/json|text|javascript|xml/i.test(ctype) && pathname.endsWith(".tgz")) {
          return resp;
        }
        if (pathname.endsWith(".tgz") || pathname.endsWith(".whl") || pathname.endsWith(".crate")) {
          return resp;
        }
        const body = await resp.text();
        const rewritten = rewriteAbsoluteOrigin(
          body,
          mirror.rewriteOrigin!,
          `${ctx.origin}${prefix}/`,
        );
        const headers2 = new Headers(resp.headers);
        headers2.set("X-Proxyhub", "1");
        headers2.set("Content-Length", String(new TextEncoder().encode(rewritten).byteLength));
        return new Response(rewritten, { status: resp.status, headers: headers2 });
      }
    : undefined;

  if (method === "GET" && revalidatable) {
    return proxy(ctx, {
      url: target,
      headers,
      cacheKey: `web:${name}:${pathname}`,
      cacheMode: "revalidate",
      rewrite,
    });
  }

  const mode = method === "GET" && cacheable ? "immutable" : "none";
  return proxy(ctx, {
    url: target,
    headers,
    cacheKey: mode === "none" ? undefined : `web:${name}:${pathname}`,
    cacheMode: mode,
    ranged: mode === "immutable",
    rewrite: mode === "none" ? rewrite : undefined,
  });
}
