# proxyhub

English · [中文](README.zh.md)

A single, hackable **Python** pull-through mirror proxy that replaces a stack of
nginx + distribution-registry + ghproxy with one codebase. Built async on
aiohttp around one core idea — a **decoupled full-speed buffering cache**: an
uncached object is fetched from upstream at server speed by one background task
while any number of (possibly slow) clients stream from the growing file, so a
slow client can never cause an upstream connection to time out mid-transfer.

## What it proxies

| Host (`domain = proxies.live`) | Backend |
| --- | --- |
| `hub / ghcr / gcr / k8s / k8s-gcr / quay / mcr / elastic / nvcr / ollama` `.docker.<domain>` | Docker Registry v2 / OCI pull-through (token auth, blobs+manifests cached by digest & deduped) |
| `github.<domain>` | GitHub: clone / raw / release, token aliases, **private release downloads** |
| `npm / pypi / conda / torch / goproxy / hf / crates / maven / gmaven / gradle .<domain>` | Language & AI package mirrors (files cached, indexes revalidated) |
| `apt.<domain>/<host>/<path>` | `apt` host-in-path — caches `.deb` / `.rpm` / `.apk` (Debian, EPEL/Rocky/Fedora, Alpine) |
| `cache.<domain>/<scheme>/<host>/<path>` | Generic direct-file caching proxy |
| **`all.<domain>/<service>/…`** | **One host, path-dispatched** — everything above through a single domain |

## Highlights

- **Decoupled buffering cache** (`cache.py`): upstream fetch paced by the server,
  not the client; concurrent readers share one fill; LRU eviction by size.
- **Chunked ("ranged") upstream fetch** (`base.py`): a large blob is pulled in
  sequential 128 MB `Range` chunks, so no single upstream connection stays open
  long enough to be cut — ghcr/CDNs drop slow long-lived fetches at ~600 s. The
  response always carries a known `Content-Length` (docker reconnects forever
  without it). On a mid-transfer `401` it refreshes the token and continues from
  the current offset (a multi-GB layer can outlive its token).
- **Content-addressed dedup**: docker **blobs and by-digest manifests** are keyed
  by their sha256 alone, so a layer shared across repos/registries is stored
  once. By-tag manifests are revalidated with `If-None-Match` (`304` → cached).
- **Digest integrity**: a blob is hashed while it fills and checked against its
  digest before commit — a truncated/corrupt fetch is never cached.
- **Smart eviction**: LRU to a low-water mark (no boundary thrash); entries used
  within `protect_window` are evicted only as a last resort; `pin` regexes never
  evicted. Abandoned `.part`/`.rv` partials are swept on startup and every 10 min.
- **Conditional revalidation** (`webcache.py`): big-but-stable indexes (conda
  repodata, npm metadata, cargo index) are cached *with* their ETag and served
  on a `304` — fresh, but unchanged indexes aren't re-downloaded.
- **GitHub**: every connection type (git clone smart-HTTP, raw, archives, release
  assets), `?token=alias` swapped server-side for a real PAT, and private
  releases translated to the API asset endpoint so the plain URL just works.

## All-in-one entrypoint

`all.<domain>` routes by the **first path segment**, so you don't need to
remember a subdomain per service:

```bash
docker pull all.proxies.live/hub/library/nginx      # -> /v2/hub/... , hub = selector
pip install -i https://all.proxies.live/pypi/index/ requests
git clone https://all.proxies.live/github/github.com/<u>/<r>
# cargo index = "sparse+https://all.proxies.live/crates/"
```

Docker works naturally because `docker pull all.<domain>/hub/x` produces
`/v2/hub/…`. **Private** docker sources (those with stored credentials) are *not*
exposed on `all` — they stay on their own basic-auth'd subdomain — so `all` can
be open.

## Dashboard & docs

- `https://dash.<domain>/` — **monitoring**: 10-min hit rate, hourly hit-rate
  chart, cache usage, per-service breakdown, and end-to-end **domain probing**
  (done in the browser, the real client — reflects true public availability).
- `https://dash.<domain>/docs` — **usage docs**. HTML for browsers (probe-driven,
  only lists domains you can actually reach; shows the dedicated + `all` form for
  each). **`curl`/`wget`/empty-UA get Markdown** (`text/markdown`).
- `/status` (JSON) and `/metrics` (Prometheus): uptime, requests, cache
  hits/misses/bytes/files, verify failures, revalidations, per-service labels.

```bash
curl dash.proxies.live/docs        # markdown docs in your terminal
```

## Run

Out of the box — a baked default config means just a domain is enough:

```bash
docker run -p 8080:8080 -v cache:/var/cache/proxyhub \
  -e PROXYHUB_DOMAIN=example.com ranjie/proxies
```

Mount your own `/app/config.yaml` to change upstreams/credentials; override
scalars via env without touching the file:

| env | overrides | default |
| --- | --- | --- |
| `PROXYHUB_DOMAIN` | host suffix for routing + dashboard | `example.com` |
| `PROXYHUB_CACHE_MAX` | cache cap (e.g. `250g`) | `50g` |
| `PROXYHUB_HOST` / `PROXYHUB_PORT` | bind address | `0.0.0.0:8080` |
| `PROXYHUB_CACHE_DIR` | cache directory | `/var/cache/proxyhub` |

From source: `pip install -r requirements.txt && PYTHONPATH=src python -m proxyhub -c config.yaml`
(secrets like `${GHCR_PAT}` / `${GITHUB_PAT}` are read from the environment).

It speaks **plain HTTP** on `:8080` and does **not** manage TLS — put your own
reverse proxy (Caddy/nginx/Traefik) in front for certificates. Routing is by
`Host` header. The footer (project link + "Powered By Randall") is fixed.

## Client config

```bash
docker pull hub.docker.proxies.live/library/nginx
docker login ghcr.docker.proxies.live && docker pull ghcr.docker.proxies.live/<o>/<i>   # private
ollama pull ollama.docker.proxies.live/library/llama3
npm config set registry https://npm.proxies.live
pip config set global.index-url https://pypi.proxies.live/index/
conda config --set channel_alias https://conda.proxies.live
pip install torch --index-url https://torch.proxies.live/whl/cu121
go env -w GOPROXY=https://goproxy.proxies.live,direct
export HF_ENDPOINT=https://hf.proxies.live
# Rust ~/.cargo/config.toml -> index = "sparse+https://crates.proxies.live/"
# Maven settings.xml <mirror><url>https://maven.proxies.live</url>
# Alpine /etc/apk/repositories -> https://apk.proxies.live/alpine/v3.19/main
# apt / rpm: prefix the upstream host with https://apt.proxies.live/
curl https://cache.proxies.live/https/host/path/file.tgz
```

## Layout

```
src/proxyhub/
  cache.py            decoupled buffering cache: dedup, integrity, LRU, revalidate, sweep
  config.py           YAML config (+ ${ENV} and PROXYHUB_* overrides)
  upstream.py         shared aiohttp client session
  server.py           Host router, dashboard/docs pages, /status, /metrics
  proxies/
    base.py           ranged/redirect upstream fillers, response helpers
    docker.py         Docker Registry v2 / OCI + bearer auth + manifest cache
    github.py         github proxy, token aliases, private release translation
    webcache.py       package-index mirror + generic url-prefix cache
    apt.py            apt/rpm/apk host-in-path mirror
    pypi.py           PyPI simple-index rewrite + file cache
    crates.py         Rust cargo sparse registry
    all.py            single-host path dispatcher
  static/             monitor.html + docs.html (dashboard templates)
tests/                cache, ranged fetch + token refresh, hourly/rolling history
```

CI runs `ruff` + `pytest`; images publish to Docker Hub (`ranjie/proxies`,
amd64 + arm64 built natively).

## Verified: pulls that take longer than 10 minutes

The original failure this project set out to kill: a large layer whose transfer
outlasts the upstream's ~600 s cut window, surfacing to docker as
`unexpected EOF`. Measured end-to-end against a 12.8 GB (39.5 GB unpacked,
31-layer) **private ghcr** image over a slow ghcr→server link:

- Full `docker pull` completes; image digest matches the upstream index exactly.
- Cold concurrent fetch of the three largest layers (3.18 / 2.91 / 2.63 GB) —
  the longest single client connection stayed open **13.8 minutes** and returned
  `200` with a byte-exact body; chunked upstream fetch kept every upstream
  connection short-lived, so none hit the cut window.
- ghcr's CDN genuinely honours `Range` (verified `206` at arbitrary offsets);
  a resumed `Range: bytes=N-` is served `206` with sub-100 ms TTFB; warm re-read
  of a cached layer streams from disk at ~180 MB/s.
