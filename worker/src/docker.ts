import { config } from "./config";
import { copyUpstreamHeaders, joinHeader, text } from "./headers";
import { proxy } from "./proxy";
import {
  encodeHostSegment,
  hostAllowed,
  resolveRegistryHost,
  upstreamOrigin,
  usesHttpOrigin,
} from "./registry-host";
import type { Ctx, FetchFn } from "./types";
import { fetchFollow } from "./upstream";

const BLOB = /^\/v2\/(.+)\/blobs\/(sha256:[0-9a-f]{64})$/;
const MANIFEST = /^\/v2\/(.+)\/manifests\/(.+)$/;
const REPO_ANY = /^\/v2\/(.+?)\/(?:referrers|tags|_catalog)(?:\/|$)/;
const BEARER = /(\w+)="([^"]*)"/g;
const SCOPE_RE = /^repository:(.+):([^:]+)$/;

export type DockerTokenTarget =
  | { kind: "generic"; registryHost: string }
  | { kind: "fixed"; registry: string };

type DockerTarget = {
  key: string;
  upstreamOrigin: string;
  clientPrefix: string;
  path: string;
};

type Tok = { token: string; exp: number };

type ClientAuth =
  | { type: "none" }
  | { type: "basic"; value: string }
  | { type: "bearer"; value: string }
  | { type: "other"; value: string };

class RegistryAuth {
  challenge: string | null = null; // null=unknown, ""=anonymous, else WWW-Authenticate
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

export function parseChallengeParams(challenge: string): Record<string, string> {
  const parts: Record<string, string> = {};
  BEARER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BEARER.exec(challenge))) parts[m[1]] = m[2];
  return parts;
}

export function challengeKind(challenge: string): "bearer" | "basic" | "none" {
  const s = challenge.trim().toLowerCase();
  if (!s) return "none";
  if (s.startsWith("bearer") || /\bbearer\s+realm=/.test(s)) return "bearer";
  if (s.startsWith("basic") || /\bbasic\s+realm=/.test(s)) return "basic";
  return "none";
}

export function rewriteScopeToClient(scope: string, prefix: string): string {
  const m = SCOPE_RE.exec(scope);
  if (!m) return scope;
  const p = prefix.endsWith("/") ? prefix : prefix + "/";
  if (m[1] === prefix || m[1].startsWith(p)) return scope;
  return `repository:${p}${m[1]}:${m[2]}`;
}

export function rewriteScopeFromClient(scope: string, prefix: string): string {
  const m = SCOPE_RE.exec(scope);
  if (!m) return scope;
  const p = prefix.endsWith("/") ? prefix : prefix + "/";
  if (m[1].startsWith(p)) return `repository:${m[1].slice(p.length)}:${m[2]}`;
  return scope;
}

function formatBearer(params: Record<string, string>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${k}="${v}"`);
  return "Bearer " + parts.join(",");
}

export function tokenRealmPath(target: { kind: "generic" | "fixed"; id: string }): string {
  return target.kind === "generic" ? `/token/r/${encodeHostSegment(target.id)}` : `/token/${target.id}`;
}

export function rewriteChallengeForClient(
  challenge: string,
  origin: string,
  clientPrefix: string,
  repo: string | null,
  tokenPath: string,
): string {
  const kind = challengeKind(challenge);
  if (kind !== "bearer") {
    return `Basic realm="${origin}/v2/"`;
  }
  const parts = parseChallengeParams(challenge);
  parts.realm = origin.replace(/\/$/, "") + tokenPath;
  if (repo) {
    parts.scope = `repository:${clientPrefix}/${repo}:pull`;
  } else if (parts.scope) {
    parts.scope = rewriteScopeToClient(parts.scope, clientPrefix);
  }
  return formatBearer(parts);
}

function readClientAuth(headers: Headers): ClientAuth {
  const raw = headers.get("Authorization");
  if (!raw) return { type: "none" };
  const scheme = raw.split(/\s+/, 1)[0]?.toLowerCase() || "";
  if (scheme === "basic") return { type: "basic", value: raw };
  if (scheme === "bearer") return { type: "bearer", value: raw };
  return { type: "other", value: raw };
}

function hasClientSecrets(auth: ClientAuth): boolean {
  return auth.type !== "none";
}

function requestHref(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function dockerFetch(ctx: Ctx): FetchFn {
  return async (input, init) => {
    const href = requestHref(input);
    let u: URL;
    try {
      u = new URL(href);
    } catch {
      return text(400, "invalid upstream url\n");
    }
    if (u.username || u.password) return text(403, "blocked registry host\n");
    const host = resolveRegistryHost(u.host, ctx.env);
    if (!host.ok) return text(403, "blocked registry host\n");
    if (u.protocol === "https:") return ctx.runtime.fetch(input, init);
    if (u.protocol === "http:" && usesHttpOrigin(u.host, ctx.env)) {
      return ctx.runtime.fetch(input, init);
    }
    return text(403, "blocked registry host\n");
  };
}

function withDockerFetch(ctx: Ctx): Ctx {
  return { ...ctx, runtime: { ...ctx.runtime, fetch: dockerFetch(ctx) } };
}

function repoFromPath(path: string): string | null {
  const blob = BLOB.exec(path);
  if (blob) return blob[1];
  const man = MANIFEST.exec(path);
  if (man) return man[1];
  const any = REPO_ANY.exec(path);
  return any ? any[1] : null;
}

async function probeChallenge(ctx: Ctx, url: string, accept: string): Promise<string> {
  const headers = new Headers({
    Accept: accept,
    "User-Agent": "proxyhub-docker",
  });
  let probe = await fetchFollow(ctx.runtime.fetch, url, { method: "HEAD", headers });
  if (probe.status !== 401 && (probe.status === 405 || probe.status === 404 || probe.status >= 500)) {
    if (probe.body) await probe.body.cancel();
    probe = await fetchFollow(ctx.runtime.fetch, url, { method: "GET", headers });
  }
  const chal = probe.headers.get("WWW-Authenticate") || "";
  if (probe.body) await probe.body.cancel();
  if (probe.status !== 401) return "";
  return chal;
}

async function tokenHeader(
  ctx: Ctx,
  name: string,
  challenge: string,
  scope: string | null,
  clientBasic: string | null,
): Promise<Record<string, string>> {
  const parts = parseChallengeParams(challenge);
  const realm = parts.realm || "";
  const useScope = scope || parts.scope || "";
  const service = parts.service || "";
  if (!realm) return {};
  let realmUrl: URL;
  try {
    realmUrl = new URL(realm);
  } catch {
    return {};
  }
  if (realmUrl.username || realmUrl.password) return {};
  const realmHost = resolveRegistryHost(realmUrl.host, ctx.env);
  if (!realmHost.ok) return {};
  if (realmUrl.protocol === "http:" && !usesHttpOrigin(realmUrl.host, ctx.env)) return {};
  if (realmUrl.protocol !== "http:" && realmUrl.protocol !== "https:") return {};

  const state = authFor(name);
  if (!clientBasic) {
    const cached = state.get(useScope, ctx.runtime.now());
    if (cached) return { Authorization: `Bearer ${cached}` };
  }
  const u = new URL(realmUrl.href);
  if (service) u.searchParams.set("service", service);
  if (useScope) u.searchParams.set("scope", useScope);
  const headers = new Headers({
    Accept: "application/json",
    "User-Agent": "proxyhub-docker",
  });
  if (clientBasic) headers.set("Authorization", clientBasic);
  const resp = await fetchFollow(ctx.runtime.fetch, u.href, {
    method: "GET",
    headers,
  });
  if (resp.status !== 200) {
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
  if (!clientBasic) state.put(useScope, tok, ctx.runtime.now());
  return { Authorization: `Bearer ${tok}` };
}

async function prepareUpstreamAuth(
  ctx: Ctx,
  target: DockerTarget,
  url: string,
  accept: string,
  repo: string | null,
  clientAuth: ClientAuth,
): Promise<{ headers: Headers; challengeClient: boolean }> {
  const headers = new Headers({
    Accept: accept,
    "User-Agent": "proxyhub-docker",
  });

  if (clientAuth.type === "bearer" || clientAuth.type === "other") {
    headers.set("Authorization", clientAuth.value);
    return { headers, challengeClient: false };
  }

  const state = authFor(target.key);
  let chal = state.challenge;
  if (chal === null) {
    chal = await probeChallenge(ctx, url, accept);
    state.challenge = chal;
  }

  if (chal === "") {
    if (clientAuth.type === "basic") headers.set("Authorization", clientAuth.value);
    return { headers, challengeClient: false };
  }

  const kind = challengeKind(chal);
  if (kind === "basic") {
    if (clientAuth.type === "basic") {
      headers.set("Authorization", clientAuth.value);
      return { headers, challengeClient: false };
    }
    return { headers, challengeClient: true };
  }

  if (kind === "bearer") {
    const scope = repo ? `repository:${repo}:pull` : null;
    const basic = clientAuth.type === "basic" ? clientAuth.value : null;
    const extra = await tokenHeader(ctx, target.key, chal, scope, basic);
    if (extra.Authorization) {
      headers.set("Authorization", extra.Authorization);
      return { headers, challengeClient: false };
    }
    return { headers, challengeClient: true };
  }

  if (clientAuth.type === "basic") {
    headers.set("Authorization", clientAuth.value);
    return { headers, challengeClient: false };
  }
  return { headers, challengeClient: true };
}

function tokenPathFor(target: DockerTarget): string {
  if (target.clientPrefix.startsWith("r/")) {
    return tokenRealmPath({ kind: "generic", id: target.clientPrefix.slice(2) });
  }
  return tokenRealmPath({ kind: "fixed", id: target.key });
}

function clientChallengeResponse(
  ctx: Ctx,
  target: DockerTarget,
  repo: string | null,
  challenge?: string | null,
): Response {
  const state = authFor(target.key);
  const chal = challenge ?? state.challenge ?? "";
  const www = rewriteChallengeForClient(
    chal,
    ctx.origin,
    target.clientPrefix,
    repo,
    tokenPathFor(target),
  );
  return new Response(null, {
    status: 401,
    headers: {
      "WWW-Authenticate": www,
      "Docker-Distribution-Api-Version": "registry/2.0",
      "X-Proxyhub": "1",
    },
  });
}

async function maybeClientChallenge(
  ctx: Ctx,
  target: DockerTarget,
  repo: string | null,
  resp: Response,
): Promise<Response> {
  if (resp.status !== 401) return resp;
  if (resp.body) await resp.body.cancel();
  const state = authFor(target.key);
  if (state.challenge === "") state.challenge = null;
  if (state.challenge == null) {
    const ping = target.upstreamOrigin.replace(/\/$/, "") + "/v2/";
    state.challenge = await probeChallenge(ctx, ping, "*/*");
  }
  return clientChallengeResponse(ctx, target, repo, state.challenge);
}

function sha1Hex8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

async function handleDockerTarget(ctx: Ctx, target: DockerTarget): Promise<Response> {
  ctx = withDockerFetch(ctx);
  const path = target.path;
  if (path === "/v2" || path === "/v2/") return dockerPing();

  const url = target.upstreamOrigin.replace(/\/$/, "") + path;
  const method = ctx.request.method.toUpperCase();
  const accept = joinHeader(ctx.request.headers, "Accept", "*/*");
  const clientAuth = readClientAuth(ctx.request.headers);
  const cacheable = !hasClientSecrets(clientAuth);
  const repo = repoFromPath(path);

  const prepared = await prepareUpstreamAuth(ctx, target, url, accept, repo, clientAuth);
  if (prepared.challengeClient) {
    return clientChallengeResponse(ctx, target, repo);
  }
  const headers = prepared.headers;
  const extraAuth: Record<string, string> = {};
  if (!cacheable) extraAuth["Cache-Control"] = "no-store";

  const reauth = async () => {
    if (clientAuth.type === "bearer" || clientAuth.type === "other") return {};
    authFor(target.key).invalidate();
    const next = await prepareUpstreamAuth(ctx, target, url, accept, repo, clientAuth);
    if (next.challengeClient) return {};
    const out: Record<string, string> = {};
    const a = next.headers.get("Authorization");
    if (a) out.Authorization = a;
    return out;
  };

  const blob = BLOB.exec(path);
  if (blob) {
    const digest = blob[2];
    const key = `docker:blob:${digest}`;
    const extra = {
      "Docker-Content-Digest": digest,
      "Accept-Ranges": "bytes",
      ...extraAuth,
    };
    if (method === "HEAD") {
      return maybeClientChallenge(
        ctx,
        target,
        repo,
        await proxy(ctx, {
          url,
          headers,
          cacheKey: cacheable ? key : undefined,
          cacheMode: cacheable ? "immutable" : "none",
          ranged: true,
          extraOut: extra,
        }),
      );
    }
    if (method === "GET") {
      return maybeClientChallenge(
        ctx,
        target,
        repo,
        await proxy(ctx, {
          url,
          headers,
          cacheKey: cacheable ? key : undefined,
          cacheMode: cacheable ? "immutable" : "none",
          ranged: true,
          reauth,
          extraOut: extra,
        }),
      );
    }
  }

  const man = MANIFEST.exec(path);
  if (man && (method === "GET" || method === "HEAD")) {
    const reference = man[2];
    if (reference.startsWith("sha256:")) {
      return maybeClientChallenge(
        ctx,
        target,
        repo,
        await proxy(ctx, {
          url,
          headers,
          cacheKey: cacheable && method === "GET" ? `docker:manifest:${reference}` : undefined,
          cacheMode: cacheable && method === "GET" ? "immutable" : "none",
          extraOut: { "Docker-Content-Digest": reference, ...extraAuth },
        }),
      );
    }
    if (method === "HEAD") {
      return maybeClientChallenge(ctx, target, repo, await proxy(ctx, { url, headers, extraOut: extraAuth }));
    }
    const ahash = sha1Hex8(accept);
    return maybeClientChallenge(
      ctx,
      target,
      repo,
      await proxy(ctx, {
        url,
        headers,
        cacheKey: cacheable ? `docker:mtag:${target.key}:${path}:${ahash}` : undefined,
        cacheMode: cacheable ? "revalidate" : "none",
        extraOut: extraAuth,
      }),
    );
  }

  return maybeClientChallenge(
    ctx,
    target,
    repo,
    await proxy(ctx, { url, headers, extraOut: extraAuth }),
  );
}

function invalidHost(): Response {
  return text(400, "invalid registry host\n");
}

function notAllowlisted(): Response {
  return text(403, "registry host not allowlisted\n");
}

export async function handleDocker(ctx: Ctx, registry: string, path: string): Promise<Response> {
  const reg = config.docker[registry];
  if (!reg) return text(404, `unknown or non-public docker source: ${registry}\n`);
  return handleDockerTarget(ctx, {
    key: registry,
    upstreamOrigin: reg.upstream,
    clientPrefix: registry,
    path,
  });
}

export async function handleGenericDocker(
  ctx: Ctx,
  registryHost: string,
  path: string,
): Promise<Response> {
  const parsed = resolveRegistryHost(registryHost, ctx.env);
  if (!parsed.ok) return invalidHost();
  if (!hostAllowed(parsed.host, ctx.env.GENERIC_REGISTRY_ALLOWLIST)) return notAllowlisted();
  return handleDockerTarget(ctx, {
    key: `r/${parsed.host}`,
    upstreamOrigin: upstreamOrigin(parsed.host, ctx.env),
    clientPrefix: `r/${parsed.host}`,
    path,
  });
}

function resolveTokenTarget(
  ctx: Ctx,
  target: DockerTokenTarget,
): { ok: true; docker: DockerTarget } | { ok: false; response: Response } {
  if (target.kind === "fixed") {
    const reg = config.docker[target.registry];
    if (!reg) return { ok: false, response: text(404, `unknown or non-public docker source: ${target.registry}\n`) };
    return {
      ok: true,
      docker: {
        key: target.registry,
        upstreamOrigin: reg.upstream,
        clientPrefix: target.registry,
        path: "/v2/",
      },
    };
  }
  const parsed = resolveRegistryHost(target.registryHost, ctx.env);
  if (!parsed.ok) return { ok: false, response: invalidHost() };
  if (!hostAllowed(parsed.host, ctx.env.GENERIC_REGISTRY_ALLOWLIST)) {
    return { ok: false, response: notAllowlisted() };
  }
  return {
    ok: true,
    docker: {
      key: `r/${parsed.host}`,
      upstreamOrigin: upstreamOrigin(parsed.host, ctx.env),
      clientPrefix: `r/${parsed.host}`,
      path: "/v2/",
    },
  };
}

export async function handleDockerToken(ctx: Ctx, target: DockerTokenTarget): Promise<Response> {
  ctx = withDockerFetch(ctx);
  const resolved = resolveTokenTarget(ctx, target);
  if (!resolved.ok) return resolved.response;
  const docker = resolved.docker;

  const state = authFor(docker.key);
  if (state.challenge === null) {
    const ping = docker.upstreamOrigin.replace(/\/$/, "") + "/v2/";
    state.challenge = await probeChallenge(ctx, ping, "application/json");
  }
  const chal = state.challenge || "";
  if (challengeKind(chal) !== "bearer") {
    return new Response(null, {
      status: 401,
      headers: {
        "WWW-Authenticate": `Basic realm="${ctx.origin}/v2/"`,
        "Docker-Distribution-Api-Version": "registry/2.0",
        "X-Proxyhub": "1",
        "Cache-Control": "no-store",
      },
    });
  }

  const parts = parseChallengeParams(chal);
  const realm = parts.realm || "";
  let realmUrl: URL;
  try {
    realmUrl = new URL(realm);
  } catch {
    return text(502, "upstream token realm unavailable\n");
  }
  if (realmUrl.username || realmUrl.password) return text(502, "upstream token realm unavailable\n");
  if (!resolveRegistryHost(realmUrl.host, ctx.env).ok) return text(502, "upstream token realm unavailable\n");
  if (realmUrl.protocol === "http:" && !usesHttpOrigin(realmUrl.host, ctx.env)) {
    return text(502, "upstream token realm unavailable\n");
  }
  if (realmUrl.protocol !== "http:" && realmUrl.protocol !== "https:") {
    return text(502, "upstream token realm unavailable\n");
  }

  const out = new URL(realmUrl.href);
  const incoming = ctx.url.searchParams;
  incoming.forEach((value, key) => {
    if (key === "scope") return;
    if (key === "service" && out.searchParams.has("service")) return;
    out.searchParams.append(key, value);
  });
  const scopes = incoming.getAll("scope");
  if (scopes.length) {
    out.searchParams.delete("scope");
    for (const scope of scopes) {
      out.searchParams.append("scope", rewriteScopeFromClient(scope, docker.clientPrefix));
    }
  } else if (parts.scope) {
    out.searchParams.set("scope", rewriteScopeFromClient(parts.scope, docker.clientPrefix));
  }
  if (!out.searchParams.has("service") && parts.service) {
    out.searchParams.set("service", parts.service);
  }

  const headers = new Headers({
    Accept: "application/json",
    "User-Agent": "proxyhub-docker",
  });
  const clientAuth = readClientAuth(ctx.request.headers);
  if (clientAuth.type === "basic") headers.set("Authorization", clientAuth.value);

  const resp = await fetchFollow(ctx.runtime.fetch, out.href, { method: "GET", headers });
  const body = await resp.arrayBuffer();
  const outHeaders = new Headers({
    "Content-Type": resp.headers.get("Content-Type") || "application/json",
    "Docker-Distribution-Api-Version": "registry/2.0",
    "X-Proxyhub": "1",
    "Cache-Control": "no-store",
  });
  if (resp.status === 401) {
    outHeaders.set("WWW-Authenticate", `Basic realm="${ctx.origin}/v2/"`);
  }
  return new Response(body, { status: resp.status, headers: outHeaders });
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
