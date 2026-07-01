"""Single entrypoint dispatched by path — ``all.<domain>``.

Two shapes, told apart by the ``/v2/`` prefix docker always uses:

    /v2/<registry>/<repo>...   -> docker registry <registry>   (public sources)
    /<service>/<rest>          -> that service (npm, pypi, github, conda, ...)

The docker form is what ``docker pull all.<domain>/hub/library/nginx`` naturally
produces (docker puts ``hub`` right after ``/v2/``). Everything else is a base
URL a client appends to, so a ``/<service>`` prefix is transparent.

Private docker sources (those with stored credentials) are NOT exposed here —
they stay on their own basic-auth'd subdomain — so this host can be open.
"""
from __future__ import annotations

from aiohttp import web
from yarl import URL


class AllProxy:
    def __init__(self, services: dict, dockers: dict):
        self.services = services      # service name -> proxy
        self.dockers = dockers        # public registry name -> DockerProxy

    def _clone(self, request, target_path, prefix=None):
        rel = target_path
        if request.query_string:
            rel += "?" + request.query_string
        new = request.clone(rel_url=URL(rel, encoded=True))
        if prefix is not None:
            new["prefix"] = prefix
        return new

    async def handle(self, request: web.Request) -> web.StreamResponse:
        path = request.path
        if path in ("/v2", "/v2/"):
            return web.Response(status=200, headers={
                "Docker-Distribution-Api-Version": "registry/2.0", "X-Proxyhub": "1"})
        if path.startswith("/v2/"):
            seg, _, tail = path[4:].partition("/")
            dp = self.dockers.get(seg)
            if dp is None:
                return web.Response(status=404,
                                    text=f"unknown or non-public docker source: {seg}\n")
            return await dp.handle(self._clone(request, "/v2/" + tail))
        seg, _, tail = path.lstrip("/").partition("/")
        sp = self.services.get(seg)
        if sp is None:
            return web.Response(status=404, text=self._help())
        return await sp.handle(self._clone(request, "/" + tail, prefix="/" + seg))

    def _help(self) -> str:
        return ("proxyhub — all-in-one entrypoint\n\n"
                "  docker : /v2/<registry>/<repo>   (public: "
                + ", ".join(sorted(self.dockers)) + ")\n"
                "  others : /<service>/<path>       ("
                + ", ".join(sorted(self.services)) + ")\n")
