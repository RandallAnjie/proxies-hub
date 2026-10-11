import type { Env } from "./types";

export type HostOk = { ok: true; hostname: string; port: number | null; host: string };
export type HostErr = { ok: false; reason: string };
export type HostCheck = HostOk | HostErr;

const DNS_LABEL = /^(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const BLOCKED_NAME =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;

export type ParseHostOpts = {
  /** Permit loopback / private / link-local IP literals (HTTP_ORIGINS test hook). */
  allowPrivate?: boolean;
  /** Permit a single DNS label (HTTP_ORIGINS test hook). */
  allowSingleLabel?: boolean;
};

export function httpOriginSet(env?: Env): Set<string> {
  const raw = env?.GENERIC_REGISTRY_HTTP_ORIGINS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function usesHttpOrigin(host: string, env?: Env): boolean {
  const set = httpOriginSet(env);
  if (!set.size) return false;
  return set.has(host.trim().toLowerCase());
}

export function parseIpv4(s: string): [number, number, number, number] | null {
  const m = IPV4.exec(s);
  if (!m) return null;
  const oct: [number, number, number, number] = [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
  ];
  if (oct.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return oct;
}

export function isPrivateIpv4(oct: [number, number, number, number]): boolean {
  const [a, b] = oct;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

function mappedV4(ipv6: string): [number, number, number, number] | null {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ipv6);
  if (dotted) return parseIpv4(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ipv6);
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255];
}

export function isBlockedIpv6(raw: string): boolean {
  const s = raw.toLowerCase().trim();
  if (!s || s.includes("%")) return true;
  if (s === "::" || s === "::1") return true;
  if (/^0:0:0:0:0:0:0:(0|1)$/.test(s)) return true;
  if (/^fe[89ab]/i.test(s)) return true;
  if (s.startsWith("fc") || s.startsWith("fd")) return true;
  if (s.startsWith("ff")) return true;
  const v4 = mappedV4(s);
  if (v4) return isPrivateIpv4(v4);
  return false;
}

function parsePort(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

function looksIpv6(s: string): boolean {
  return s.includes(":");
}

/**
 * Registry host as `hostname[:port]` or `[ipv6][:port]`.
 * Rejects userinfo, schemes, private/loopback/link-local IP literals,
 * localhost-style names, and single-label DNS names (unless opted in).
 */
export function parseRegistryHost(raw: string, opts: ParseHostOpts = {}): HostCheck {
  if (!raw || raw.length > 280) return { ok: false, reason: "empty or too long" };
  if (/[\s\\/@?#]/.test(raw) || raw.includes("://")) {
    return { ok: false, reason: "invalid characters" };
  }

  let hostname: string;
  let port: number | null = null;

  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end < 2) return { ok: false, reason: "bad ipv6" };
    hostname = raw.slice(1, end);
    const rest = raw.slice(end + 1);
    if (rest) {
      if (!rest.startsWith(":")) return { ok: false, reason: "bad ipv6 port" };
      port = parsePort(rest.slice(1));
      if (port == null) return { ok: false, reason: "bad port" };
    }
    if (!hostname || /[^0-9a-fA-F:]/.test(hostname)) return { ok: false, reason: "bad ipv6" };
    if (!opts.allowPrivate && isBlockedIpv6(hostname)) return { ok: false, reason: "blocked ip" };
    const host = port != null ? `[${hostname}]:${port}` : `[${hostname}]`;
    return { ok: true, hostname, port, host };
  }

  const colon = raw.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/.test(raw.slice(colon + 1))) {
    port = parsePort(raw.slice(colon + 1));
    if (port == null) return { ok: false, reason: "bad port" };
    hostname = raw.slice(0, colon);
  } else if (looksIpv6(raw)) {
    return { ok: false, reason: "unbracketed ipv6" };
  } else {
    hostname = raw;
  }

  if (!hostname) return { ok: false, reason: "empty host" };

  const v4 = parseIpv4(hostname);
  if (v4) {
    if (!opts.allowPrivate && isPrivateIpv4(v4)) return { ok: false, reason: "blocked ip" };
    const host = port != null ? `${hostname}:${port}` : hostname;
    return { ok: true, hostname, port, host };
  }

  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (!hostname || hostname.length > 253) return { ok: false, reason: "hostname too long" };
  if (BLOCKED_NAME.test(hostname)) return { ok: false, reason: "blocked host" };
  const labels = hostname.split(".");
  if (labels.some((l) => !DNS_LABEL.test(l))) return { ok: false, reason: "invalid hostname" };
  if (labels.length < 2 && !opts.allowSingleLabel) return { ok: false, reason: "single-label host" };

  const host = port != null ? `${hostname}:${port}` : hostname;
  return { ok: true, hostname, port, host };
}

/** Parse + honour GENERIC_REGISTRY_HTTP_ORIGINS (exact host[:port]). */
export function resolveRegistryHost(raw: string, env?: Env): HostCheck {
  const trimmed = raw.trim();
  const http = usesHttpOrigin(trimmed, env);
  return parseRegistryHost(trimmed, { allowPrivate: http, allowSingleLabel: http });
}

export function hostAllowed(host: string, allowlist: string | undefined): boolean {
  if (!allowlist || !allowlist.trim()) return true;
  const parsed = parseRegistryHost(host, { allowPrivate: true, allowSingleLabel: true });
  const hostname = (parsed.ok ? parsed.hostname : host).toLowerCase();
  const full = (parsed.ok ? parsed.host : host).toLowerCase();
  for (const raw of allowlist.split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*" || entry === full || entry === hostname) return true;
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1);
      if (hostname.endsWith(suffix) && hostname.length > suffix.length) return true;
    }
  }
  return false;
}

export function decodeHostSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return "";
  }
}

export function encodeHostSegment(host: string): string {
  return encodeURIComponent(host);
}

export function upstreamOrigin(host: string, env?: Env): string {
  const scheme = usesHttpOrigin(host, env) ? "http" : "https";
  return `${scheme}://${host}`;
}
