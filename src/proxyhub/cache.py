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
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncIterator, Callable, Optional

CHUNK = 256 * 1024


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
    def __init__(self, root: str, max_bytes: int):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.max_bytes = max_bytes
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
        self._load_index()

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

    def stats(self) -> dict:
        total_req = self.hits + self.misses
        return {
            "uptime": int(time.time() - self.started),
            "hits": self.hits, "misses": self.misses,
            "hit_rate": round(self.hits / total_req * 100, 1) if total_req else 0.0,
            "bytes_served": self.bytes_served,
            "cache_bytes": self._total, "cache_max": self.max_bytes,
            "cache_files": len(self._index),
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

    # ---- streaming (full) ----
    async def stream(self, key: str, filler: Filler, cacheable: bool = True):
        meta = self.lookup(key)
        if meta is not None:
            self.hits += 1
            return meta, self._read_file(key, 0, meta.size - 1)
        self.misses += 1
        if not cacheable:
            return await self._passthrough(filler)
        dl = await self._begin(key, filler)
        await self._await_meta(dl)
        # If the upstream advertised a full length, emit it as Content-Length.
        # Docker/containerd require a known blob size; a chunked (length-less)
        # response makes it distrust the stream and reconnect/retry endlessly.
        if dl.meta.total is not None and dl.meta.total >= 0:
            dl.meta.size = dl.meta.total
        return dl.meta, self._read_inflight(key, dl, 0, None)

    # ---- streaming (range) ----
    async def stream_range(self, key: str, start: int, end: Optional[int],
                           filler: Filler, cacheable: bool = True):
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
        dl = await self._begin(key, filler)
        await self._await_meta(dl)
        total = dl.meta.total
        if total is None or total < 0:
            # unknown size: cannot form Content-Range; fall back to full stream
            return dl.meta, self._read_inflight(key, dl, 0, None)
        real_end = total - 1 if end is None or end >= total else end
        m = self._range_meta(dl.meta, start, real_end, total)
        return m, self._read_inflight(key, dl, start, real_end)

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

    async def _begin(self, key: str, filler: Filler) -> _Download:
        async with self._lock:
            dl = self._inflight.get(key)
            if dl is not None:
                return dl
            _, _, part_p = self._paths(key)
            part_p.parent.mkdir(parents=True, exist_ok=True)
            dl = _Download(part_p)
            self._inflight[key] = dl
            asyncio.create_task(self._fill(key, filler, dl))
            return dl

    async def _fill(self, key: str, filler: Filler, dl: _Download):
        data_p, meta_p, part_p = self._paths(key)
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
                dl.meta = meta
                dl.notify()
                async for _, chunk in gen:
                    if not chunk:
                        continue
                    f.write(chunk)
                    dl.size += len(chunk)
                    dl.notify()
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

    async def _enforce_limit(self):
        if self._total <= self.max_bytes:
            return
        for digest, e in sorted(self._index.items(), key=lambda kv: kv[1]["atime"]):
            if self._total <= self.max_bytes:
                break
            sub = self.root / digest[:2] / digest[2:4]
            try:
                (sub / digest).unlink(missing_ok=True)
                (sub / (digest + ".meta")).unlink(missing_ok=True)
            except Exception:
                pass
            self._total -= e["size"]
            self._index.pop(digest, None)
        self._flush(force=True)
