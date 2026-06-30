"""Package-index mirror (conda, pytorch wheels …) and a generic url-prefix cache.

Immutable package files are cached (Range-aware); index files (repodata.json,
directory listings, *.html, index.yaml) are passed through fresh via the
``no_cache`` regexes.
"""
from __future__ import annotations

import re
from urllib.parse import urlsplit

from aiohttp import web

from ..cache import DiskCache
from ..config import WebMirror
from .base import proxy, send, upstream_filler


class WebCacheProxy:
    def __init__(self, mirror: WebMirror, cache: DiskCache):
        self.mirror = mirror
        self.cache = cache
        self.upstream = mirror.upstream.rstrip("/")
        self.host = urlsplit(self.upstream).netloc
        self._no_cache = [re.compile(p) for p in mirror.no_cache]
        self._revalidate = [re.compile(p) for p in mirror.revalidate]

    def _cacheable(self, path: str) -> bool:
        return not any(p.search(path) for p in self._no_cache)

    def _revalidatable(self, path: str) -> bool:
        return any(p.search(path) for p in self._revalidate)

    async def handle(self, request: web.Request) -> web.StreamResponse:
        path = request.raw_path
        url = self.upstream + path
        headers = {"User-Agent": "proxyhub-web", "Host": self.host}
        if "Accept" in request.headers:
            headers["Accept"] = request.headers["Accept"]
        key = f"web:{self.mirror.name}:{path}"

        # indexes: cache WITH conditional revalidation (fresh, but a 304 avoids
        # re-downloading an unchanged — often large — index)
        if request.method == "GET" and self._revalidatable(path):
            cached = self.cache.peek(key)
            if cached is not None:
                cond = dict(headers)
                et = cached.extra_headers.get("ETag") or cached.extra_headers.get("Etag")
                lm = cached.extra_headers.get("Last-Modified")
                if et:
                    cond["If-None-Match"] = et
                if lm:
                    cond["If-Modified-Since"] = lm
                if et or lm:
                    filler = upstream_filler("GET", url, cond)
                    meta, chunks = await self.cache.stream_revalidate(key, filler, cached)
                    return await send(request, meta, chunks)
            # first sight (or no validators stored): cache it, validators and all
            return await proxy(request, self.cache, key, "GET", url, headers, True)

        cacheable = request.method == "GET" and self._cacheable(path)
        return await proxy(request, self.cache, key, request.method, url, headers, cacheable)


_GEN = re.compile(r"^/+(https?)[:/]+([^/]+)(/.*)?$")


class GenericCacheProxy:
    """cache.<domain>/https/<host>/<path>  ->  caches arbitrary direct files."""

    def __init__(self, cache: DiskCache):
        self.cache = cache

    async def handle(self, request: web.Request) -> web.StreamResponse:
        m = _GEN.match(request.raw_path.split("?", 1)[0])
        if not m:
            return web.Response(status=400, text="usage: /https/<host>/<path>\n")
        scheme, host, rest = m.group(1), m.group(2), m.group(3) or "/"
        url = f"{scheme}://{host}{rest}"
        if request.query_string:
            url += "?" + request.query_string
        headers = {"User-Agent": "proxyhub-cache", "Host": host}
        cacheable = request.method == "GET" and not rest.endswith(("/", ".html", "index.yaml"))
        key = f"gen:{host}{rest}"
        return await proxy(request, self.cache, key, request.method, url, headers, cacheable)
