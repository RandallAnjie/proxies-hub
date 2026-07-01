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

import asyncio
import logging
import time
from collections import Counter, deque
from pathlib import Path

from aiohttp import web

_STATIC = Path(__file__).parent / "static"


def _render_dashboard(cfg) -> str:
    """Load the bundled dashboard template and substitute branding placeholders
    so a single image serves any domain — set PROXYHUB_DOMAIN/FOOTER/BRAND."""
    try:
        html = (_STATIC / "dashboard.html").read_text(encoding="utf-8")
    except FileNotFoundError:
        return ("<!doctype html><meta charset=utf-8><title>proxyhub</title>"
                "<h1>proxyhub</h1><p>dashboard template not found</p>")
    domain = cfg.domain
    if "." in domain:
        head, _, tail = domain.partition(".")
        brand_html = f'{head}<span class="dot">.</span>{tail}'
    else:
        brand_html = domain
    # footer is FIXED (never configurable): project link + Powered By Randall
    left = ('<a class="dom" href="https://github.com/RandallAnjie/proxies-hub" '
            'target="_blank" rel="noopener">github.com/RandallAnjie/proxies-hub</a>')
    right = 'Powered By <span class="blink">Randall</span>'
    return (html
            .replace("__BRAND_HTML__", brand_html)
            .replace("__FOOTERR__", right)   # before __FOOTER__ (prefix collision)
            .replace("__FOOTER__", left)
            .replace("__DOMAIN__", domain))

from . import upstream
from .cache import DiskCache
from .config import Config
from .proxies.apt import AptProxy
from .proxies.docker import DockerProxy
from .proxies.github import GitHubProxy
from .proxies.pypi import PyPIProxy
from .proxies.webcache import GenericCacheProxy, WebCacheProxy

log = logging.getLogger("proxyhub")


class HourlyHitRate:
    """Hit-rate series bucketed into 1-hour units for the dashboard chart.

    Each completed hour stores its own hit rate — hits / (hits + misses) over
    just that hour, computed from the cumulative counters at the hour's start
    and end. An hour with **no requests** carries the previous hour's value
    forward (a flat line) instead of dropping out. A 60s background tick keeps
    buckets advancing even while nobody is watching the dashboard.
    """

    def __init__(self, cache, hours: int = 24):
        self._cache = cache
        self._points: deque = deque(maxlen=hours)   # {hour, rate, reqs}
        self._hour: int | None = None
        self._start = (0, 0)                         # (hits, misses) at hour start

    def _rate(self, dh: int, dm: int):
        tot = dh + dm
        if tot > 0:
            return round(dh / tot * 100, 1)
        return self._points[-1]["rate"] if self._points else None   # carry forward

    def tick(self, now: float):
        h = int(now // 3600)
        hits, misses = self._cache.hits, self._cache.misses
        if self._hour is None:
            self._hour, self._start = h, (hits, misses)
            return
        while h > self._hour:                        # close out each elapsed hour
            self._points.append({
                "hour": self._hour,
                "rate": self._rate(hits - self._start[0], misses - self._start[1]),
                "reqs": (hits - self._start[0]) + (misses - self._start[1]),
            })
            self._hour += 1
            self._start = (hits, misses)

    def series(self, now: float) -> list:
        self.tick(now)
        out = list(self._points)
        hits, misses = self._cache.hits, self._cache.misses
        dh, dm = hits - self._start[0], misses - self._start[1]
        out.append({"hour": self._hour, "rate": self._rate(dh, dm),
                    "reqs": dh + dm, "current": True})
        return out


class RollingHitRate:
    """Hit rate over a trailing window (default 10 min) — a live 'how is it doing
    right now' number. The since-boot cumulative rate goes stale and stops
    reacting once enough requests have accrued; this doesn't."""

    def __init__(self, cache, window: int = 600):
        self._cache = cache
        self._window = window
        self._samples: deque = deque()          # (t, hits, misses), ascending

    def sample(self, now: float):
        self._samples.append((now, self._cache.hits, self._cache.misses))
        cutoff = now - self._window
        # keep the newest sample at/older than the window edge as the baseline
        while len(self._samples) > 1 and self._samples[1][0] <= cutoff:
            self._samples.popleft()

    def rate(self, now: float):
        self.sample(now)
        _, h0, m0 = self._samples[0]
        dh = self._cache.hits - h0
        dm = self._cache.misses - m0
        tot = dh + dm
        return round(dh / tot * 100, 1) if tot > 0 else None


def build_app(cfg: Config) -> web.Application:
    cache = DiskCache(cfg.cache_dir, cfg.cache_max_bytes,
                      protect_window=cfg.cache_protect_window,
                      low_water_ratio=cfg.cache_low_water,
                      pin_patterns=cfg.cache_pin)
    routes: dict[str, object] = {}
    reqs: Counter = Counter()
    started = time.time()
    hourly = HourlyHitRate(cache, hours=24)   # per-hour hit-rate for the chart
    rolling = RollingHitRate(cache, window=600)   # trailing 10-min hit rate

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
    dashboard_html = _render_dashboard(cfg)
    dash_host = f"dash.{cfg.domain}"

    async def dispatch(request: web.Request) -> web.StreamResponse:
        if request.path == "/healthz":
            return web.json_response({"ok": True, "routes": sorted(routes)})
        if request.path in ("/status", "/phstatus"):
            now = time.time()
            return web.json_response({
                "uptime": int(now - started),
                "routes": sorted(routes),
                "requests_total": sum(reqs.values()),
                "requests_by_host": dict(reqs),
                "cache": cache.stats(),
                "hit_rate_10m": rolling.rate(now),
                "cache_breakdown": cache.breakdown(),
                "history": hourly.series(now),
            })
        host = request.host.split(":")[0]
        proxy = routes.get(host)
        if proxy is None:
            # serve the dashboard at the dash host, or at "/" of any unknown host
            # (so a bare `docker run -p 8080:8080` lands on a working page)
            if host == dash_host or request.path == "/":
                return web.Response(text=dashboard_html, content_type="text/html")
            return web.Response(status=404, text=f"no route for host: {host}\n")
        reqs[host] += 1
        try:
            return await proxy.handle(request)
        except Exception as e:  # noqa: BLE001
            log.exception("proxy error")
            return web.Response(status=502, text=f"upstream error: {e}\n")

    async def _ticker():
        while True:
            await asyncio.sleep(60)
            now = time.time()
            hourly.tick(now)
            rolling.sample(now)

    async def _start_bg(app):
        app["_ticker"] = asyncio.create_task(_ticker())

    async def _stop_bg(app):
        t = app.get("_ticker")
        if t:
            t.cancel()

    app = web.Application(client_max_size=0)
    app.router.add_route("*", "/{tail:.*}", dispatch)
    app.on_startup.append(_start_bg)
    app.on_cleanup.append(_stop_bg)
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
