"""Rust cargo sparse-registry mirror.

Cargo talks the "sparse" protocol: it reads ``/config.json`` for a ``dl`` base,
fetches per-crate index files (newline-JSON, one line per version), then
downloads ``.crate`` tarballs from ``dl``. We proxy the index (revalidated, it
changes as versions publish) and the tarballs (immutable, cached), and rewrite
``dl`` in config.json to point back here.

Client (~/.cargo/config.toml)::

    [source.crates-io]
    replace-with = "mirror"
    [registries.mirror]
    index = "sparse+https://crates.<domain>/"
"""
from __future__ import annotations

from aiohttp import web

from ..cache import DiskCache
from .base import fetch_json, proxy, send, upstream_filler

_INDEX = "https://index.crates.io"
_STATIC = "https://static.crates.io/crates"
_UA = {"User-Agent": "proxyhub-crates"}


class CratesProxy:
    def __init__(self, cache: DiskCache):
        self.cache = cache

    async def handle(self, request: web.Request) -> web.StreamResponse:
        p = request.raw_path.split("?", 1)[0]

        # registry config — rewrite the download base to route crates through us
        if p == "/config.json":
            status, data = await fetch_json(f"{_INDEX}/config.json", dict(_UA))
            if not data:
                return web.Response(status=502, text="crates config unavailable\n")
            data = dict(data)
            # `prefix` is set when reached via the all-in-one host (all.<domain>/crates)
            data["dl"] = f"https://{request.host}{request.get('prefix', '')}/dl"
            return web.json_response(data)

        # crate tarball — immutable, cache it
        if p.startswith("/dl/"):
            rest = p[len("/dl/"):]
            key = f"crates:file:{rest}"
            return await proxy(request, self.cache, key, "GET",
                               f"{_STATIC}/{rest}", dict(_UA), cacheable=True)

        # index file — cache with revalidation (new versions append lines)
        url = f"{_INDEX}{p}"
        key = f"crates:idx:{p}"
        cached = self.cache.peek(key)
        if cached is not None:
            et = cached.extra_headers.get("ETag") or cached.extra_headers.get("Etag")
            lm = cached.extra_headers.get("Last-Modified")
            if et or lm:
                cond = dict(_UA)
                if et:
                    cond["If-None-Match"] = et
                if lm:
                    cond["If-Modified-Since"] = lm
                meta, chunks = await self.cache.stream_revalidate(
                    key, upstream_filler("GET", url, cond), cached)
                return await send(request, meta, chunks)
        meta, chunks = await self.cache.stream(key, upstream_filler("GET", url, dict(_UA)),
                                               cacheable=True)
        return await send(request, meta, chunks)
