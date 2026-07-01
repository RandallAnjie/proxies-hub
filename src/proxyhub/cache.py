"""Disk cache: decoupled full-speed buffering + persistent LRU index + Range.

* Decoupled buffering: one background task downloads at server speed into a
  ``.part`` file while any number of clients stream from the growing file.
* Persistent LRU index: ``.index.json`` tracks {digest: size, atime}; eviction
  pops the least-recently-used entry instead of walking the whole tree.
* Range: cached objects serve byte ranges (206); a ranged miss still fills the
  full object (caching it) and serves the requested slice from the growing file.
* Metrics: hits / misses / bytes for the /status endpoint.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncIterator, Callable, Optional

CHUNK = 256 * 1024
log = logging.getLogger("proxyhub.cache")


class IntegrityError(Exception):
    """A filled object failed its expected-digest check; it is not cached."""


@dataclass
class CacheMeta:
    key: str
    size: int                       # body length of THIS response
    content_type: str
    status: int = 200
    total: int = -1                 # full object size (upstream Content-Length)
    extra_headers: dict = field(default_factory=dict)


Filler = Callable[[], AsyncIterator[tuple[Optional[CacheMeta], bytes]]]


class _Download:
    def __init__(self, part_path: Path):
        self.part_path = part_path
        self.meta: Optional[CacheMeta] = None
        self.done = False
        self.error: Optional[BaseException] = None
        self.size = 0
        self._event = asyncio.Event()

    def notify(self):
        self._event.set()

    async def wait(self):
        # Timeout makes this self-heal against a missed wakeup (a notify that
        # fires between a reader's state-check and its await): the reader re-checks
        # dl.size every 0.1s at worst. Clear-after-wait keeps it edge-triggered.
        try:
            await asyncio.wait_for(self._event.wait(), 0.1)
        except asyncio.TimeoutError:
            pass
        self._event.clear()


class DiskCache:
    def __init__(self, root: str, max_bytes: int, protect_window: int = 600,
                 low_water_ratio: float = 0.92, pin_patterns: Optional[list] = None):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.max_bytes = max_bytes
        # evict down to this low-water mark (not just to the cap) to avoid
        # thrashing right at the boundary
        self.low_water = int(max_bytes * low_water_ratio)
        # entries touched within this many seconds are evicted only as a last
        # resort, so a burst of small files can't push out a hot large layer
        self.protect_window = protect_window
        # keys matching any of these are never evicted (e.g. base images)
        self._pins = [re.compile(p) for p in (pin_patterns or [])]
        self.verify_failures = 0
        self.revalidations = 0
        self._inflight: dict[str, _Download] = {}
        self._lock = asyncio.Lock()
        # metrics
        self.hits = 0
        self.misses = 0
        self.bytes_served = 0
        self.started = time.time()
        # persistent LRU index: digest -> {"key","size","atime"}
        self._index: dict[str, dict] = {}
        self._total = 0
        self._index_path = self.root / ".index.json"
        self._dirty = 0
        self._cleanup_partials()
        self._load_index()

    def _cleanup_partials(self):
        """At startup no fill is in flight, so any leftover ``.part``/``.rv`` is an
        abandoned partial from a killed run. It is untracked by the index, so LRU
        would never reclaim it — delete it now to stop slow disk leakage."""
        removed = freed = 0
        for p in self.root.rglob("*"):
            if p.is_file() and p.name.endswith((".part", ".rv")):
                try:
                    freed += p.stat().st_size
                    p.unlink()
                    removed += 1
                except OSError:
                    pass
        if removed:
            log.info("cleaned %d stale partial file(s), freed %.1f MB",
                     removed, freed / 1024 / 1024)

    def sweep_partials(self, min_age: int = 600) -> int:
        """Periodic reaper for partials a *still-running* process can accumulate
        (e.g. a revalidation whose client vanished mid-stream). Safe while fills
        are active: skips any file backing an in-flight fill, and only removes
        ones untouched for ``min_age`` seconds — an active fill refreshes its
        ``.part`` mtime on every chunk, so a slow-but-live fetch is never hit."""
        active = {str(dl.part_path) for dl in self._inflight.values()}
        now = time.time()
        removed = freed = 0
        for p in self.root.rglob("*"):
            if not (p.is_file() and p.name.endswith((".part", ".rv"))):
                continue
            if str(p) in active:
                continue
            try:
                st = p.stat()
                if now - st.st_mtime >= min_age:
                    freed += st.st_size
                    p.unlink()
                    removed += 1
            except OSError:
                pass
        if removed:
            log.info("swept %d abandoned partial(s), freed %.1f MB",
                     removed, freed / 1024 / 1024)
        return removed

    # ---- paths ----
    def _digest(self, key: str) -> str:
        return hashlib.sha256(key.encode()).hexdigest()

    def _paths(self, key: str):
        d = self._digest(key)
        sub = self.root / d[:2] / d[2:4]
        return sub / d, sub / (d + ".meta"), sub / (d + ".part")

    # ---- persistent index ----
    def _load_index(self):
        if self._index_path.exists():
            try:
                doc = json.loads(self._index_path.read_text())
                self._index = doc["entries"]
                self._total = int(doc["total"])
                return
            except Exception:
                pass
        self._rebuild_index()

    def _rebuild_index(self):
        self._index, self._total = {}, 0
        for p in self.root.rglob("*"):
            if p.is_file() and not p.name.endswith((".meta", ".part")) and p.name != ".index.json":
                try:
                    st = p.stat()
                except FileNotFoundError:
                    continue
                self._index[p.name] = {"key": "", "size": st.st_size, "atime": st.st_atime}
                self._total += st.st_size
        self._flush(force=True)

    def _flush(self, force=False):
        self._dirty += 1
        if not force and self._dirty < 50:
            return
        self._dirty = 0
        try:
            tmp = self._index_path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"total": self._total, "entries": self._index}))
            os.replace(tmp, self._index_path)
        except Exception:
            pass

    def _record(self, key: str, size: int):
        d = self._digest(key)
        old = self._index.get(d)
        if old:
            self._total -= old["size"]
        self._index[d] = {"key": key, "size": size, "atime": time.time()}
        self._total += size
        self._flush(force=True)   # persist new entries immediately

    def _bump(self, key: str):
        d = self._digest(key)
        e = self._index.get(d)
        if e:
            e["atime"] = time.time()
            self._flush()

    def _is_pinned(self, key: str) -> bool:
        return bool(key) and any(p.search(key) for p in self._pins)

    @staticmethod
    def _group_label(key: str) -> str:
        """Service label for a cache key — the cache is one shared pool, this
        just buckets entries by which proxy wrote them (key prefix)."""
        if not key:
            return "other"
        parts = key.split(":", 2)
        p0 = parts[0]
        if p0 == "docker" and len(parts) >= 2:
            # blobs are deduped under one digest-keyed pool shared by all sources
            return "docker/layers" if parts[1] == "blob" else "docker/" + parts[1]
        if p0 == "web" and len(parts) >= 2:
            return parts[1]
        if p0 == "gen":
            return "generic"
        return p0  # pypi, apt, …

    def breakdown(self) -> dict:
        """Per-service {files, bytes} from the in-memory index."""
        groups: dict[str, dict] = {}
        for e in self._index.values():
            g = groups.setdefault(self._group_label(e.get("key", "") or ""),
                                   {"files": 0, "bytes": 0})
            g["files"] += 1
            g["bytes"] += int(e.get("size", 0))
        return groups

    def stats(self) -> dict:
        total_req = self.hits + self.misses
        return {
            "uptime": int(time.time() - self.started),
            "hits": self.hits, "misses": self.misses,
            "hit_rate": round(self.hits / total_req * 100, 1) if total_req else 0.0,
            "bytes_served": self.bytes_served,
            "cache_bytes": self._total, "cache_max": self.max_bytes,
            "cache_files": len(self._index),
            "verify_failures": self.verify_failures,
            "revalidations": self.revalidations,
            "pins": len(self._pins),
        }

    # ---- lookup ----
    def lookup(self, key: str) -> Optional[CacheMeta]:
        data_p, meta_p, _ = self._paths(key)
        if data_p.exists() and meta_p.exists():
            try:
                m = json.loads(meta_p.read_text())
                self._bump(key)
                return CacheMeta(**m)
            except Exception:
                return None
        return None

    def peek(self, key: str) -> Optional[CacheMeta]:
        """Like lookup but without touching atime or hit/miss counters — used by
        revalidation to read a cached entry's stored validators (ETag/Date)."""
        data_p, meta_p, _ = self._paths(key)
        if data_p.exists() and meta_p.exists():
            try:
                return CacheMeta(**json.loads(meta_p.read_text()))
            except Exception:
                return None
        return None

    # ---- streaming (full) ----
    async def stream(self, key: str, filler: Filler, cacheable: bool = True,
                     verify: Optional[str] = None):
        meta = self.lookup(key)
        if meta is not None:
            self.hits += 1
            return meta, self._read_file(key, 0, meta.size - 1)
        self.misses += 1
        if not cacheable:
            return await self._passthrough(filler)
        dl = await self._begin(key, filler, verify=verify)
        await self._await_meta(dl)
        # If the upstream advertised a full length, emit it as Content-Length.
        # Docker/containerd require a known blob size; a chunked (length-less)
        # response makes it distrust the stream and reconnect/retry endlessly.
        if dl.meta.total is not None and dl.meta.total >= 0:
            dl.meta.size = dl.meta.total
        return dl.meta, self._read_inflight(key, dl, 0, None)

    # ---- streaming (range) ----
    async def stream_range(self, key: str, start: int, end: Optional[int],
                           filler: Filler, cacheable: bool = True,
                           verify: Optional[str] = None):
        """Serve bytes [start, end]. Returns (206-meta, iterator)."""
        meta = self.lookup(key)
        if meta is not None:
            self.hits += 1
            total = meta.size
            real_end = total - 1 if end is None or end >= total else end
            m = self._range_meta(meta, start, real_end, total)
            return m, self._read_file(key, start, real_end)

        self.misses += 1
        if not cacheable:
            return await self._passthrough(filler)  # let upstream handle range
        dl = await self._begin(key, filler, verify=verify)
        await self._await_meta(dl)
        total = dl.meta.total
        if total is None or total < 0:
            # unknown size: cannot form Content-Range; fall back to full stream
            return dl.meta, self._read_inflight(key, dl, 0, None)
        real_end = total - 1 if end is None or end >= total else end
        m = self._range_meta(dl.meta, start, real_end, total)
        return m, self._read_inflight(key, dl, start, real_end)

    # ---- conditional revalidation (indexes) ----
    async def stream_revalidate(self, key: str, filler: Filler,
                                cached: CacheMeta, verify: Optional[str] = None):
        """For a cached entry with validators: run a conditional upstream request
        (the ``filler`` must carry If-None-Match / If-Modified-Since). If upstream
        answers ``304`` serve the cached body; otherwise stream + re-cache the new
        body. Keeps indexes fresh without re-downloading unchanged ones."""
        self.revalidations += 1
        gen = filler()
        meta, first = await gen.__anext__()
        if meta is None:
            raise RuntimeError("filler must yield metadata first")
        if meta.status == 304:
            async for _ in gen:    # drain (no body, but release the connection)
                pass
            self.hits += 1
            self._bump(key)
            return cached, self._read_file(key, 0, cached.size - 1)

        # changed (200, or anything else) — stream to the client while writing a
        # fresh copy, then atomically replace the cached entry.
        self.misses += 1
        meta.key = key
        if meta.total is not None and meta.total >= 0:
            meta.size = meta.total
        data_p, meta_p, part_p = self._paths(key)
        rv = part_p.with_name(part_p.name + ".rv")
        rv.parent.mkdir(parents=True, exist_ok=True)

        async def body():
            h = hashlib.sha256() if verify else None
            size = 0
            try:
                with open(rv, "wb") as f:
                    if first:
                        f.write(first); size += len(first)
                        if h:
                            h.update(first)
                        self.bytes_served += len(first)
                        yield first
                    async for _, c in gen:
                        if not c:
                            continue
                        f.write(c); size += len(c)
                        if h:
                            h.update(c)
                        self.bytes_served += len(c)
                        yield c
                if h is not None and h.hexdigest() != verify:
                    self.verify_failures += 1
                    rv.unlink(missing_ok=True)
                    return
                m = CacheMeta(key=key, size=size, content_type=meta.content_type,
                              status=200, total=size, extra_headers=meta.extra_headers)
                os.replace(rv, data_p)
                meta_p.write_text(json.dumps(m.__dict__))
                self._record(key, size)
                await self._enforce_limit()
            except BaseException:
                rv.unlink(missing_ok=True)
                raise

        return meta, body()

    def _range_meta(self, base: CacheMeta, start: int, end: int, total: int) -> CacheMeta:
        hdr = dict(base.extra_headers)
        hdr["Content-Range"] = f"bytes {start}-{end}/{total}"
        hdr["Accept-Ranges"] = "bytes"
        return CacheMeta(key=base.key, size=end - start + 1, content_type=base.content_type,
                        status=206, total=total, extra_headers=hdr)

    # ---- internals ----
    async def _await_meta(self, dl: _Download):
        while dl.meta is None and not dl.done and dl.error is None:
            await dl.wait()
        if dl.error is not None:
            raise dl.error
        if dl.meta is None:
            raise RuntimeError("filler produced no metadata")

    async def _passthrough(self, filler: Filler):
        gen = filler()
        meta, first = await gen.__anext__()
        if meta is None:
            raise RuntimeError("filler must yield metadata first")

        async def it():
            if first:
                self.bytes_served += len(first)
                yield first
            async for _, chunk in gen:
                if chunk:
                    self.bytes_served += len(chunk)
                    yield chunk

        return meta, it()

    async def _begin(self, key: str, filler: Filler,
                     verify: Optional[str] = None) -> _Download:
        async with self._lock:
            dl = self._inflight.get(key)
            if dl is not None:
                return dl
            _, _, part_p = self._paths(key)
            part_p.parent.mkdir(parents=True, exist_ok=True)
            dl = _Download(part_p)
            self._inflight[key] = dl
            asyncio.create_task(self._fill(key, filler, dl, verify))
            return dl

    async def _fill(self, key: str, filler: Filler, dl: _Download,
                    verify: Optional[str] = None):
        data_p, meta_p, part_p = self._paths(key)
        # the decoupled buffer always fills the WHOLE object from offset 0
        # (regardless of any client Range), so a running sha256 over the written
        # bytes can be checked against the expected digest before we commit.
        h = hashlib.sha256() if verify else None
        try:
            gen = filler()
            meta, first = await gen.__anext__()
            if meta is None:
                raise RuntimeError("filler must yield metadata first")
            meta.key = key
            with open(part_p, "wb") as f:
                if first:
                    f.write(first)
                    dl.size = len(first)
                    if h:
                        h.update(first)
                dl.meta = meta
                dl.notify()
                async for _, chunk in gen:
                    if not chunk:
                        continue
                    f.write(chunk)
                    dl.size += len(chunk)
                    if h:
                        h.update(chunk)
                    dl.notify()
            if h is not None and h.hexdigest() != verify:
                self.verify_failures += 1
                raise IntegrityError(
                    f"sha256 mismatch for {key}: got {h.hexdigest()[:16]} want {verify[:16]}")
            meta.size = dl.size
            meta.total = dl.size
            os.replace(part_p, data_p)
            meta_p.write_text(json.dumps(meta.__dict__))
            self._record(key, dl.size)
            dl.done = True
            dl.notify()
            await self._enforce_limit()
        except BaseException as e:  # noqa: BLE001
            dl.error = e
            dl.done = True
            dl.notify()
            try:
                part_p.unlink(missing_ok=True)
            except Exception:
                pass
        finally:
            async with self._lock:
                self._inflight.pop(key, None)

    async def _read_inflight(self, key: str, dl: _Download,
                             start: int, end: Optional[int]) -> AsyncIterator[bytes]:
        data_p, _, part_p = self._paths(key)
        path = part_p if part_p.exists() else data_p
        f = open(path, "rb")
        pos = start
        try:
            while True:
                if end is not None and pos > end:
                    break
                avail = dl.size
                if pos < avail:
                    f.seek(pos)
                    want = CHUNK if end is None else min(CHUNK, end - pos + 1)
                    chunk = f.read(want)
                    if chunk:
                        pos += len(chunk)
                        self.bytes_served += len(chunk)
                        yield chunk
                        continue
                if dl.error is not None:
                    raise dl.error
                if dl.done:
                    if not part_p.exists() and data_p.exists() and path != data_p:
                        f.close(); f = open(data_p, "rb"); path = data_p
                        continue
                    # read any tail
                    f.seek(pos)
                    want = -1 if end is None else (end - pos + 1)
                    chunk = f.read(want) if want != 0 else b""
                    if chunk:
                        pos += len(chunk)
                        self.bytes_served += len(chunk)
                        yield chunk
                    break
                await dl.wait()
        finally:
            f.close()

    async def _read_file(self, key: str, start: int, end: int) -> AsyncIterator[bytes]:
        data_p, _, _ = self._paths(key)
        with open(data_p, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                self.bytes_served += len(chunk)
                yield chunk

    def _evict(self, digest: str, e: dict):
        sub = self.root / digest[:2] / digest[2:4]
        try:
            (sub / digest).unlink(missing_ok=True)
            (sub / (digest + ".meta")).unlink(missing_ok=True)
        except Exception:
            pass
        self._total -= e["size"]
        self._index.pop(digest, None)

    async def _enforce_limit(self):
        """LRU eviction down to the low-water mark, with two refinements:
        pinned entries are never evicted, and entries touched within the protect
        window are evicted only as a last resort (so a burst of small files
        cannot push out a hot large layer)."""
        if self._total <= self.max_bytes:
            return
        now = time.time()
        ordered = sorted(self._index.items(), key=lambda kv: kv[1]["atime"])
        # pass 1: evict cold (older than protect window); pass 2: allow recent too
        for allow_recent in (False, True):
            for digest, e in ordered:
                if self._total <= self.low_water:
                    break
                if digest not in self._index:
                    continue
                if self._is_pinned(e.get("key", "")):
                    continue
                if not allow_recent and (now - e["atime"]) < self.protect_window:
                    continue
                self._evict(digest, e)
            if self._total <= self.low_water:
                break
        self._flush(force=True)
