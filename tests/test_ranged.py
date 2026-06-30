"""ranged_upstream_filler: chunked fetch + token-refresh-on-401 continuation."""
import asyncio

from proxyhub.proxies import base


class _Content:
    def __init__(self, body):
        self._body = body

    async def iter_chunked(self, n):
        for i in range(0, len(self._body), n):
            yield self._body[i:i + n]


class _Resp:
    def __init__(self, status, headers=None, body=b""):
        self.status = status
        self.headers = dict(headers or {})
        self.content = _Content(body)

    async def release(self):
        pass


class _Session:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def get(self, url, headers=None, allow_redirects=False):
        self.calls.append((url, dict(headers or {})))

        async def _co():
            return self.responses.pop(0)
        return _co()


async def _collect(gen):
    meta, first = await gen.__anext__()
    out = first or b""
    async for _, c in gen:
        out += c
    return meta, out


def test_ranged_two_chunks(monkeypatch):
    async def go():
        fake = _Session([
            _Resp(206, {"Content-Range": "bytes 0-3/8"}, b"ABCD"),
            _Resp(206, {"Content-Range": "bytes 4-7/8"}, b"EFGH"),
        ])
        monkeypatch.setattr(base, "session", lambda: fake)
        gen = base.ranged_upstream_filler("https://o/blob", {}, chunk=4)()
        meta, out = await _collect(gen)
        assert meta.status == 200 and meta.total == 8
        assert out == b"ABCDEFGH"
    asyncio.run(go())


def test_ranged_reauth_on_401(monkeypatch):
    async def go():
        fake = _Session([
            _Resp(401, {}),                                         # token expired
            _Resp(206, {"Content-Range": "bytes 0-3/8"}, b"ABCD"),  # after refresh
            _Resp(206, {"Content-Range": "bytes 4-7/8"}, b"EFGH"),  # next chunk
        ])
        monkeypatch.setattr(base, "session", lambda: fake)
        n = {"reauth": 0}

        async def reauth():
            n["reauth"] += 1
            return {"Authorization": "Bearer NEW"}

        gen = base.ranged_upstream_filler(
            "https://o/blob", {"Authorization": "Bearer OLD"}, chunk=4, reauth=reauth)()
        meta, out = await _collect(gen)
        assert out == b"ABCDEFGH"             # continued, not restarted
        assert n["reauth"] == 1               # refreshed exactly once
        assert fake.calls[0][1]["Authorization"] == "Bearer OLD"   # first try, old
        assert fake.calls[1][1]["Authorization"] == "Bearer NEW"   # retry, fresh
        assert fake.calls[1][1]["Range"] == "bytes=0-3"            # same chunk pos
    asyncio.run(go())


def test_ranged_reauth_gives_up(monkeypatch):
    """A later chunk that stays 401 after reauth retries aborts (no infinite loop)."""
    async def go():
        fake = _Session([
            _Resp(206, {"Content-Range": "bytes 0-3/8"}, b"ABCD"),  # chunk 0 ok
            _Resp(401, {}), _Resp(401, {}), _Resp(401, {}),         # chunk 1: 1 try + 2 reauths
        ])
        monkeypatch.setattr(base, "session", lambda: fake)

        async def reauth():
            return {"Authorization": "Bearer STILL-BAD"}

        gen = base.ranged_upstream_filler("https://o/blob", {}, chunk=4, reauth=reauth)()
        raised = False
        try:
            await _collect(gen)
        except RuntimeError:
            raised = True
        assert raised                          # surfaced as error, fill discarded
    asyncio.run(go())
