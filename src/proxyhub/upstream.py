"""Shared aiohttp client session + small helpers for upstream requests."""
from __future__ import annotations

from typing import Optional

import aiohttp

_session: Optional[aiohttp.ClientSession] = None

# generous timeouts: large blobs over a 100Mbit link can take minutes; the
# connection must not be cut for slow *total* duration, only for stalls.
_TIMEOUT = aiohttp.ClientTimeout(total=None, sock_connect=30, sock_read=120)


def session() -> aiohttp.ClientSession:
    global _session
    if _session is None or _session.closed:
        _session = aiohttp.ClientSession(
            timeout=_TIMEOUT,
            auto_decompress=True,             # decode gzip; we strip Content-Encoding
            trust_env=True,
        )
    return _session


async def close():
    global _session
    if _session and not _session.closed:
        await _session.close()
        _session = None
