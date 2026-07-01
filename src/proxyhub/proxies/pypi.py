"""PyPI proxy: rewrites the PEP 503/691 simple index so file links point back
here, then caches the package files (which live on a second host,
files.pythonhosted.org). This is what a plain reverse proxy can't do.

    pip config set global.index-url https://pypi.<domain>/index/

  /index/<pkg>/   -> pypi.org/simple/<pkg>/  (links rewritten, fresh)
  /files/<path>   -> files.pythonhosted.org/<path>  (cached, immutable)
"""
from __future__ import annotations

from aiohttp import web

from ..cache import DiskCache
from ..upstream import session
from .base import proxy

SIMPLE = "https://pypi.org/simple"
FILES = "https://files.pythonhosted.org"


class PyPIProxy:
    def __init__(self, cache: DiskCache):
        self.cache = cache

    async def handle(self, request: web.Request) -> web.StreamResponse:
        path = request.raw_path.split("?", 1)[0]

        # cached package files
        if path.startswith("/files/"):
            rest = path[len("/files/"):]
            url = f"{FILES}/{rest}"
            if request.query_string:
                url += "?" + request.query_string
            key = f"pypi:files:{rest}"
            return await proxy(request, self.cache, key, request.method, url,
                               {"User-Agent": "proxyhub-pypi"}, cacheable=True)

        # simple index: strip /index or /simple prefix -> simple sub-path
        sub = path
        for pfx in ("/index", "/simple"):
            if sub == pfx or sub.startswith(pfx + "/"):
                sub = sub[len(pfx):] or "/"
                break
        if not sub.startswith("/"):
            sub = "/" + sub
        url = f"{SIMPLE}{sub}"
        accept = request.headers.get("Accept", "text/html")
        hdrs = {"Accept": accept, "User-Agent": "proxyhub-pypi"}
        async with session().get(url, headers=hdrs) as r:
            status = r.status
            body = await r.read()
            ctype = r.headers.get("Content-Type", "text/html")
        # rewrite the file host (works for both HTML and JSON simple responses)
        text = body.decode("utf-8", "replace").replace(
            "https://files.pythonhosted.org/", f"https://{request.host}/files/")
        return web.Response(status=status, body=text.encode(),
                            headers={"Content-Type": ctype, "X-Proxyhub": "1"})
