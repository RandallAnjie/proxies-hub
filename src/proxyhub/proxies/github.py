"""GitHub proxy covering every connection type:

  * ``git clone`` smart-HTTP  (GET …/info/refs, POST …/git-upload-pack)
  * raw / gist content
  * source archives (…/archive/…, codeload tarball/zipball — via redirect)
  * release assets — public (direct) and **private** (API-asset translation)
  * api.github.com
  * signed CDN hosts (objects / release-assets.githubusercontent.com)

Auth: ``?token=<alias|pat>`` becomes ``Authorization: token …``; if absent, a
client-supplied ``Authorization`` header (e.g. basic-auth PAT for private
clone) is forwarded unchanged.
"""
from __future__ import annotations

import re
from urllib.parse import unquote, urlencode

from aiohttp import web

from ..cache import DiskCache
from ..config import GitHubCfg
from .base import fetch_json, send, upstream_filler

API = "https://api.github.com"
ALLOWED_HOSTS = {
    "github.com", "raw.githubusercontent.com", "gist.githubusercontent.com",
    "gist.github.com", "api.github.com", "codeload.github.com",
    "objects.githubusercontent.com", "release-assets.githubusercontent.com",
    "user-images.githubusercontent.com", "avatars.githubusercontent.com",
    "media.githubusercontent.com",
}
_URL = re.compile(r"^/+(https?):/+(.+)$")
_RELDL = re.compile(r"^github\.com/([^/]+)/([^/]+)/releases/download/([^/]+)/([^/?]+)")
_FWD = ("accept", "content-type", "range", "if-none-match", "if-modified-since",
        "git-protocol", "user-agent")


class GitHubProxy:
    def __init__(self, cfg: GitHubCfg, cache: DiskCache):
        self.cfg = cfg
        self.cache = cache

    def _auth(self, request: web.Request) -> str | None:
        tok = request.query.get("token")
        if tok:
            real = self.cfg.token_aliases.get(tok, tok)
            return f"token {real}"
        if "Authorization" in request.headers:   # forwarded (e.g. private clone)
            return request.headers["Authorization"]
        return None

    def _fwd_headers(self, request: web.Request, auth: str | None) -> dict:
        h = {k: request.headers[k] for k in request.headers if k.lower() in _FWD}
        h.setdefault("User-Agent", "proxyhub-gh")
        if auth:
            h["Authorization"] = auth
        return h

    async def handle(self, request: web.Request) -> web.StreamResponse:
        path = request.raw_path.split("?", 1)[0]
        m = _URL.match(path)
        if m:                                   # /https://github.com/...
            scheme, rest = m.group(1), m.group(2)
        else:                                   # scheme-less: /github.com/...
            scheme, rest = "https", path.lstrip("/")
        host = rest.split("/", 1)[0]
        if host not in ALLOWED_HOSTS:
            return web.Response(status=403, text=f"host not allowed: {host}\n")

        auth = self._auth(request)

        rel = _RELDL.match(rest)
        if rel and request.method in ("GET", "HEAD"):
            return await self._release(request, *rel.groups(), auth)

        # forward query minus our ?token=
        q = {k: v for k, v in request.query.items() if k != "token"}
        target = f"{scheme}://{rest}"
        if q:
            target += "?" + urlencode(q)

        body = None
        if request.method in ("POST", "PUT", "PATCH"):
            body = await request.read()
        headers = self._fwd_headers(request, auth)
        filler = upstream_filler(request.method, target, headers, body=body)
        meta, chunks = await self.cache.stream("", filler, cacheable=False)
        return await send(request, meta, chunks)

    async def _release(self, request, owner, repo, tag, asset, auth):
        """Resolve a private/public release asset via the API and stream it."""
        asset = unquote(asset)
        base = {"User-Agent": "proxyhub-gh"}
        if auth:
            base["Authorization"] = auth

        st, rel = await fetch_json(
            f"{API}/repos/{owner}/{repo}/releases/tags/{tag}",
            {**base, "Accept": "application/vnd.github+json"})
        if st != 200 or not isinstance(rel, dict):
            return web.Response(status=st if st and st >= 400 else 502,
                                text=f"release lookup failed ({st})\n")
        aid = next((a["id"] for a in rel.get("assets", []) if a["name"] == asset), None)
        if aid is None:
            return web.Response(status=404, text=f"asset not found: {asset}\n")

        # the asset endpoint 302s to a signed URL; the filler follows it and
        # drops Authorization on the cross-host hop.
        url = f"{API}/repos/{owner}/{repo}/releases/assets/{aid}"
        headers = {**base, "Accept": "application/octet-stream"}
        filler = upstream_filler(request.method, url, headers)
        meta, chunks = await self.cache.stream("", filler, cacheable=False)
        meta.extra_headers["Content-Disposition"] = f'attachment; filename="{asset}"'
        return await send(request, meta, chunks)
