"""Shared helpers: fetch upstream (with smart redirect handling) as a cache
Filler, and send a (meta, chunk-iterator) result back to the client."""
from __future__ import annotations

from typing import AsyncIterator, Optional
from urllib.parse import urljoin, urlsplit

import aiohttp
from aiohttp import web

from ..cache import CacheMeta
from ..upstream import session

CHUNK = 256 * 1024

# headers we never copy back to the client
_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "content-length",
    "content-encoding", "set-cookie",
}
_REDIRECT = {301, 302, 303, 307, 308}


def upstream_filler(method: str, url: str, headers: dict,
                    body: Optional[bytes] = None, max_redirects: int = 6):
    """Return a Filler that fetches ``url`` and yields (CacheMeta, b"") then data.

    Redirects are followed manually so that the ``Authorization`` header is
    dropped whenever the redirect crosses to a different host (GitHub/ghcr send
    signed CDN URLs that reject a re-sent token)."""

    async def gen() -> AsyncIterator[tuple[Optional[CacheMeta], bytes]]:
        cur_url = url
        cur_headers = dict(headers)
        cur_method = method
        cur_body = body
        for _ in range(max_redirects + 1):
            resp = await session().request(
                cur_method, cur_url, headers=cur_headers, data=cur_body,
                allow_redirects=False)
            loc = resp.headers.get("Location")
            if resp.status in _REDIRECT and loc:
                await resp.release()
                nxt = urljoin(cur_url, loc)
                if urlsplit(nxt).netloc != urlsplit(cur_url).netloc:
                    cur_headers = {k: v for k, v in cur_headers.items()
                                   if k.lower() not in ("authorization", "host")}
                if resp.status == 303:
                    cur_method, cur_body = "GET", None
                cur_url = nxt
                continue
            try:
                keep = {k: v for k, v in resp.headers.items() if k.lower() not in _HOP}
                try:
                    total = int(resp.headers.get("Content-Length", "-1"))
                except ValueError:
                    total = -1
                meta = CacheMeta(
                    key="", size=-1, total=total,
                    content_type=resp.headers.get("Content-Type", "application/octet-stream"),
                    status=resp.status, extra_headers=keep)
                yield meta, b""
                async for chunk in resp.content.iter_chunked(CHUNK):
                    yield None, chunk
            finally:
                await resp.release()
            return
        yield (CacheMeta(key="", size=0, content_type="text/plain", status=508),
               b"too many redirects")

    return gen


def ranged_upstream_filler(url: str, headers: dict, chunk: int = 128 * 1024 * 1024,
                           reauth=None):
    """Fetch a large object in sequential ``Range`` chunks, so no single upstream
    connection stays open long enough to be cut (ghcr/CDNs drop slow long-lived
    fetches). Reassembles into one logical stream. Falls back to a single full
    stream if the upstream ignores Range.

    ``reauth`` (optional ``async () -> dict``) is called when the *origin*
    answers ``401`` mid-transfer — a token that expired during a long fetch. The
    fresh auth headers are adopted and the *same* chunk is retried, so a download
    that outlives the token continues from where it was rather than restarting."""

    async def gen() -> AsyncIterator[tuple[Optional[CacheMeta], bytes]]:
        pos = 0
        total: Optional[int] = None
        first = True
        auth = dict(headers)                 # refreshed in place on a 401
        while total is None or pos < total:
            resp = None
            reauthed = 0
            while True:                      # one chunk: redirect-follow + reauth
                h = dict(auth)
                h["Range"] = f"bytes={pos}-{pos + chunk - 1}"
                cur_url, cur_headers = url, h
                for _ in range(6):
                    resp = await session().get(cur_url, headers=cur_headers, allow_redirects=False)
                    loc = resp.headers.get("Location")
                    if resp.status in _REDIRECT and loc:
                        await resp.release()
                        nxt = urljoin(cur_url, loc)
                        if urlsplit(nxt).netloc != urlsplit(cur_url).netloc:
                            cur_headers = {k: v for k, v in cur_headers.items()
                                           if k.lower() not in ("authorization", "host")}
                        cur_url = nxt
                        continue
                    break
                # token expired at the origin -> refresh once or twice, retry pos
                if resp.status == 401 and reauth and reauthed < 2:
                    await resp.release()
                    reauthed += 1
                    fresh = await reauth()
                    if fresh:
                        auth.update(fresh)
                        continue
                break
            if first:
                first = False
                if resp.status == 206:
                    cr = resp.headers.get("Content-Range", "")
                    total = int(cr.rsplit("/", 1)[1]) if "/" in cr else -1
                else:
                    total = -1   # upstream ignored Range -> single response
                keep = {k: v for k, v in resp.headers.items()
                        if k.lower() not in _HOP and k.lower() != "content-range"}
                yield CacheMeta(
                    key="", size=-1, total=(total if total and total > 0 else -1),
                    content_type=resp.headers.get("Content-Type", "application/octet-stream"),
                    status=(resp.status if resp.status >= 400 else 200),
                    extra_headers=keep), b""
                if total is None or total < 0:
                    async for c in resp.content.iter_chunked(CHUNK):
                        yield None, c
                    await resp.release()
                    return
            elif resp.status not in (200, 206):
                await resp.release()
                raise RuntimeError(f"range chunk {pos} failed: {resp.status}")
            async for c in resp.content.iter_chunked(CHUNK):
                yield None, c
            await resp.release()
            pos += chunk

    return gen


async def send(request: web.Request, meta: CacheMeta,
               chunks: AsyncIterator[bytes]) -> web.StreamResponse:
    if request.method == "HEAD":
        resp = web.StreamResponse(status=meta.status)
        _apply(resp, meta)
        await resp.prepare(request)
        await resp.write_eof()
        # drain the (unused) body iterator
        try:
            async for _ in chunks:
                break
        except Exception:
            pass
        return resp
    resp = web.StreamResponse(status=meta.status)
    _apply(resp, meta)
    await resp.prepare(request)
    try:
        async for chunk in chunks:
            await resp.write(chunk)
    except (ConnectionResetError, aiohttp.ClientError):
        pass
    await resp.write_eof()
    return resp


def _apply(resp: web.StreamResponse, meta: CacheMeta):
    for k, v in meta.extra_headers.items():
        resp.headers[k] = v
    resp.headers["Content-Type"] = meta.content_type
    if meta.size is not None and meta.size >= 0:
        resp.headers["Content-Length"] = str(meta.size)
    resp.headers["X-Proxyhub"] = "1"


def parse_range(request: web.Request):
    """Return (start, end|None) for a simple single ``bytes=`` range, else None."""
    rng = request.headers.get("Range")
    if not rng or not rng.startswith("bytes=") or "," in rng:
        return None
    a, _, b = rng[6:].partition("-")
    try:
        if a == "":      # suffix range (bytes=-N): let upstream handle it
            return None
        return int(a), (int(b) if b else None)
    except ValueError:
        return None


async def proxy(request: web.Request, cache, key: str, method: str, url: str,
                base_headers: dict, cacheable: bool) -> web.StreamResponse:
    """Unified GET proxy: caches full objects, serves Range from cache,
    passes through everything non-cacheable (forwarding the client Range)."""
    rng = parse_range(request) if method == "GET" else None
    if cacheable and method == "GET":
        filler = upstream_filler("GET", url, base_headers)  # full fetch (no Range)
        if rng:
            meta, chunks = await cache.stream_range(key, rng[0], rng[1], filler, cacheable=True)
        else:
            meta, chunks = await cache.stream(key, filler, cacheable=True)
    else:
        h = dict(base_headers)
        if "Range" in request.headers:
            h["Range"] = request.headers["Range"]
        body = await request.read() if method in ("POST", "PUT", "PATCH") else None
        filler = upstream_filler(method, url, h, body=body)
        meta, chunks = await cache.stream("", filler, cacheable=False)
    return await send(request, meta, chunks)


async def fetch_json(url: str, headers: dict):
    async with session().get(url, headers=headers) as r:
        try:
            return r.status, await r.json(content_type=None)
        except Exception:
            return r.status, None
