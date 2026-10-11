import { config } from "./config";
import { copyUpstreamHeaders, joinHeader, text } from "./headers";
import { proxy } from "./proxy";
import type { Ctx } from "./types";
import { fetchFollow } from "./upstream";

const BLOB = /^\/v2\/(.+)\/blobs\/(sha256:[0-9a-f]{64})$/;
const MANIFEST = /^\/v2\/(.+)\/manifests\/(.+)$/;
const REPO_ANY = /^\/v2\/(.+?)\/(?:referrers|tags|_catalog)(?:\/|$)/;
const BEARER = /(\w+)="([^"]*)"/g;

type Tok = { token: string; exp: number };

class RegistryAuth {
  challenge: string | null = null; // null=unknown, ""=anonymous, else Bearer …
  private toks = new Map<string, Tok>();

  get(scope: string, now: number): string | null {
    const t = this.toks.get(scope);
    if (t && t.exp > now) return t.token;
    return null;
  }

  put(scope: string, token: string, now: number, ttl = 240): void {
    this.toks.set(scope, { token, exp: now + ttl * 1000 });
  }

  invalidate(): void {
    this.toks.clear();
    this.challenge = null;
  }
}

const auths = new Map<string, RegistryAuth>();

function authFor(name: string): RegistryAuth {
  let a = auths.get(name);
  if (!a) {
    a = new RegistryAuth();
    auths.set(name, a);
  }
  return a;
}

/** Test hook: drop isolate-local token/challenge state. */
export function resetDockerAuth(): void {
  auths.clear();
}

async function tokenHeader(
  ctx: Ctx,
  name: string,
  challenge: string,
  scope: string | null,
): Promise<Record<string, string>> {
  const parts: Record<string, string> = {};
  BEARER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BEARER.exec(challenge))) parts[m[1]] = m[2];
  const realm = parts.realm || "";
  const useScope = scope || parts.scope || "";
  const service = parts.service || "";
  if (!realm) return {};
  const state = authFor(name);
  const cached = state.get(useScope, ctx.runtime.now());
  if (cached) return { Authorization: `Bearer ${cached}` };
  const u = new URL(realm);
  if (service) u.searchParams.set("service", service);
  if (useScope) u.searchParams.set("scope", useScope);
  const resp = await fetchFollow(ctx.runtime.fetch, u.href, {
    method: "GET",
    headers: { Accept: "application/json", "User-Agent": "proxyhub-docker" },
  });
  if (resp.status !== 200) {
    state.challenge = null;
    if (resp.body) await resp.body.cancel();
    return {};
  }
  let data: { token?: string; access_token?: string } = {};
  try {
    data = (await resp.json()) as { token?: string; access_token?: string };
  } catch {
    return {};
  }
  const tok = data.token || data.access_token || "";
  if (!tok) return {};
  state.put(useScope, tok, ctx.runtime.now());
  return { Authorization: `Bearer ${tok}` };
}

async function authorizedHeaders(
  ctx: Ctx,
  name: string,
  url: string,
  accept: string,
  repo: string | null,
): Promise<Headers> {
  const headers = new Headers({
    Accept: accept,
    "User-Agent": "proxyhub-docker",
  });
  const state = authFor(name);
  let chal = state.challenge;
  if (chal === null) {
    let probe = await fetchFollow(ctx.runtime.fetch, url, {
      method: "HEAD",
      headers,
    });
    if (probe.status !== 401 && (probe.status === 405 || probe.status === 404 || probe.status >= 500)) {
      if (probe.body) await probe.body.cancel();
      probe = await fetchFollow(ctx.runtime.fetch, url, { method: "GET", headers });
    }
    if (probe.status !== 401) {
      state.challenge = "";
      if (probe.body) await probe.body.cancel();
      return headers;
    }
    chal = probe.headers.get("WWW-Authenticate") || "";
    state.challenge = chal;
    if (probe.body) await probe.body.cancel();
  }
  if (chal && chal.toLowerCase().startsWith("bearer")) {
    const scope = repo ? `repository:${repo}:pull` : null;
    const extra = await tokenHeader(ctx, name, chal, scope);
    for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  }
  return headers;
}

function sha1Hex8(s: string): string {
  // Small non-crypto tag for the Accept-keyed cache. FNV-1a 32-bit is enough.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export async function handleDocker(ctx: Ctx, registry: string, path: string): Promise<Response> {
  const reg = config.docker[registry];
  if (!reg) return text(404, `unknown or non-public docker source: ${registry}\n`);
  if (path === "/v2" || path === "/v2/") {
    return new Response(null, {
      status: 200,
      headers: {
        "Docker-Distribution-Api-Version": "registry/2.0",
        "X-Proxyhub": "1",
      },
    });
  }

  const url = reg.upstream.replace(/\/$/, "") + path;
  const method = ctx.request.method.toUpperCase();
  const accept = joinHeader(ctx.request.headers, "Accept", "*/*");

  const blob = BLOB.exec(path);
  if (blob) {
    const repo = blob[1];
    const digest = blob[2];
    const key = `docker:blob:${digest}`;
    const extra = {
      "Docker-Content-Digest": digest,
      "Accept-Ranges": "bytes",
    };
    const headers = await authorizedHeaders(ctx, registry, url, accept, repo);
    const reauth = async () => {
      authFor(registry).invalidate();
      const h = await authorizedHeaders(ctx, registry, url, accept, repo);
      const out: Record<string, string> = {};
      const a = h.get("Authorization");
      if (a) out.Authorization = a;
      return out;
    };
    if (method === "HEAD") {
      return proxy(ctx, {
        url,
        headers,
        cacheKey: key,
        cacheMode: "immutable",
        ranged: true,
        extraOut: extra,
      });
    }
    if (method === "GET") {
      return proxy(ctx, {
        url,
        headers,
        cacheKey: key,
        cacheMode: "immutable",
        ranged: true,
        reauth,
        extraOut: extra,
      });
    }
  }

  const man = MANIFEST.exec(path);
  if (man && (method === "GET" || method === "HEAD")) {
    const repo = man[1];
    const reference = man[2];
    const headers = await authorizedHeaders(ctx, registry, url, accept, repo);
    if (reference.startsWith("sha256:")) {
      return proxy(ctx, {
        url,
        headers,
        cacheKey: method === "GET" ? `docker:manifest:${reference}` : undefined,
        cacheMode: method === "GET" ? "immutable" : "none",
        extraOut: { "Docker-Content-Digest": reference },
      });
    }
    if (method === "HEAD") return proxy(ctx, { url, headers });
    const ahash = sha1Hex8(accept);
    return proxy(ctx, {
      url,
      headers,
      cacheKey: `docker:mtag:${registry}:${path}:${ahash}`,
      cacheMode: "revalidate",
    });
  }

  const any = REPO_ANY.exec(path);
  const headers = await authorizedHeaders(ctx, registry, url, accept, any ? any[1] : null);
  return proxy(ctx, { url, headers });
}

export function dockerPing(): Response {
  return new Response(null, {
    status: 200,
    headers: {
      "Docker-Distribution-Api-Version": "registry/2.0",
      "X-Proxyhub": "1",
    },
  });
}

/** Exported for tests that inspect copied headers. */
export function dockerApiHeaders(src: Headers): Headers {
  return copyUpstreamHeaders(src);
}
