import { config } from "./config";
import { text } from "./headers";
import { passthrough, proxy } from "./proxy";
import type { Ctx } from "./types";
import { fetchJson } from "./upstream";

const API = "https://api.github.com";
const ALLOWED = new Set([
  "github.com",
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
  "gist.github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "user-images.githubusercontent.com",
  "avatars.githubusercontent.com",
  "media.githubusercontent.com",
]);
const URL_RE = /^\/+(https?):\/+(.+)$/;
const RELDL = /^github\.com\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/([^/?]+)/;
const FWD = new Set([
  "accept",
  "content-type",
  "range",
  "if-none-match",
  "if-modified-since",
  "git-protocol",
  "user-agent",
]);

function b64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromB64(s: string): string {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function basic(pat: string): string {
  return "Basic " + b64(`x-access-token:${pat}`);
}

export function resolveGithubAuth(
  request: Request,
  env: Ctx["env"],
): { auth: string | null; fromAlias: boolean } {
  const aliases = config.github.tokenAliases;
  const url = new URL(request.url);
  const tok = url.searchParams.get("token");
  if (tok) {
    const envName = aliases[tok];
    const real = envName ? env[envName] : undefined;
    return { auth: basic(real || tok), fromAlias: Boolean(real) };
  }
  const hdr = request.headers.get("Authorization");
  if (!hdr) return { auth: null, fromAlias: false };
  if (hdr.toLowerCase().startsWith("basic ")) {
    try {
      const decoded = fromB64(hdr.slice(6));
      const colon = decoded.indexOf(":");
      const user = colon === -1 ? decoded : decoded.slice(0, colon);
      const pwd = colon === -1 ? "" : decoded.slice(colon + 1);
      const envName = aliases[pwd] || aliases[user];
      const real = envName ? env[envName] : undefined;
      if (real) return { auth: basic(real), fromAlias: true };
    } catch {
      return { auth: hdr, fromAlias: false };
    }
  }
  return { auth: hdr, fromAlias: false };
}

function fwdHeaders(request: Request, auth: string | null): Headers {
  const h = new Headers();
  request.headers.forEach((value, key) => {
    if (FWD.has(key.toLowerCase())) h.set(key, value);
  });
  if (!h.has("User-Agent")) h.set("User-Agent", "proxyhub-gh");
  if (auth) h.set("Authorization", auth);
  return h;
}

export async function handleGithub(ctx: Ctx, path: string): Promise<Response> {
  const rawPath = path.split("?")[0];
  const m = URL_RE.exec(rawPath);
  let scheme: string;
  let rest: string;
  if (m) {
    scheme = m[1];
    rest = m[2];
  } else {
    scheme = "https";
    rest = rawPath.replace(/^\/+/, "");
  }
  const host = rest.split("/")[0];
  if (!ALLOWED.has(host)) return text(403, `host not allowed: ${host}\n`);

  const { auth, fromAlias } = resolveGithubAuth(ctx.request, ctx.env);
  const q = new URL(ctx.request.url).searchParams;
  if (
    fromAlias &&
    (rest.endsWith("/git-receive-pack") || q.get("service") === "git-receive-pack")
  ) {
    return text(403, "token aliases are read-only; push with a real PAT\n");
  }

  const rel = RELDL.exec(rest);
  if (rel && (ctx.request.method === "GET" || ctx.request.method === "HEAD")) {
    return release(ctx, rel[1], rel[2], rel[3], rel[4], auth);
  }

  const target = new URL(`${scheme}://${rest}`);
  q.forEach((v, k) => {
    if (k !== "token") target.searchParams.append(k, v);
  });

  const headers = fwdHeaders(ctx.request, auth);
  const resp = await passthrough(ctx, target.href, headers);
  if (resp.status === 401) {
    const headers2 = new Headers(resp.headers);
    headers2.set("WWW-Authenticate", 'Basic realm="proxyhub-github"');
    headers2.set("X-Proxyhub", "1");
    return new Response(resp.body, { status: 401, headers: headers2 });
  }
  return resp;
}

async function release(
  ctx: Ctx,
  owner: string,
  repo: string,
  tag: string,
  asset: string,
  auth: string | null,
): Promise<Response> {
  const name = decodeURIComponent(asset);
  const base: Record<string, string> = { "User-Agent": "proxyhub-gh" };
  if (auth) base.Authorization = auth;
  const acceptJson = { ...base, Accept: "application/vnd.github+json" };

  let { status, data } = await fetchJson(
    ctx.runtime.fetch,
    `${API}/repos/${owner}/${repo}/releases/tags/${tag}`,
    acceptJson,
  );
  if ((status !== 200 || !data || typeof data !== "object") && tag === "latest") {
    ({ status, data } = await fetchJson(
      ctx.runtime.fetch,
      `${API}/repos/${owner}/${repo}/releases/latest`,
      acceptJson,
    ));
  }
  if (status !== 200 || !data || typeof data !== "object") {
    return text(status && status >= 400 ? status : 502, `release lookup failed (${status})\n`);
  }
  const rel = data as { assets?: { name: string; id: number; updated_at?: string }[] };
  const a = (rel.assets || []).find((x) => x.name === name);
  if (!a) return text(404, `asset not found: ${name}\n`);

  const url = `${API}/repos/${owner}/${repo}/releases/assets/${a.id}`;
  const headers = { ...base, Accept: "application/octet-stream" };
  const key = `gh:asset:${a.id}:${a.updated_at || ""}`;
  return proxy(ctx, {
    url,
    headers,
    cacheKey: ctx.request.method === "GET" ? key : undefined,
    cacheMode: ctx.request.method === "GET" ? "immutable" : "none",
    ranged: ctx.request.method === "GET",
    extraOut: { "Content-Disposition": `attachment; filename="${name}"` },
  });
}
