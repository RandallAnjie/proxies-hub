"""Docker Registry v2 pull-through proxy.

Implements just enough of the distribution protocol to be a caching mirror:
  * resolves upstream bearer tokens from the ``WWW-Authenticate`` challenge,
    using configured credentials (a PAT for private ghcr, etc.);
  * proxies manifests live (short TTL handled by simply not caching them);
  * caches immutable blobs (``/blobs/sha256:...``) with the decoupled buffer.
"""
from __future__ import annotations

import base64
import re
import time
from typing import Optional

from aiohttp import web

from ..cache import DiskCache
from ..config import DockerRegistry
from ..upstream import session
from .base import parse_range, proxy, ranged_upstream_filler, send, upstream_filler

_BLOB = re.compile(r"^/v2/.+/blobs/sha256:[0-9a-f]{64}$")
_BEARER = re.compile(r'(\w+)="([^"]*)"')


async def _empty():
    if False:  # pragma: no cover - empty async iterator
        yield b""


class _TokenCache:
    def __init__(self):
        self._toks: dict[str, tuple[str, float]] = {}

    def get(self, scope: str) -> Optional[str]:
        t = self._toks.get(scope)
        if t and t[1] > time.time():
            return t[0]
        return None

    def put(self, scope: str, token: str, ttl: int = 240):
        self._toks[scope] = (token, time.time() + ttl)

    def invalidate(self):
        self._toks.clear()


class DockerProxy:
    def __init__(self, reg: DockerRegistry, cache: DiskCache):
        self.reg = reg
        self.cache = cache
        self.tokens = _TokenCache()

    async def _auth_header(self, challenge: str) -> dict:
        """Turn a Bearer challenge into an Authorization header by fetching a token."""
        parts = dict(_BEARER.findall(challenge))
        realm = parts.get("realm", "")
        scope = parts.get("scope", "")
        service = parts.get("service", "")
        if not realm:
            return {}
        cached = self.tokens.get(scope)
        if cached:
            return {"Authorization": f"Bearer {cached}"}
        params = {}
        if service:
            params["service"] = service
        if scope:
            params["scope"] = scope
        headers = {}
        if self.reg.username or self.reg.password:
            cred = base64.b64encode(f"{self.reg.username}:{self.reg.password}".encode()).decode()
            headers["Authorization"] = f"Basic {cred}"
        async with session().get(realm, params=params, headers=headers) as r:
            if r.status != 200:
                return {}
            data = await r.json(content_type=None)
        tok = data.get("token") or data.get("access_token") or ""
        if tok:
            self.tokens.put(scope, tok)
            return {"Authorization": f"Bearer {tok}"}
        return {}

    async def _authorized_headers(self, url: str, accept: str) -> dict:
        """Probe the upstream once to learn the auth challenge, return headers."""
        headers = {"Accept": accept, "User-Agent": "proxyhub-docker"}
        async with session().head(url, headers=headers, allow_redirects=False) as r:
            if r.status != 401:
                return headers
            chal = r.headers.get("WWW-Authenticate", "")
        if chal.lower().startswith("bearer"):
            headers.update(await self._auth_header(chal))
        return headers

    async def handle(self, request: web.Request) -> web.StreamResponse:
        path = request.path  # e.g. /v2/library/nginx/manifests/latest
        # /v2/ ping: answer locally (this proxy fronts auth; clients auth to us
        # via the reverse proxy's basic-auth, we handle the upstream token flow).
        if path in ("/v2", "/v2/"):
            return web.Response(status=200, headers={
                "Docker-Distribution-Api-Version": "registry/2.0", "X-Proxyhub": "1"})
        url = self.reg.upstream.rstrip("/") + path
        method = request.method
        is_blob = bool(_BLOB.match(path))
        digest = path.rsplit("/", 1)[-1]
        key = f"docker:{self.reg.name}:{path}"

        # cached blob: serve from disk, never touch upstream
        if is_blob:
            cached = self.cache.lookup(key)
            if cached is not None:
                cached.extra_headers.setdefault("Docker-Content-Digest", digest)
                cached.extra_headers["Accept-Ranges"] = "bytes"
                if method == "HEAD":
                    return await send(request, cached, _empty())
                return await proxy(request, self.cache, key, "GET", url, {}, cacheable=True)

        accept = request.headers.get("Accept", "*/*")
        headers = await self._authorized_headers(url, accept)

        # blob GET (uncached): fetch from upstream in Range chunks so a slow
        # network can't keep one connection open past the upstream's cut window.
        if method == "GET" and is_blob:
            async def _reauth():
                # the token expired mid-fetch (a multi-GB layer on a slow link
                # can outlive it) — drop the cached one and resolve a fresh token
                self.tokens.invalidate()
                return await self._authorized_headers(url, accept)
            filler = ranged_upstream_filler(url, headers, reauth=_reauth)
            # the blob's content address IS its sha256 — verify the filled bytes
            # against it so a truncated/corrupt fetch is never committed to cache
            vfy = digest.split(":", 1)[1] if digest.startswith("sha256:") else None
            rng = parse_range(request)
            if rng:
                meta, chunks = await self.cache.stream_range(
                    key, rng[0], rng[1], filler, cacheable=True, verify=vfy)
            else:
                meta, chunks = await self.cache.stream(key, filler, cacheable=True, verify=vfy)
            return await send(request, meta, chunks)
        if "Range" in request.headers:
            headers["Range"] = request.headers["Range"]
        filler = upstream_filler(method, url, headers)
        meta, chunks = await self.cache.stream("", filler, cacheable=False)
        meta.extra_headers.setdefault("Docker-Content-Digest", digest)
        return await send(request, meta, chunks)
