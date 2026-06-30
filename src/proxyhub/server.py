"""aiohttp app: routes requests to the right proxy by Host header.

Host scheme (domain = proxies.live by default):
    hub.docker.<domain>     -> docker registry mirror "hub"
    github.<domain>         -> github proxy
    cache.<domain>          -> generic url-prefix cache
    apt.<domain>            -> apt mirror (hostname-in-path)
    conda.<domain> ...      -> web mirror
Endpoints: /healthz, /status (json metrics).
"""
from __future__ import annotations

import logging
import time
from collections import Counter

from aiohttp import web

from . import upstream
from .cache import DiskCache
from .config import Config
from .proxies.apt import AptProxy
from .proxies.docker import DockerProxy
from .proxies.github import GitHubProxy
from .proxies.pypi import PyPIProxy
from .proxies.webcache import GenericCacheProxy, WebCacheProxy

log = logging.getLogger("proxyhub")


def build_app(cfg: Config) -> web.Application:
    cache = DiskCache(cfg.cache_dir, cfg.cache_max_bytes,
                      protect_window=cfg.cache_protect_window,
                      low_water_ratio=cfg.cache_low_water,
                      pin_patterns=cfg.cache_pin)
    routes: dict[str, object] = {}
    reqs: Counter = Counter()
    started = time.time()

    for name, reg in cfg.docker.items():
        routes[f"{name}.docker.{cfg.domain}"] = DockerProxy(reg, cache)
    for name, mir in cfg.web.items():
        routes[f"{name}.{cfg.domain}"] = WebCacheProxy(mir, cache)
    if cfg.github.enabled:
        routes[f"github.{cfg.domain}"] = GitHubProxy(cfg.github, cache)
    if cfg.apt.enabled:
        routes[f"apt.{cfg.domain}"] = AptProxy(cfg.apt, cache)
    if cfg.pypi.enabled:
        routes[f"pypi.{cfg.domain}"] = PyPIProxy(cache)
    routes[f"cache.{cfg.domain}"] = GenericCacheProxy(cache)

    async def dispatch(request: web.Request) -> web.StreamResponse:
        if request.path == "/healthz":
            return web.json_response({"ok": True, "routes": sorted(routes)})
        if request.path == "/status":
            return web.json_response({
                "uptime": int(time.time() - started),
                "routes": sorted(routes),
                "requests_total": sum(reqs.values()),
                "requests_by_host": dict(reqs),
                "cache": cache.stats(),
            })
        host = request.host.split(":")[0]
        proxy = routes.get(host)
        if proxy is None:
            return web.Response(status=404, text=f"no route for host: {host}\n")
        reqs[host] += 1
        try:
            return await proxy.handle(request)
        except Exception as e:  # noqa: BLE001
            log.exception("proxy error")
            return web.Response(status=502, text=f"upstream error: {e}\n")

    app = web.Application(client_max_size=0)
    app.router.add_route("*", "/{tail:.*}", dispatch)
    app.on_cleanup.append(lambda _app: upstream.close())
    app["routes"] = routes
    return app


def run(cfg: Config):
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    app = build_app(cfg)
    log.info("proxyhub on %s:%s (domain=%s)", cfg.host, cfg.port, cfg.domain)
    log.info("routes: %s", ", ".join(sorted(app["routes"])))
    web.run_app(app, host=cfg.host, port=cfg.port, access_log=None)
