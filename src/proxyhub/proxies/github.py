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

import base64
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

    def _auth(self, request: web.Request) -> tuple[str | None, bool]:
        """Resolve the request's auth -> (Authorization value, came_from_alias).

        An alias works in three places: ``?token=<alias>``, or as the username/
        password of HTTP Basic auth — so ``git clone https://x:<alias>@…`` works
        without anyone holding the real PAT. Alias-derived auth is READ-ONLY
        (enforced in handle()): a shared word must not carry push rights."""
        tok = request.query.get("token")
        if tok:
            real = self.cfg.token_aliases.get(tok)
            return self._basic(real or tok), real is not None
        hdr = request.headers.get("Authorization")
        if not hdr:
            return None, False
        if hdr.lower().startswith("basic "):
            try:
                user, _, pwd = base64.b64decode(hdr[6:]).decode().partition(":")
            except Exception:
                return hdr, False
            real = self.cfg.token_aliases.get(pwd) or self.cfg.token_aliases.get(user)
            if real:
                return self._basic(real), True
        return hdr, False

    @staticmethod
    def _basic(pat: str) -> str:
        # Basic works on BOTH github.com's git smart-http endpoints (which do
        # NOT accept the 'token' scheme) and api.github.com
        return "Basic " + base64.b64encode(f"x-access-token:{pat}".encode()).decode()

    def _fwd_headers(self, request: web.Request, auth: str | None) -> dict:
        h = {k: ",".join(request.headers.getall(k)) for k in request.headers
             if k.lower() in _FWD}
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

        auth, from_alias = self._auth(request)

        # token aliases are for DISTRIBUTION (clone/pull/downloads). Anyone who
        # knows the shared word must not be able to write: block push (both the
        # receive-pack advertisement and the upload itself) unless a real PAT.
        if from_alias and (rest.endswith("/git-receive-pack")
                           or request.query.get("service") == "git-receive-pack"):
            return web.Response(
                status=403,
                text="token aliases are read-only; push with a real PAT\n")

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
        if meta.status == 401:
            # upstream WWW-Authenticate is stripped globally (see base._HOP);
            # git/libcurl won't retry a 401 with credentials unless a challenge
            # names the scheme — issue OUR OWN Basic challenge so private
            # clone/push prompts (or URL-embedded credentials) work
            meta.extra_headers["WWW-Authenticate"] = 'Basic realm="proxyhub-github"'
        return await send(request, meta, chunks)

    async def _release(self, request, owner, repo, tag, asset, auth):
        """Resolve a private/public release asset via the API and stream it.

        The API lookup runs fresh on EVERY request with the client's own auth —
        that is the authorization check. The asset body, however, is cached
        under ``id:updated_at`` (which changes whenever the asset is
        re-uploaded), so a 250 MB artifact fetched by a fleet of machines hits
        the disk instead of GitHub each time — and can never be served stale."""
        asset = unquote(asset)
        base = {"User-Agent": "proxyhub-gh"}
        if auth:
            base["Authorization"] = auth
        accept_json = {**base, "Accept": "application/vnd.github+json"}

        st, rel = await fetch_json(
            f"{API}/repos/{owner}/{repo}/releases/tags/{tag}", accept_json)
        if (st != 200 or not isinstance(rel, dict)) and tag == "latest":
            # no literal "latest" tag — fall back to the semantic latest release
            st, rel = await fetch_json(
                f"{API}/repos/{owner}/{repo}/releases/latest", accept_json)
        if st != 200 or not isinstance(rel, dict):
            return web.Response(status=st if st and st >= 400 else 502,
                                text=f"release lookup failed ({st})\n")
        a = next((a for a in rel.get("assets", []) if a["name"] == asset), None)
        if a is None:
            return web.Response(status=404, text=f"asset not found: {asset}\n")

        # the asset endpoint 302s to a signed URL; the filler follows it and
        # drops Authorization on the cross-host hop.
        url = f"{API}/repos/{owner}/{repo}/releases/assets/{a['id']}"
        headers = {**base, "Accept": "application/octet-stream"}
        key = f"gh:asset:{a['id']}:{a.get('updated_at', '')}"
        filler = upstream_filler(request.method, url, headers)
        if request.method == "HEAD":
            meta, chunks = await self.cache.stream("", filler, cacheable=False)
        else:
            meta, chunks = await self.cache.stream(key, filler, cacheable=True)
        meta.extra_headers["Content-Disposition"] = f'attachment; filename="{asset}"'
        return await send(request, meta, chunks)
