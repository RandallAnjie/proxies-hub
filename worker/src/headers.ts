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

/** Single `bytes=` range. `start === null` is a suffix (`bytes=-N`). */
export type ClientRange = {
  start: number | null;
  end: number | null;
};

export function parseRange(header: string | null): ClientRange | null {
  if (!header || !header.startsWith("bytes=") || header.includes(",")) return null;
  const spec = header.slice(6);
  const dash = spec.indexOf("-");
  if (dash === -1) return null;
  const a = spec.slice(0, dash);
  const b = spec.slice(dash + 1);
  if (a === "") {
    if (!b) return null;
    const suffix = Number(b);
    if (!Number.isFinite(suffix) || suffix < 0) return null;
    return { start: null, end: suffix };
  }
  const start = Number(a);
  if (!Number.isFinite(start) || start < 0) return null;
  if (!b) return { start, end: null };
  const end = Number(b);
  if (!Number.isFinite(end) || end < start) return null;
  return { start, end };
}

/** Inclusive `[start, last]` against `total`, or null if the range is unsatisfiable. */
export function resolveByteRange(
  range: ClientRange,
  total: number,
): { start: number; last: number } | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  if (range.start == null) {
    const suffix = range.end;
    if (suffix == null || suffix <= 0) return null;
    return { start: Math.max(0, total - suffix), last: total - 1 };
  }
  if (range.start >= total) return null;
  const last = range.end == null ? total - 1 : Math.min(range.end, total - 1);
  if (range.start > last) return null;
  return { start: range.start, last };
}

export function parseContentRange(
  header: string | null,
): { start: number; end: number; total: number } | null {
  if (!header) return null;
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  const total = m[3] === "*" ? -1 : Number(m[3]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return null;
  if (m[3] !== "*" && (!Number.isFinite(total) || total < 0)) return null;
  return { start, end, total };
}

export function text(status: number, body: string, extra?: Record<string, string>): Response {
  const headers = new Headers({
    "Content-Type": "text/plain; charset=utf-8",
    "X-Proxyhub": "1",
    ...extra,
  });
  return new Response(body, { status, headers });
}

/** Headers for a body we already decoded / rewrote (never keep Content-Encoding). */
export function bufferedHeaders(src: Headers, extra?: Record<string, string>): Headers {
  const out = copyUpstreamHeaders(src, extra);
  out.delete("Content-Encoding");
  out.delete("Content-Length");
  return out;
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

/**
 * Content-Length from a Headers map. workerd's fetch() exposes the header to
 * `forEach` but `get("Content-Length")` is null (forbidden response header),
 * so we iterate when get() misses.
 */
export function contentLength(headers: Headers): number | null {
  const raw = headers.get("Content-Length") ?? headers.get("content-length");
  if (raw != null && raw !== "") {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  let found: string | null = null;
  headers.forEach((value, key) => {
    if (key.toLowerCase() === "content-length") found = value;
  });
  if (found == null || found === "") return null;
  const n = Number(found);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseContentRangeTotal(header: string | null): number | null {
  if (!header || !header.includes("/")) return null;
  const total = header.split("/").pop();
  if (!total || total === "*") return null;
  const n = Number(total);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
