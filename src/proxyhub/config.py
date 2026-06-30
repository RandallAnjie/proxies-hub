"""Configuration loading. YAML-driven so new mirrors are added without code."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


def _bytes(v: Any) -> int:
    if isinstance(v, int):
        return v
    s = str(v).strip().lower()
    mult = 1
    for suf, m in (("g", 1024**3), ("m", 1024**2), ("k", 1024)):
        if s.endswith(suf):
            mult = m
            s = s[:-1]
            break
    return int(float(s) * mult)


@dataclass
class DockerRegistry:
    name: str
    upstream: str            # e.g. https://registry-1.docker.io
    username: str = ""
    password: str = ""       # PAT for private (ghcr etc.)
    manifest_ttl: int = 60   # seconds; manifests revalidate this often


@dataclass
class WebMirror:
    name: str
    upstream: str            # e.g. https://conda.anaconda.org
    # request-uri regexes that should NOT be cached (kept fresh)
    no_cache: list[str] = field(default_factory=list)


@dataclass
class GitHubCfg:
    enabled: bool = True
    # token aliases: a client ?token=<alias> is swapped for the real value
    token_aliases: dict[str, str] = field(default_factory=dict)


@dataclass
class AptCfg:
    enabled: bool = False
    scheme: str = "https"   # scheme used to reach the upstream apt host


@dataclass
class PyPICfg:
    enabled: bool = False


@dataclass
class Config:
    host: str = "0.0.0.0"
    port: int = 8080
    cache_dir: str = "/var/cache/proxyhub"
    cache_max_bytes: int = 100 * 1024**3
    # host suffix the proxy serves under, used to route by Host header
    domain: str = "proxies.live"
    docker: dict[str, DockerRegistry] = field(default_factory=dict)
    web: dict[str, WebMirror] = field(default_factory=dict)
    github: GitHubCfg = field(default_factory=GitHubCfg)
    apt: AptCfg = field(default_factory=AptCfg)
    pypi: PyPICfg = field(default_factory=PyPICfg)

    @classmethod
    def load(cls, path: str) -> "Config":
        raw = yaml.safe_load(Path(path).read_text()) or {}
        c = cls()
        c.host = raw.get("host", c.host)
        c.port = int(raw.get("port", c.port))
        c.domain = raw.get("domain", c.domain)
        cache = raw.get("cache", {})
        c.cache_dir = cache.get("dir", c.cache_dir)
        c.cache_max_bytes = _bytes(cache.get("max_size", c.cache_max_bytes))
        for name, d in (raw.get("docker") or {}).items():
            c.docker[name] = DockerRegistry(
                name=name, upstream=d["upstream"],
                username=_env(d.get("username", "")),
                password=_env(d.get("password", "")),
                manifest_ttl=int(d.get("manifest_ttl", 60)),
            )
        for name, w in (raw.get("web") or {}).items():
            c.web[name] = WebMirror(
                name=name, upstream=w["upstream"],
                no_cache=list(w.get("no_cache", [])),
            )
        gh = raw.get("github") or {}
        c.github = GitHubCfg(
            enabled=gh.get("enabled", True),
            token_aliases={k: _env(v) for k, v in (gh.get("token_aliases") or {}).items()},
        )
        ap = raw.get("apt") or {}
        c.apt = AptCfg(enabled=ap.get("enabled", False), scheme=ap.get("scheme", "https"))
        c.pypi = PyPICfg(enabled=(raw.get("pypi") or {}).get("enabled", False))
        return c


def _env(v: str) -> str:
    """Allow ${ENV_VAR} interpolation so secrets stay out of the file."""
    if isinstance(v, str) and v.startswith("${") and v.endswith("}"):
        return os.environ.get(v[2:-1], "")
    return v
