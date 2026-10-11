/** Hop-by-hop + headers we never copy from upstream (see Python base._HOP). */
export const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "set-cookie",
  "www-authenticate",
]);

export const REDIRECT = new Set([301, 302, 303, 307, 308]);

export function copyUpstreamHeaders(
  src: Headers,
  extra?: Record<string, string>,
  opts?: { keepEncoding?: boolean; drop?: string[] },
): Headers {
  const out = new Headers();
  const drop = new Set((opts?.drop ?? []).map((h) => h.toLowerCase()));
  src.forEach((value, key) => {
    const k = key.toLowerCase();
    if (drop.has(k)) return;
    if (HOP.has(k)) {
      // Stream the bytes we got. If we did not decompress, keep Content-Encoding
      // so the client can decode. Range-stitched docker blobs have none.
      if (k === "content-encoding" && opts?.keepEncoding) out.set(key, value);
      return;
    }
    out.set(key, value);
  });
  out.set("X-Proxyhub", "1");
  if (extra) {
    for (const [k, v] of Object.entries(extra)) out.set(k, v);
  }
  return out;
}

export function parseRange(
  header: string | null,
): { start: number; end: number | null } | null {
  if (!header || !header.startsWith("bytes=") || header.includes(",")) return null;
  const spec = header.slice(6);
  const dash = spec.indexOf("-");
  if (dash === -1) return null;
  const a = spec.slice(0, dash);
  const b = spec.slice(dash + 1);
  if (a === "") return null;
  const start = Number(a);
  if (!Number.isFinite(start) || start < 0) return null;
  if (!b) return { start, end: null };
  const end = Number(b);
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end };
}

export function text(status: number, body: string, extra?: Record<string, string>): Response {
  const headers = new Headers({
    "Content-Type": "text/plain; charset=utf-8",
    "X-Proxyhub": "1",
    ...extra,
  });
  return new Response(body, { status, headers });
}

export function withProxyhub(resp: Response, extra?: Record<string, string>): Response {
  const headers = new Headers(resp.headers);
  headers.set("X-Proxyhub", "1");
  if (extra) for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, headers });
}

export function joinHeader(headers: Headers, name: string, fallback: string): string {
  const v = headers.get(name);
  return v && v.length ? v : fallback;
}

export function contentLength(headers: Headers): number | null {
  const raw = headers.get("Content-Length");
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseContentRangeTotal(header: string | null): number | null {
  if (!header || !header.includes("/")) return null;
  const total = header.split("/").pop();
  if (!total || total === "*") return null;
  const n = Number(total);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
