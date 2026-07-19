"""Disk cache: decoupled full-speed buffering + persistent LRU index + Range.

* Decoupled buffering: one background task downloads at server speed into a
  ``.part`` file while any number of clients stream from the growing file.
* Persistent LRU index: the in-memory dict is kept in LRU order (re-inserted on
  every touch), so eviction walks from the front — no sorting. It is flushed to
  ``.index.json`` asynchronously and throttled (rewriting a 50k-entry JSON on
  every store used to burn CPU and terabytes of writes).
* Correctness: only ``200`` bodies are ever committed (a transient upstream
  401/500 can't poison a key); docker blobs are verified against their digest.
* Quotas: optional per-service byte caps so one flooding service (someone
  mirroring all of Alpine) can't evict everyone else's hot objects.
* Range: cached objects serve byte ranges (206); a ranged miss still fills the
  full object (caching it) and serves the requested slice from the growing file.
"""
from __future__ import annotations

import asyncio
import hashlib
import itertools
import json
import logging
import os
import re
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncIterator, Callable, Optional

CHUNK = 256 * 1024
log = logging.getLogger("proxyhub.cache")


class IntegrityError(Exception):
    """A filled object failed its expected-digest check; it is not cached."""


class _FillAborted(Exception):
    """A queued fill reached the front of the line with no one waiting for it."""


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
        self.waiters = 0          # clients currently waiting on this fill
        # a non-200 response is never written to disk: its (small) body is
        # buffered here so attached readers can still deliver it
        self.mem: Optional[bytearray] = None
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
                 low_water_ratio: float = 0.92, pin_patterns: Optional[list] = None,
                 max_concurrent_fills: int = 8, quotas: Optional[dict] = None,
                 fill_pools: Optional[dict] = None):
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
        # optional per-service byte caps: {group_label: max_bytes}
        self.quotas = dict(quotas or {})
        self.verify_failures = 0
        self.revalidations = 0
        self.aborted_fills = 0    # queued fills dropped because no one waited
        # live fill state for the dashboard: per-pool ACTIVE (slot held, bytes
        # flowing) vs QUEUED (waiting for a slot) — 'inflight' alone made the
        # dash look like it was jittering 0/1 with no explanation
        self._pool_active: dict[str, int] = {}
        self.last_failures: deque = deque(maxlen=10)
        self._inflight: dict[str, _Download] = {}
        self._lock = asyncio.Lock()
        # cap concurrent upstream fetches so N big layers don't split the link
        # into a useless trickle. Fills are POOLED per service class: one global
        # FIFO semaphore let multi-GB torch/HF fetches occupy every slot for
        # tens of minutes while a docker pull's small layers starved in the
        # queue behind them (-> client timeouts). docker gets its own pool; a
        # service named in fill_pools gets a dedicated one; the rest share
        # "default". A flood in one pool cannot stall another.
        if not fill_pools:
            half = max(2, max_concurrent_fills // 2)
            fill_pools = {"docker": half,
                          "default": max(2, max_concurrent_fills - half)}
        fill_pools.setdefault("docker", 4)
        fill_pools.setdefault("default", 4)
        self.fill_pools = {k: int(v) for k, v in fill_pools.items()}
        self._fill_sems = {k: asyncio.Semaphore(v) for k, v in self.fill_pools.items()}
        self.max_fills = max_concurrent_fills
        # metrics
        self.hits = 0
        self.misses = 0
        self.bytes_served = 0
        self.started = time.time()
        self._svc: dict[str, list] = {}          # service -> [hits, misses]
        # persistent LRU index: digest -> {"key","size","atime"}; the DICT ORDER
        # is the LRU order (entries are re-inserted on every touch)
        self._index: dict[str, dict] = {}
        self._total = 0
        self._groups: dict[str, list] = {}       # group -> [files, bytes]
        self._index_path = self.root / ".index.json"
        # flush throttling: mark-dirty + periodic/async write instead of
        # rewriting the whole index JSON synchronously on every store
        self._dirty = 0
        self._last_flush = time.time()
        self._flushing = False
        self._rv_seq = itertools.count()
        self._load_index()
        self._reconcile()

    def _pool_for(self, key: str) -> str:
        group = self._group_label(key)
        if group in self._fill_sems:
            return group                       # explicitly pooled service
        if group.startswith("docker"):
            return "docker"
        return "default"

    # ---- startup reconcile ----
    def _reconcile(self):
        """One startup walk that (a) deletes abandoned ``.part``/``.rv`` partials
        (no fill is in flight yet, so any partial is stale), (b) adds data files
        the index doesn't know about (a crash can lose recent index writes now
        that flushing is throttled) and (c) drops index entries whose file is
        gone. Keeps the index truthful so eviction accounting never drifts."""
        removed = freed = adopted = 0
        seen: set[str] = set()
        for p in self.root.rglob("*"):
            if not p.is_file():
                continue
            name = p.name
            if name.endswith((".part", ".rv")):
                try:
                    freed += p.stat().st_size
                    p.unlink()
                    removed += 1
                except OSError:
                    pass
                continue
            if name.endswith(".meta") or name == ".index.json" or name.endswith(".tmp"):
                continue
            seen.add(name)
            if name not in self._index:
                try:
                    st = p.stat()
                except OSError:
                    continue
                meta_p = p.with_name(name + ".meta")
                key = ""
                try:
                    key = json.loads(meta_p.read_text()).get("key", "")
                except Exception:
                    pass
                self._index[name] = {"key": key, "size": st.st_size, "atime": st.st_atime}
                self._total += st.st_size
                self._grp_add(key, st.st_size)
                adopted += 1
        for digest in [d for d in self._index if d not in seen]:
            e = self._index.pop(digest)
            self._total -= e["size"]
            self._grp_sub(e.get("key", ""), e["size"])
        if removed or adopted:
            log.info("reconcile: removed %d stale partial(s) (%.1f MB), "
                     "adopted %d untracked file(s)", removed, freed / 1024 / 1024, adopted)
        self.flush_sync()

    def sweep_partials(self, min_age: int = 600, active: Optional[set] = None) -> int:
        """Periodic reaper for partials a *still-running* process can accumulate
        (e.g. a revalidation whose client vanished mid-stream). ``active`` is a
        snapshot of in-flight fill paths taken on the event loop (this method
        runs in an executor thread; it must not touch loop-owned state). Only
        removes files untouched for ``min_age`` seconds — an active fill
        refreshes its ``.part`` mtime on every chunk."""
        active = active or set()
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

    def active_partials(self) -> set:
        """Snapshot of in-flight partial paths — call on the event loop."""
        return {str(dl.part_path) for dl in self._inflight.values()}

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
                self._index = doc["entries"]     # saved in LRU order
                self._total = int(doc["total"])
                for e in self._index.values():
                    self._grp_add(e.get("key", ""), e.get("size", 0))
                return
            except Exception:
                self._index, self._total, self._groups = {}, 0, {}

    def _write_index(self, snapshot: dict, total: int):
        # runs in an executor thread; snapshot's structure is frozen (shallow
        # copy on the loop), inner atime updates are harmless value swaps
        try:
            tmp = self._index_path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"total": total, "entries": snapshot}))
            os.replace(tmp, self._index_path)
        except Exception:
            pass

    def flush_sync(self):
        """Synchronous full flush — startup/shutdown/tests."""
        self._dirty = 0
        self._last_flush = time.time()
        self._write_index(dict(self._index), self._total)

    async def flush_async(self):
        """Throttle-aware async flush: snapshot on the loop, write off-loop."""
        if self._flushing:
            return
        if self._dirty == 0:
            return
        self._flushing = True
        try:
            snap = dict(self._index)
            total = self._total
            self._dirty = 0
            self._last_flush = time.time()
            await asyncio.get_running_loop().run_in_executor(
                None, self._write_index, snap, total)
        finally:
            self._flushing = False

    def _mark_dirty(self):
        self._dirty += 1
        # safety valve: if a flood outpaces the periodic flush, self-schedule
        if self._dirty >= 2000 and not self._flushing:
            try:
                asyncio.get_running_loop().create_task(self.flush_async())
            except RuntimeError:
                self.flush_sync()          # no loop (tests) -> sync

    # ---- group accounting ----
    def _grp_add(self, key: str, size: int):
        g = self._groups.setdefault(self._group_label(key), [0, 0])
        g[0] += 1
        g[1] += size

    def _grp_sub(self, key: str, size: int):
        g = self._groups.get(self._group_label(key))
        if g:
            g[0] -= 1
            g[1] -= size

    def _record(self, key: str, size: int):
        d = self._digest(key)
        old = self._index.pop(d, None)
        if old:
            self._total -= old["size"]
            self._grp_sub(old.get("key", key), old["size"])
        self._index[d] = {"key": key, "size": size, "atime": time.time()}
        self._total += size
        self._grp_add(key, size)
        self._mark_dirty()

    def _bump(self, key: str):
        d = self._digest(key)
        e = self._index.pop(d, None)
        if e:
            e["atime"] = time.time()
            self._index[d] = e            # re-insert -> back of the LRU order
            self._mark_dirty()

    def _drop(self, key: str):
        """Remove a cached entry (files + index) — e.g. a legacy poisoned one."""
        d = self._digest(key)
        e = self._index.get(d)
        if e is not None:
            self._evict(d, e)
        else:
            data_p, meta_p, _ = self._paths(key)
            data_p.unlink(missing_ok=True)
            meta_p.unlink(missing_ok=True)

    def _is_pinned(self, key: str) -> bool:
        return bool(key) and any(p.search(key) for p in self._pins)

    def _svc_bump(self, key: str, hit: bool):
        if not key:                              # passthrough has no cache key
            return
        rec = self._svc.setdefault(self._group_label(key), [0, 0])
        rec[0 if hit else 1] += 1

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
        """Per-service {files, bytes, hits, misses, quota} from incremental
        accounting (no index walk)."""
        groups: dict[str, dict] = {}

        def g(label):
            return groups.setdefault(label, {"files": 0, "bytes": 0, "hits": 0, "misses": 0})

        for label, (files, size) in self._groups.items():
            if files <= 0 and size <= 0:
                continue
            grp = g(label)
            grp["files"], grp["bytes"] = files, size
        for svc, (h, m) in self._svc.items():
            grp = g(svc)
            grp["hits"], grp["misses"] = h, m
        for label, q in self.quotas.items():
            if label in groups:
                groups[label]["quota"] = q
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
            "aborted_fills": self.aborted_fills,
            "inflight_fills": len(self._inflight),
            "fills_active": {k: v for k, v in self._pool_active.items() if v},
            "fills_queued": max(0, len(self._inflight) - sum(self._pool_active.values())),
            "recent_failures": list(self.last_failures),
            "fill_pools": self.fill_pools,
            "pins": len(self._pins),
            "quotas": self.quotas,
        }

    # ---- lookup ----
    def lookup(self, key: str) -> Optional[CacheMeta]:
        data_p, meta_p, _ = self._paths(key)
        if data_p.exists() and meta_p.exists():
            try:
                m = json.loads(meta_p.read_text())
            except Exception:
                return None
            if m.get("status", 200) != 200:
                # legacy poisoned entry (an upstream error body cached before
                # non-200 responses were rejected) — purge it
                self._drop(key)
                return None
            self._bump(key)
            return CacheMeta(**m)
        return None

    def peek(self, key: str) -> Optional[CacheMeta]:
        """Like lookup but without touching atime or hit/miss counters — used by
        revalidation to read a cached entry's stored validators (ETag/Date)."""
        data_p, meta_p, _ = self._paths(key)
        if data_p.exists() and meta_p.exists():
            try:
                m = json.loads(meta_p.read_text())
                if m.get("status", 200) != 200:
                    return None
                return CacheMeta(**m)
            except Exception:
                return None
        return None

    # ---- streaming (full) ----
    async def stream(self, key: str, filler: Filler, cacheable: bool = True,
                     verify: Optional[str] = None):
        meta = self.lookup(key)
        if meta is not None:
            it = self._read_file(key, 0, meta.size - 1)
            if it is not None:                       # evicted in the window -> miss
                self.hits += 1
                self._svc_bump(key, True)
                return meta, it
        self.misses += 1
        self._svc_bump(key, False)
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
            total = meta.size
            real_end = total - 1 if end is None or end >= total else end
            it = self._read_file(key, start, real_end)
            if it is not None:
                self.hits += 1
                self._svc_bump(key, True)
                return self._range_meta(meta, start, real_end, total), it

        self.misses += 1
        self._svc_bump(key, False)
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
        (the ``filler`` must carry If-None-Match / If-Modified-Since).

        * ``304``  -> serve the cached body (fresh, no re-download)
        * ``200``  -> stream the new body to the client while re-caching it
        * ``5xx``/``429`` -> serve the cached body (stale-if-error: a flaky
          upstream must not take down objects we already hold)
        * other 4xx -> stream through, cache untouched
        """
        self.revalidations += 1
        gen = filler()
        meta, first = await gen.__anext__()
        if meta is None:
            raise RuntimeError("filler must yield metadata first")

        if meta.status == 304 or meta.status >= 500 or meta.status == 429:
            async for _ in gen:    # drain (release the upstream connection)
                pass
            it = self._read_file(key, 0, cached.size - 1)
            if it is not None:
                self.hits += 1
                self._svc_bump(key, True)
                self._bump(key)
                return cached, it
            raise RuntimeError(f"cached body for {key} vanished during revalidation")

        if meta.status != 200:
            # gone/forbidden upstream: pass it through, keep our copy untouched
            async def passthrough():
                if first:
                    self.bytes_served += len(first)
                    yield first
                async for _, c in gen:
                    if c:
                        self.bytes_served += len(c)
                        yield c
            self.misses += 1
            self._svc_bump(key, False)
            return meta, passthrough()

        # changed (200) — stream to the client while writing a fresh copy, then
        # atomically replace the cached entry. Unique temp name: two concurrent
        # revalidations of one key must not interleave writes.
        self.misses += 1
        self._svc_bump(key, False)
        meta.key = key
        if meta.total is not None and meta.total >= 0:
            meta.size = meta.total
        data_p, meta_p, part_p = self._paths(key)
        rv = part_p.with_name(f"{part_p.name}.{next(self._rv_seq)}.rv")
        rv.parent.mkdir(parents=True, exist_ok=True)

        async def body():
            h = hashlib.sha256() if verify else None
            size = 0
            try:
                with open(rv, "wb") as f:
                    if first:
                        f.write(first)
                        size += len(first)
                        if h:
                            h.update(first)
                        self.bytes_served += len(first)
                        yield first
                    async for _, c in gen:
                        if not c:
                            continue
                        f.write(c)
                        size += len(c)
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
                await self._enforce_quota(key)
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
        # waiter count keeps the fill alive: if every waiting client disconnects
        # (aiohttp cancels the handler -> CancelledError -> finally) while the
        # fill is still QUEUED for a slot, the fill gives up instead of
        # downloading data nobody asked for.
        dl.waiters += 1
        try:
            while dl.meta is None and not dl.done and dl.error is None:
                await dl.wait()
        finally:
            dl.waiters -= 1
        if dl.error is not None:
            raise dl.error
        if dl.meta is None:
            raise RuntimeError("filler produced no metadata")

    async def _passthrough(self, filler: Filler):
        gen = filler()
        meta, first = await gen.__anext__()
        if meta is None:
            raise RuntimeError("filler must yield metadata first")
        # surface the upstream length: docker 26's blob HEAD/GET reader fails
        # outright on 'missing or empty Content-Length header'
        if meta.size < 0 and meta.total is not None and meta.total >= 0:
            meta.size = meta.total

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
            # a finished-with-error download lingering before its finally-pop
            # must not be joined — the error would surface to the new client
            if dl is not None and dl.error is None:
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
        got_slot = False
        pool = self._pool_for(key)
        try:
            # gate the actual upstream fetch: queued fills wait here for a slot
            # in their service pool, so a burst of layers doesn't split the link
            # into a dead trickle — and giant torch/HF fetches can't starve
            # docker's small layers (separate pools)
            async with self._fill_sems[pool]:
                # nobody is waiting anymore (every client disconnected while we
                # were queued) -> abort before downloading a single byte. A fill
                # that already STARTED keeps going (cache investment, capped by
                # the semaphore); retries join it via _inflight.
                if dl.waiters == 0:
                    self.aborted_fills += 1
                    raise _FillAborted(key)
                self._pool_active[pool] = self._pool_active.get(pool, 0) + 1
                got_slot = True
                gen = filler()
                meta, first = await gen.__anext__()
                if meta is None:
                    raise RuntimeError("filler must yield metadata first")
                meta.key = key
                # an upstream error (transient 401/5xx/404) is streamed to the
                # waiting clients from MEMORY and NEVER committed to the cache —
                # a bad answer must not poison the key until eviction
                commit = meta.status == 200
                if commit:
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
                            f"sha256 mismatch for {key}: "
                            f"got {h.hexdigest()[:16]} want {verify[:16]}")
                    meta.size = dl.size
                    meta.total = dl.size
                    os.replace(part_p, data_p)
                    meta_p.write_text(json.dumps(meta.__dict__))
                    self._record(key, dl.size)
                else:
                    dl.mem = bytearray()
                    cap = 256 * 1024          # error bodies are small; bound it
                    if first:
                        dl.mem += first[:cap]
                        dl.size = len(dl.mem)
                    dl.meta = meta
                    dl.notify()
                    async for _, chunk in gen:
                        if not chunk:
                            continue
                        if len(dl.mem) < cap:
                            dl.mem += chunk[:cap - len(dl.mem)]
                            dl.size = len(dl.mem)
                            dl.notify()
                dl.done = True
                dl.notify()
                if commit:
                    await self._enforce_quota(key)
                    await self._enforce_limit()
        except BaseException as e:  # noqa: BLE001
            dl.error = e
            dl.done = True
            dl.notify()
            if not isinstance(e, _FillAborted):
                self.last_failures.append({
                    "t": int(time.time()), "key": key[:120],
                    "error": f"{type(e).__name__}: {e}"[:200]})
            try:
                part_p.unlink(missing_ok=True)
            except Exception:
                pass
        finally:
            if got_slot:
                self._pool_active[pool] -= 1
            async with self._lock:
                if self._inflight.get(key) is dl:   # identity: don't pop a successor
                    self._inflight.pop(key, None)

    async def _read_inflight(self, key: str, dl: _Download,
                             start: int, end: Optional[int]) -> AsyncIterator[bytes]:
        data_p, _, part_p = self._paths(key)
        f = None
        path = None

        def try_open() -> bool:
            nonlocal f, path
            for cand in (part_p, data_p):
                try:
                    f = open(cand, "rb")
                    path = cand
                    return True
                except FileNotFoundError:
                    continue
            return False

        try_open()
        pos = start
        try:
            while True:
                if end is not None and pos > end:
                    break
                if dl.mem is not None:
                    # non-200 body: served from the fill's memory buffer
                    m = dl.mem
                    if pos < len(m):
                        upto = len(m) if end is None else min(len(m), end + 1)
                        chunk = bytes(m[pos:upto])
                        pos += len(chunk)
                        self.bytes_served += len(chunk)
                        yield chunk
                        continue
                    if dl.error is not None:
                        raise dl.error
                    if dl.done:
                        break
                    await dl.wait()
                    continue
                if f is None:
                    if dl.error is not None:
                        raise dl.error
                    if dl.done:
                        if try_open():
                            continue
                        break
                    await dl.wait()
                    try_open()
                    continue
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
                    if path != data_p and not part_p.exists() and data_p.exists():
                        f.close()
                        f = open(data_p, "rb")
                        path = data_p
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
            if f is not None:
                f.close()

    def _read_file(self, key: str, start: int, end: int):
        """Open eagerly (so an eviction between lookup and read degrades to a
        miss instead of a 500) and return an async iterator, or None if gone."""
        data_p, _, _ = self._paths(key)
        try:
            f = open(data_p, "rb")
        except FileNotFoundError:
            return None

        async def it() -> AsyncIterator[bytes]:
            try:
                f.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    chunk = f.read(min(CHUNK, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    self.bytes_served += len(chunk)
                    yield chunk
            finally:
                f.close()

        return it()

    def _evict(self, digest: str, e: dict):
        sub = self.root / digest[:2] / digest[2:4]
        try:
            (sub / digest).unlink(missing_ok=True)
            (sub / (digest + ".meta")).unlink(missing_ok=True)
        except Exception:
            pass
        self._total -= e["size"]
        self._grp_sub(e.get("key", ""), e["size"])
        self._index.pop(digest, None)
        self._mark_dirty()

    async def _enforce_quota(self, key: str):
        """Per-service quota: evict the flooding service's own LRU entries so it
        can't push everyone else out of the shared pool."""
        group = self._group_label(key)
        q = self.quotas.get(group)
        if not q:
            return
        g = self._groups.get(group)
        if not g or g[1] <= q:
            return
        target = int(q * 0.95)
        n = 0
        for digest in list(self._index.keys()):     # dict order == LRU order
            if self._groups.get(group, [0, 0])[1] <= target:
                break
            e = self._index.get(digest)
            if e is None:
                continue
            k = e.get("key", "")
            if self._group_label(k) != group or self._is_pinned(k):
                continue
            self._evict(digest, e)
            n += 1
            if n % 500 == 0:
                await asyncio.sleep(0)               # don't starve the loop

    async def _enforce_limit(self):
        """LRU eviction down to the low-water mark. The index dict is kept in
        LRU order, so this walks from the front — no 80k-entry sort. Pinned
        entries are never evicted; entries touched within the protect window go
        only as a last resort."""
        if self._total <= self.max_bytes:
            return
        now = time.time()
        n = 0
        for allow_recent in (False, True):
            if self._total <= self.low_water:
                break
            for digest in list(self._index.keys()):
                if self._total <= self.low_water:
                    break
                e = self._index.get(digest)
                if e is None:
                    continue
                if self._is_pinned(e.get("key", "")):
                    continue
                if not allow_recent and (now - e["atime"]) < self.protect_window:
                    continue
                self._evict(digest, e)
                n += 1
                if n % 500 == 0:
                    await asyncio.sleep(0)           # don't starve the loop
