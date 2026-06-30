# proxyhub

A single, hackable **Python** pull-through mirror proxy that replaces a stack of
nginx + distribution-registry + ghproxy with one codebase. Built async on
aiohttp around one core idea — a **decoupled full-speed buffering cache**: an
uncached object is fetched from upstream at server speed by one background task
while any number of (possibly slow) clients stream from the growing file, so a
slow client can never cause an upstream connection to time out mid-transfer.

## What it does

| Host (`domain = proxies.live`) | Backend |
| --- | --- |
| `hub.docker.<domain>`, `ghcr.docker.<domain>`, … | Docker Registry v2 pull-through (token auth to upstream, blobs cached by digest, manifests live) |
| `github.<domain>` | GitHub proxy: `/<scheme>://<host>/<path>`, token aliases, **private release downloads** |
| `conda.<domain>`, `torch.<domain>`, … | Caching reverse proxy for package indexes (packages cached, indexes kept fresh) |
| `cache.<domain>` | Generic `/<scheme>/<host>/<path>` caching proxy |

### Highlights
- **Decoupled buffering cache** (`cache.py`): upstream fetch paced by the server,
  not the client; concurrent readers share one fill; LRU eviction by size.
- **Docker**: resolves the `WWW-Authenticate: Bearer` challenge and fetches a
  token using configured credentials (a PAT for private ghcr), caches by digest.
- **GitHub token aliases**: `?token=team` is swapped server-side for a real PAT,
  so users share a word instead of pasting the org token.
- **Private GitHub releases**: a `releases/download/<tag>/<asset>` URL is
  translated to the API asset endpoint (the only way a PAT can fetch a private
  asset) and streamed back — the simple URL "just works" for private repos.

## Run

```bash
pip install -r requirements.txt        # aiohttp, PyYAML
cp config.example.yaml config.yaml     # edit upstreams; secrets via ${ENV}
GHCR_USER=… GHCR_PAT=… GITHUB_PAT=… PYTHONPATH=src python -m proxyhub -c config.yaml
# or: docker build -t proxyhub . && docker run -p 8080:8080 -v cache:/var/cache/proxyhub proxyhub
```

It speaks plain HTTP on `:8080` — put it behind Caddy/nginx for TLS, exactly
like the rest of the stack. Routing is by `Host` header.

### Examples
```bash
# docker (point daemon or pull explicitly)
docker pull hub.docker.proxies.live/library/nginx

# github raw / private release with a shared alias
curl "https://github.proxies.live/https://raw.githubusercontent.com/o/r/main/f"
wget "https://github.proxies.live/https://github.com/Org/Private/releases/download/v1/app.zip?token=team"

# conda / pytorch
conda config --set channel_alias https://conda.proxies.live
pip install torch --index-url https://torch.proxies.live/whl/cu121

# anything direct
curl https://cache.proxies.live/https/host/path/file.tgz
```

## Layout
```
src/proxyhub/
  cache.py            decoupled buffering disk cache + LRU
  config.py           YAML config (env interpolation)
  upstream.py         shared aiohttp client session
  server.py           Host-based router (aiohttp app)
  proxies/
    base.py           upstream->filler, filler->response helpers
    docker.py         Docker Registry v2 pull-through + bearer auth
    github.py         github proxy, token aliases, private release translation
    webcache.py       package-index mirror + generic url-prefix cache
tests/test_cache.py   cache behaviour (miss/hit, shared fill, passthrough)
```

## Status

Implemented and **live-tested**:

- **Cache core** — decoupled full-speed buffering, concurrent readers share one
  fill, LRU eviction, passthrough mode. (unit tests + live)
- **Docker pull-through** — bearer-token auth to upstream, blobs cached by
  digest, `HEAD` served from cache, `Range` requests passed through, CDN
  redirects followed with `Authorization` dropped cross-host.
- **GitHub, every connection type**
  - `git clone` smart-HTTP (GET `info/refs` + POST `git-upload-pack`)
  - raw / gist
  - source archives & codeload tarball/zipball (redirect-aware)
  - release assets — **public (direct) and private (API-asset translation)**
  - api.github.com, signed CDN hosts
  - token aliases (`?token=team`→PAT) and forwarded `Authorization` (private clone)
- **conda / pytorch** package mirrors and the **generic** url-prefix cache.
- **apt mirror** (`apt.<domain>/<host>/<path>`, apt-cacher-ng style): caches
  `*.deb`, passes indexes through fresh; reaches upstreams over https.
- **Range / partial content**: cached objects serve `206` with `Content-Range`;
  a ranged miss still fills the whole object and serves the slice.
- **`/status`**: JSON metrics — uptime, routes, request counts, cache
  hits/misses/hit-rate/bytes/files/usage.
- **Persistent LRU index** (`.index.json`): eviction pops the least-recently-used
  entry; survives restart (no full tree walk).

Everything above is unit-tested and live-tested. Possible future work: ETag/
conditional revalidation for indexes, and a Prometheus `/metrics` exposition.
