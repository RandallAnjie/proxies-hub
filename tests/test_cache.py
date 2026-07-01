"""Smoke tests for the decoupled buffering cache."""
import asyncio
import hashlib
import tempfile
import time

from proxyhub.cache import CacheMeta, DiskCache


def _filler(data: bytes, chunk: int = 7):
    async def gen():
        yield CacheMeta(key="", size=-1, content_type="application/octet-stream"), b""
        for i in range(0, len(data), chunk):
            await asyncio.sleep(0)  # let other tasks run (simulate streaming)
            yield None, data[i:i + chunk]
    return gen


async def _collect(it):
    out = b""
    async for c in it:
        out += c
    return out


def test_miss_then_hit():
    async def go():
        with tempfile.TemporaryDirectory() as d:
            c = DiskCache(d, max_bytes=10**9)
            payload = b"hello world " * 1000

            meta, chunks = await c.stream("k1", _filler(payload))
            assert meta.status == 200
            assert await _collect(chunks) == payload

            # second time: served from disk (hit)
            assert c.lookup("k1") is not None
            meta2, chunks2 = await c.stream("k1", _filler(b"SHOULD-NOT-RUN"))
            assert await _collect(chunks2) == payload

    asyncio.run(go())


def test_concurrent_readers_share_one_fill():
    async def go():
        with tempfile.TemporaryDirectory() as d:
            c = DiskCache(d, max_bytes=10**9)
            payload = bytes(range(256)) * 500
            r1 = c.stream("blob", _filler(payload, chunk=33))
            r2 = c.stream("blob", _filler(b"OTHER"))  # joins the same fill
            (m1, it1), (m2, it2) = await asyncio.gather(r1, r2)
            a, b = await asyncio.gather(_collect(it1), _collect(it2))
            assert a == payload and b == payload

    asyncio.run(go())


def test_range_from_cache():
    async def go():
        with tempfile.TemporaryDirectory() as d:
            c = DiskCache(d, max_bytes=10**9)
            payload = bytes(range(256)) * 40  # 10240 bytes
            await _collect((await c.stream("r", _filler(payload)))[1])  # warm

            meta, chunks = await c.stream_range("r", 100, 199, _filler(b"x"))
            assert meta.status == 206
            assert meta.extra_headers["Content-Range"] == f"bytes 100-199/{len(payload)}"
            assert await _collect(chunks) == payload[100:200]

            # open-ended range
            meta2, chunks2 = await c.stream_range("r", len(payload) - 5, None, _filler(b"x"))
            assert await _collect(chunks2) == payload[-5:]

    asyncio.run(go())


def _filler_total(data: bytes, chunk: int = 64):
    """Like _filler but advertises the full size (upstream Content-Length)."""
    def gen():
        async def g():
            yield CacheMeta(key="", size=-1, total=len(data), content_type="x"), b""
            for i in range(0, len(data), chunk):
                await asyncio.sleep(0)
                yield None, data[i:i + chunk]
        return g()
    return gen


def test_range_on_cold_object_inflight():
    """Range request for an UNCACHED object: served from the growing file,
    and the full object is cached as a side effect."""
    async def go():
        with tempfile.TemporaryDirectory() as d:
            c = DiskCache(d, max_bytes=10**9)
            payload = bytes(range(256)) * 50  # 12800 bytes
            assert c.lookup("cold") is None     # truly cold

            meta, chunks = await c.stream_range("cold", 5000, 5099, _filler_total(payload))
            assert meta.status == 206
            assert meta.extra_headers["Content-Range"] == f"bytes 5000-5099/{len(payload)}"
            assert await _collect(chunks) == payload[5000:5100]

            for _ in range(200):                 # let the background fill finish
                if c.lookup("cold") is not None:
                    break
                await asyncio.sleep(0.01)
            assert c.lookup("cold") is not None  # whole object cached
            # and a subsequent full read returns the complete payload
            _, full = await c.stream("cold", _filler_total(b"NOPE"))
            assert await _collect(full) == payload

    asyncio.run(go())


def test_persistent_index_survives_reopen():
    async def go():
        with tempfile.TemporaryDirectory() as d:
            c = DiskCache(d, max_bytes=10**9)
            await _collect((await c.stream("p", _filler(b"data" * 100)))[1])
            assert c.stats()["cache_files"] == 1
            c2 = DiskCache(d, max_bytes=10**9)          # reopen
            assert c2.stats()["cache_files"] == 1       # loaded from .index.json
            assert c2.lookup("p") is not None

    asyncio.run(go())


def test_docker_blob_grouped_as_shared_layers():
    with tempfile.TemporaryDirectory() as d:
        c = DiskCache(d, max_bytes=10**9)
        # a digest-keyed blob (shared pool) vs a per-registry manifest key
        assert c._group_label("docker:blob:sha256:" + "a" * 64) == "docker/layers"
        assert c._group_label("docker:hub:/v2/library/nginx/manifests/latest") == "docker/hub"


def test_startup_cleans_partials():
    with tempfile.TemporaryDirectory() as d:
        c = DiskCache(d, max_bytes=10**9)
        sub = c.root / "ab" / "cd"
        sub.mkdir(parents=True, exist_ok=True)
        (sub / "x.part").write_bytes(b"leftover")     # abandoned partials
        (sub / "y.rv").write_bytes(b"leftover")
        (sub / "real").write_bytes(b"data")           # a real object must survive
        DiskCache(d, max_bytes=10**9)                  # reopen -> cleanup runs
        assert not (sub / "x.part").exists()
        assert not (sub / "y.rv").exists()
        assert (sub / "real").exists()


def test_sweep_partials_age_and_active():
    import os
    with tempfile.TemporaryDirectory() as d:
        c = DiskCache(d, max_bytes=10**9)
        sub = c.root / "aa" / "bb"
        sub.mkdir(parents=True, exist_ok=True)
        old = sub / "old.part"; old.write_bytes(b"x")
        fresh = sub / "fresh.part"; fresh.write_bytes(b"x")
        active = sub / "active.part"; active.write_bytes(b"x")
        past = time.time() - 1200
        os.utime(old, (past, past))
        os.utime(active, (past, past))     # old, but it's an in-flight fill

        class _DL:
            part_path = active
        c._inflight["k"] = _DL()

        removed = c.sweep_partials(min_age=600)
        assert not old.exists()            # untouched > window -> reaped
        assert fresh.exists()              # too new -> kept
        assert active.exists()             # backing an in-flight fill -> kept
        assert removed == 1


def test_passthrough_not_cached():
    async def go():
        with tempfile.TemporaryDirectory() as d:
            c = DiskCache(d, max_bytes=10**9)
            meta, chunks = await c.stream("x", _filler(b"abc"), cacheable=False)
            assert await _collect(chunks) == b"abc"
            assert c.lookup("x") is None

    asyncio.run(go())


def _filler_meta(data: bytes, status: int = 200, headers=None, chunk: int = 64):
    def gen():
        async def g():
            total = len(data) if status == 200 else -1
            yield CacheMeta(key="", size=-1, total=total, content_type="application/json",
                            status=status, extra_headers=dict(headers or {})), b""
            if status != 304:
                for i in range(0, len(data), chunk):
                    await asyncio.sleep(0)
                    yield None, data[i:i + chunk]
        return g()
    return gen


def test_digest_verify_good_and_bad():
    async def go():
        with tempfile.TemporaryDirectory() as d:
            c = DiskCache(d, max_bytes=10**9)
            payload = b"layer-bytes-" * 500
            good = hashlib.sha256(payload).hexdigest()

            _, it = await c.stream("blob:good", _filler(payload), verify=good)
            assert await _collect(it) == payload
            assert c.lookup("blob:good") is not None          # verified -> cached

            raised = False
            try:
                _, it2 = await c.stream("blob:bad", _filler(payload), verify="0" * 64)
                await _collect(it2)
            except Exception:
                raised = True
            assert raised
            assert c.lookup("blob:bad") is None               # mismatch -> not cached
            assert c.stats()["verify_failures"] == 1

    asyncio.run(go())


def test_revalidate_304_and_200():
    async def go():
        with tempfile.TemporaryDirectory() as d:
            c = DiskCache(d, max_bytes=10**9)
            v1 = b'{"pkg":1}' * 100
            _, it = await c.stream("idx", _filler_meta(v1, headers={"ETag": '"v1"'}))
            assert await _collect(it) == v1
            cached = c.peek("idx")
            assert cached.extra_headers.get("ETag") == '"v1"'

            # 304 -> serve the cached body unchanged
            meta, ch = await c.stream_revalidate("idx", _filler_meta(b"", status=304), cached)
            assert await _collect(ch) == v1

            # 200 -> stream + re-cache the new body
            v2 = b'{"pkg":2}' * 130
            _, ch2 = await c.stream_revalidate(
                "idx", _filler_meta(v2, headers={"ETag": '"v2"'}), cached)
            assert await _collect(ch2) == v2
            _, again = await c.stream("idx", _filler_meta(b"NOPE"))
            assert await _collect(again) == v2
            assert c.peek("idx").extra_headers.get("ETag") == '"v2"'
            assert c.stats()["revalidations"] == 2

    asyncio.run(go())


def test_pinned_never_evicted():
    async def go():
        with tempfile.TemporaryDirectory() as d:
            c = DiskCache(d, max_bytes=2000, protect_window=0, pin_patterns=[r"^pinned:"])
            await _collect((await c.stream("pinned:keep", _filler(b"P" * 800)))[1])
            for i in range(8):                       # churn past the cap
                await _collect((await c.stream(f"x{i}", _filler(b"y" * 500)))[1])
            assert c.lookup("pinned:keep") is not None    # pin survives eviction
            assert c.stats()["cache_bytes"] <= c.max_bytes

    asyncio.run(go())


def test_protect_window_is_last_resort():
    async def go():
        with tempfile.TemporaryDirectory() as d:
            # everything stays "recent" (huge window) but cache still bounded:
            # pass 2 evicts protected entries when nothing cold remains
            c = DiskCache(d, max_bytes=1500, protect_window=10**6)
            for i in range(8):
                await _collect((await c.stream(f"e{i}", _filler(b"z" * 500)))[1])
            assert c.stats()["cache_bytes"] <= c.max_bytes

    asyncio.run(go())
