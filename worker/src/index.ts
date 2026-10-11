import { handleApt } from "./apt";
import { config, MAX_CACHE_BYTES, RANGE_CHUNK } from "./config";
import { handleCrates } from "./crates";
import { dockerPing, handleDocker } from "./docker";
import { docsHtml, docsMarkdown, isMarkdownUa } from "./docs";
import { handleGeneric } from "./generic";
import { handleGithub } from "./github";
import { text } from "./headers";
import { MemoryCache } from "./memory-cache";
import { handlePypi } from "./pypi";
import { helpText, matchRoute } from "./route";
import type { Ctx, Env, ExecutionContext, FetchFn, Runtime } from "./types";
import { handleWeb } from "./web";

const fallbackCache = new MemoryCache();

export type HandlerOptions = {
  fetch?: FetchFn;
  cache?: Cache;
  now?: () => number;
  rangeChunk?: number;
  maxCacheBytes?: number;
};

function runtimeOf(opts: HandlerOptions | undefined, ctx: ExecutionContext | undefined): Runtime {
  const cache =
    opts?.cache ??
    (typeof globalThis !== "undefined" && "caches" in globalThis
      ? (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default
      : undefined) ??
    fallbackCache;
  return {
    fetch: opts?.fetch ?? globalThis.fetch.bind(globalThis),
    cache,
    now: opts?.now ?? Date.now,
    waitUntil: (p) => {
      if (ctx?.waitUntil) ctx.waitUntil(p);
    },
    rangeChunk: opts?.rangeChunk ?? RANGE_CHUNK,
    maxCacheBytes: opts?.maxCacheBytes ?? MAX_CACHE_BYTES,
  };
}

export async function handleRequest(
  request: Request,
  env: Env = {},
  exec?: ExecutionContext,
  opts?: HandlerOptions,
): Promise<Response> {
  const url = new URL(request.url);
  const ctx: Ctx = {
    request,
    env,
    url,
    origin: url.origin,
    host: url.host,
    runtime: runtimeOf(opts, exec),
  };
  try {
    return await dispatch(ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return text(502, `upstream error: ${msg}\n`);
  }
}

async function dispatch(ctx: Ctx): Promise<Response> {
  const route = matchRoute(ctx.url.pathname);

  if (route.kind === "docs") {
    const ua = ctx.request.headers.get("User-Agent") || "";
    if (isMarkdownUa(ua)) {
      return new Response(docsMarkdown(ctx.host), {
        status: 200,
        headers: {
          "Content-Type": "text/markdown; charset=utf-8",
          "X-Proxyhub": "1",
        },
      });
    }
    return new Response(docsHtml(ctx.host), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Proxyhub": "1",
      },
    });
  }

  if (route.kind === "help") return text(404, helpText());
  if (route.kind === "v2-ping") return dockerPing();

  if (route.kind === "docker") {
    return handleDocker(ctx, route.registry, route.path);
  }

  switch (route.service) {
    case "github":
      return handleGithub(ctx, route.path);
    case "pypi":
      return handlePypi(ctx, route.path, route.prefix);
    case "crates":
      return handleCrates(ctx, route.path, route.prefix);
    case "apt":
      return handleApt(ctx, route.path);
    case "cache":
      return handleGeneric(ctx, route.path);
    default:
      if (route.service in config.web) {
        return handleWeb(ctx, route.service, route.path, route.prefix);
      }
      return text(404, helpText());
  }
}

export function createHandler(opts?: HandlerOptions) {
  return (request: Request, env: Env = {}, exec?: ExecutionContext) =>
    handleRequest(request, env, exec, opts);
}

const defaultFetch = createHandler();

export default {
  fetch(request: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    return defaultFetch(request, env, exec);
  },
};

export { matchRoute, helpText } from "./route";
export { rangedFetch } from "./range";
export { rewriteCratesConfig, rewriteNpmRegistry, rewritePypiIndex } from "./rewrite";
export { resolveGithubAuth } from "./github";
export { resetDockerAuth } from "./docker";
export { MemoryCache } from "./memory-cache";
