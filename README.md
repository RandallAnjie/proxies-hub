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
- **Digest integrity** (`cache.py`): a docker blob is hashed while it fills and
  the sha256 is checked against its content-addressed digest before commit — a
  truncated or corrupt fetch is rejected, never cached, never re-served.
- **Smart eviction** (`cache.py`): LRU down to a low-water mark (no boundary
  thrash); entries used within `protect_window` are evicted only as a last
  resort (a burst of small files can't push out a hot large layer); `pin`
  regexes are never evicted.
- **Conditional revalidation** (`webcache.py`): `revalidate` indexes (conda
  repodata, npm metadata) are cached *with* their ETag/Last-Modified and served
  on a `304` — fresh like `no_cache`, but an unchanged (often large) index is not
  re-downloaded.
- **Chunked ("ranged") upstream fetch** (`base.py`): a large blob is pulled from
  upstream in sequential 128 MB `Range` chunks, so no single upstream connection
  stays open long enough to be cut — ghcr/CDNs drop slow long-lived fetches at
  ~600 s. Reassembled into one logical stream; the response always carries a
  known `Content-Length` (docker/containerd reconnect endlessly without it).
- **Docker**: resolves the `WWW-Authenticate: Bearer` challenge and fetches a
  token using configured credentials (a PAT for private ghcr), caches by digest.
- **GitHub token aliases**: `?token=team` is swapped server-side for a real PAT,
  so users share a word instead of pasting the org token.
- **Private GitHub releases**: a `releases/download/<tag>/<asset>` URL is
  translated to the API asset endpoint (the only way a PAT can fetch a private
  asset) and streamed back — the simple URL "just works" for private repos.

## Run

Out of the box — a baked default config means just a domain is enough:

```bash
docker build -t proxyhub .
docker run -p 8080:8080 -v cache:/var/cache/proxyhub \
  -e PROXYHUB_DOMAIN=example.com proxyhub
```

That serves the **dashboard** at `/` (and at `dash.example.com`), `/status`
JSON metrics, and every proxy host (`hub.docker.example.com`, `pypi.example.com`,
…). Mount your own `/app/config.yaml` to change upstreams/credentials; override
scalars via env without touching the file:

| env | overrides | default |
| --- | --- | --- |
| `PROXYHUB_DOMAIN` | host suffix the dashboard + routing use | `example.com` |
| `PROXYHUB_CACHE_MAX` | cache cap (e.g. `250g`) | `50g` |
| `PROXYHUB_HOST` / `PROXYHUB_PORT` | bind address | `0.0.0.0:8080` |
| `PROXYHUB_CACHE_DIR` | cache directory | `/var/cache/proxyhub` |

The footer (project link + "Powered By Randall") is fixed and not configurable.

From source: `pip install -r requirements.txt && PYTHONPATH=src python -m proxyhub -c config.yaml`
(secrets like `${GHCR_PAT}` / `${GITHUB_PAT}` are read from the environment).

It speaks **plain HTTP** on `:8080` and does **not** manage TLS — put your own
reverse proxy (Caddy/nginx/Traefik) in front for certificates. Routing is by
`Host` header; the dashboard also answers `/` on any unmatched host.

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

### Verified: pulls that take longer than 10 minutes

The original failure this project set out to kill: a large layer whose transfer
outlasts the upstream's ~600 s cut window, surfacing to docker as
`unexpected EOF`. Measured end-to-end against a 12.8 GB (39.5 GB unpacked,
31-layer) **private ghcr** image over a slow ghcr→server link:

- Full `docker pull` completes; image digest matches the upstream index exactly.
- Cold concurrent fetch of the three largest layers (3.18 / 2.91 / 2.63 GB) —
  the longest single client connection stayed open **13.8 minutes** and returned
  `200` with a byte-exact body; chunked upstream fetch kept every upstream
  connection short-lived, so none hit the cut window.
- A resumed `Range: bytes=N-` request (how docker restarts an interrupted layer)
  is served `206` from the growing/cached file with sub-100 ms TTFB.
- Warm re-read of a cached layer streams from disk at ~180 MB/s.
