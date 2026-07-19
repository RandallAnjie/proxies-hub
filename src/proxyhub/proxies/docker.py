"""Docker Registry v2 pull-through proxy.

Implements just enough of the distribution protocol to be a caching mirror:
  * resolves upstream bearer tokens from the ``WWW-Authenticate`` challenge,
    using configured credentials (a PAT for private ghcr, etc.). The challenge
    (realm/service) is cached per registry and the scope derived from the repo
    path, so the 401 probe happens once per process — not once per request;
  * manifests: a by-digest reference is immutable (cached forever, deduped
    across sources); a by-tag reference is revalidated with ``If-None-Match``;
  * caches immutable blobs (``/blobs/sha256:...``) with the decoupled buffer,
    fetched in Range chunks and verified against their digest.
"""
from __future__ import annotations

import base64
import hashlib
import re
import time
from typing import Optional

from aiohttp import web

from ..cache import DiskCache
from ..config import DockerRegistry
from ..upstream import session
from .base import full_accept, parse_range, ranged_upstream_filler, send, upstream_filler

_BLOB = re.compile(r"^/v2/(.+)/blobs/(sha256:[0-9a-f]{64})$")
_MANIFEST = re.compile(r"^/v2/(.+)/manifests/(.+)$")
# any other repo-scoped endpoint (referrers, tags/list, ...) — the repo must be
# extracted so the upstream token carries the RIGHT scope; a stale scope from
# the cached challenge gets 401 insufficient_scope, and containerd then chases
# auth.docker.io itself with the mirror's basic-auth -> 400, pull fails
_REPO_ANY = re.compile(r"^/v2/(.+?)/(?:referrers|tags|_catalog)(?:/|$)")
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
        # WWW-Authenticate challenge, learned once per registry:
        #   None = unknown yet, "" = anonymous registry, else the Bearer challenge
        self._challenge: Optional[str] = None

    async def _auth_header(self, challenge: str, scope: Optional[str]) -> dict:
        """Turn a Bearer challenge into an Authorization header by fetching a
        token. ``scope`` (derived from the requested repo) overrides the scope
        embedded in the cached challenge (which belongs to the probed repo)."""
        parts = dict(_BEARER.findall(challenge))
        realm = parts.get("realm", "")
        scope = scope or parts.get("scope", "")
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
                # realm rejected us — maybe the cached challenge is stale
                self._challenge = None
                return {}
            data = await r.json(content_type=None)
        tok = data.get("token") or data.get("access_token") or ""
        if tok:
            self.tokens.put(scope, tok)
            return {"Authorization": f"Bearer {tok}"}
        return {}

    async def _authorized_headers(self, url: str, accept: str,
                                  repo: Optional[str] = None) -> dict:
        """Auth headers for ``url``. The challenge is cached per registry, so
        after the first request this costs no probe (and, within the token TTL,
        no upstream call at all)."""
        headers = {"Accept": accept, "User-Agent": "proxyhub-docker"}
        chal = self._challenge
        if chal is None:
            async with session().head(url, headers=headers, allow_redirects=False) as r:
                if r.status != 401:
                    self._challenge = ""          # anonymous registry
                    return headers
                chal = r.headers.get("WWW-Authenticate", "")
                self._challenge = chal
        if chal and chal.lower().startswith("bearer"):
            scope = f"repository:{repo}:pull" if repo else None
            headers.update(await self._auth_header(chal, scope))
        return headers

    async def _handle_manifest(self, request, url, path, method, accept,
                               repo, reference):
        # by-digest: content-addressed -> cache forever, keyed by digest (shared
        # across repos/registries). docker re-verifies the digest itself.
        if reference.startswith("sha256:"):
            mkey = f"docker:manifest:{reference}"
            if method == "HEAD":
                cached = self.cache.lookup(mkey)
                if cached is not None:
                    cached.extra_headers.setdefault("Docker-Content-Digest", reference)
                    return await send(request, cached, _empty())
                headers = await self._authorized_headers(url, accept, repo)
                meta, chunks = await self.cache.stream(
                    "", upstream_filler("HEAD", url, headers), cacheable=False)
                meta.extra_headers.setdefault("Docker-Content-Digest", reference)
                return await send(request, meta, chunks)
            headers = await self._authorized_headers(url, accept, repo)
            meta, chunks = await self.cache.stream(
                mkey, upstream_filler("GET", url, headers), cacheable=True)
            meta.extra_headers.setdefault("Docker-Content-Digest", reference)
            return await send(request, meta, chunks)

        # by-tag: mutable. HEAD passes through; GET caches + revalidates. The
        # served body depends on Accept, so the cache key includes it.
        headers = await self._authorized_headers(url, accept, repo)
        if method == "HEAD":
            meta, chunks = await self.cache.stream(
                "", upstream_filler("HEAD", url, headers), cacheable=False)
            return await send(request, meta, chunks)
        ahash = hashlib.sha1(accept.encode()).hexdigest()[:8]
        tkey = f"docker:mtag:{self.reg.name}:{path}:{ahash}"
        cached = self.cache.peek(tkey)
        if cached is not None:
            et = cached.extra_headers.get("ETag") or cached.extra_headers.get("Etag")
            if not et:
                dcd = cached.extra_headers.get("Docker-Content-Digest")
                et = f'"{dcd}"' if dcd else None
            if et:
                cond = dict(headers, **{"If-None-Match": et})
                meta, chunks = await self.cache.stream_revalidate(
                    tkey, upstream_filler("GET", url, cond), cached)
                return await send(request, meta, chunks)
        meta, chunks = await self.cache.stream(
            tkey, upstream_filler("GET", url, headers), cacheable=True)
        return await send(request, meta, chunks)

    async def handle(self, request: web.Request) -> web.StreamResponse:
        path = request.path  # e.g. /v2/library/nginx/manifests/latest
        # /v2/ ping: answer locally (this proxy fronts auth; clients auth to us
        # via the reverse proxy's basic-auth, we handle the upstream token flow).
        if path in ("/v2", "/v2/"):
            return web.Response(status=200, headers={
                "Docker-Distribution-Api-Version": "registry/2.0", "X-Proxyhub": "1"})
        url = self.reg.upstream.rstrip("/") + path
        method = request.method
        accept = full_accept(request)

        m_blob = _BLOB.match(path)
        if m_blob:
            repo, digest = m_blob.group(1), m_blob.group(2)
            # blobs are content-addressed by their sha256 — key by digest ALONE
            # so a layer shared across repos/registries is stored once
            key = f"docker:blob:{digest}"
            if method == "HEAD":
                cached = self.cache.lookup(key)
                if cached is not None:
                    cached.extra_headers.setdefault("Docker-Content-Digest", digest)
                    cached.extra_headers["Accept-Ranges"] = "bytes"
                    return await send(request, cached, _empty())
                headers = await self._authorized_headers(url, accept, repo)
                meta, chunks = await self.cache.stream(
                    "", upstream_filler("HEAD", url, headers), cacheable=False)
                meta.extra_headers.setdefault("Docker-Content-Digest", digest)
                return await send(request, meta, chunks)
            if method == "GET":
                # auth is resolved up front but costs nothing on a cache hit:
                # the challenge is cached per registry and tokens per scope —
                # and the filler (which carries these headers) only runs on a
                # miss. No more unauthenticated fetch on an eviction race.
                headers = await self._authorized_headers(url, accept, repo)

                async def _reauth():
                    # token expired mid-fetch (a multi-GB layer on a slow link
                    # can outlive it) — re-resolve and continue from the offset
                    self.tokens.invalidate()
                    self._challenge = None
                    return await self._authorized_headers(url, accept, repo)

                filler = ranged_upstream_filler(url, headers, reauth=_reauth)
                # the blob's content address IS its sha256 — verify the filled
                # bytes so a truncated/corrupt fetch is never committed
                vfy = digest.split(":", 1)[1]
                rng = parse_range(request)
                if rng:
                    meta, chunks = await self.cache.stream_range(
                        key, rng[0], rng[1], filler, cacheable=True, verify=vfy)
                else:
                    meta, chunks = await self.cache.stream(
                        key, filler, cacheable=True, verify=vfy)
                meta.extra_headers.setdefault("Docker-Content-Digest", digest)
                meta.extra_headers.setdefault("Accept-Ranges", "bytes")
                return await send(request, meta, chunks)

        # manifests: digest = immutable cache; tag = revalidate
        m_man = _MANIFEST.match(path)
        if m_man and method in ("GET", "HEAD"):
            return await self._handle_manifest(request, url, path, method, accept,
                                               m_man.group(1), m_man.group(2))

        # anything else (referrers, tags/list, ...): authenticated passthrough
        # with the repo-scoped token
        m_any = _REPO_ANY.match(path)
        headers = await self._authorized_headers(
            url, accept, m_any.group(1) if m_any else None)
        if "Range" in request.headers:
            headers["Range"] = request.headers["Range"]
        filler = upstream_filler(method, url, headers)
        meta, chunks = await self.cache.stream("", filler, cacheable=False)
        return await send(request, meta, chunks)
