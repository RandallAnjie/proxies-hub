"""Smoke tests for the decoupled buffering cache."""
import asyncio
import tempfile

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


def test_passthrough_not_cached():
    async def go():
        with tempfile.TemporaryDirectory() as d:
            c = DiskCache(d, max_bytes=10**9)
            meta, chunks = await c.stream("x", _filler(b"abc"), cacheable=False)
            assert await _collect(chunks) == b"abc"
            assert c.lookup("x") is None

    asyncio.run(go())
