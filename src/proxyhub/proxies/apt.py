"""apt mirror, apt-cacher-ng style (hostname in the path).

Clients rewrite ``sources.list`` to prefix the upstream host with this proxy::

    deb https://apt.<domain>/archive.ubuntu.com/ubuntu jammy main universe
    deb https://apt.<domain>/developer.download.nvidia.com/compute/cuda/repos/... /

Package files (``*.deb`` / ``*.udeb`` / ``*.ddeb``) are immutable and cached
(Range-aware, for apt's resumable downloads); index files (Release, InRelease,
Packages, Sources, by-hash …) are passed through fresh so apt never sees a
stale index vs. package mismatch.
"""
from __future__ import annotations

from aiohttp import web

from ..cache import DiskCache
from ..config import AptCfg
from .base import proxy

_PKG = (".deb", ".udeb", ".ddeb")


class AptProxy:
    def __init__(self, cfg: AptCfg, cache: DiskCache):
        self.cache = cache
        self.scheme = cfg.scheme

    async def handle(self, request: web.Request) -> web.StreamResponse:
        p = request.raw_path.lstrip("/")
        if "/" not in p:
            return web.Response(status=400, text="usage: /<host>/<path>\n")
        host, rest = p.split("/", 1)
        url = f"{self.scheme}://{host}/{rest}"
        path_only = rest.split("?", 1)[0]
        cacheable = request.method == "GET" and path_only.endswith(_PKG)
        headers = {"User-Agent": "Debian APT-HTTP/1.3 (proxyhub)", "Host": host}
        if "Accept" in request.headers:
            headers["Accept"] = request.headers["Accept"]
        key = f"apt:{host}/{path_only}"
        return await proxy(request, self.cache, key, request.method, url, headers, cacheable)
