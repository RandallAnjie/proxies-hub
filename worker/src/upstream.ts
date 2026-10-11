import { REDIRECT } from "./headers";
import type { FetchFn } from "./types";

/**
 * Follow redirects by hand so Authorization is dropped on a host change
 * (GitHub/ghcr signed CDN URLs reject a re-sent token).
 */
export async function fetchFollow(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  maxRedirects = 6,
): Promise<Response> {
  let current = url;
  let method = (init.method || "GET").toUpperCase();
  let body = init.body;
  const headers = new Headers(init.headers);

  for (let i = 0; i <= maxRedirects; i++) {
    const reqInit: RequestInit = {
      method,
      headers,
      body,
      redirect: "manual",
      signal: init.signal ?? null,
    };
    if (body != null) {
      (reqInit as RequestInit & { duplex?: string }).duplex = "half";
    }
    const resp = await fetchFn(current, reqInit);
    const loc = resp.headers.get("Location");
    if (loc && REDIRECT.has(resp.status)) {
      const next = new URL(loc, current);
      if (next.host !== new URL(current).host) {
        headers.delete("Authorization");
        headers.delete("Host");
      }
      if (resp.status === 303) {
        method = "GET";
        body = undefined;
      }
      current = next.href;
      if (resp.body) await resp.body.cancel();
      continue;
    }
    return resp;
  }
  return new Response("too many redirects", { status: 508, headers: { "X-Proxyhub": "1" } });
}

export async function fetchJson(
  fetchFn: FetchFn,
  url: string,
  headers: HeadersInit,
): Promise<{ status: number; data: unknown }> {
  const resp = await fetchFollow(fetchFn, url, { method: "GET", headers });
  try {
    return { status: resp.status, data: await resp.json() };
  } catch {
    return { status: resp.status, data: null };
  }
}
