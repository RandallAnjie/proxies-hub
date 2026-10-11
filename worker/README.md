# proxies-hub worker (RandallFlare / workerd)

Stateless Cloudflare-Workers-compatible port of the Python `all.<domain>`
entrypoint. One hostname, path-dispatched. The Python implementation is
unchanged; this directory is what RandallFlare builds and runs.

## Build

RandallFlare (and CI) should run:

```bash
cd worker
npm ci
npm run build
```

**Output:** `worker/dist/worker.js` — a single ES-module bundle.

```js
export default {
  async fetch(request, env, ctx) { /* … */ }
}
```

Local checks:

```bash
npm test                 # unit tests + workerd GET/HEAD/Range against built worker.js
npm run test:workerd     # real workerd only (`npx wrangler@4 dev --local`)
npm run test:integration # live docker/pypi/git/crates (needs egress)
npm start                # Node host on :8787 with an in-memory Cache
npx wrangler@4 dev       # real workerd, if you have wrangler
```

`wrangler.toml` is only for that local workerd smoke. Deploy does not need it.

## Runtime

- **workerd** APIs used: `fetch`, `Request`/`Response`/`Headers`, `ReadableStream` /
  `TransformStream`, `caches.default`, `crypto` (no DigestStream yet).
- **Memory:** stream bodies; never buffer multi-GB objects. `caches.default` is
  only used for objects with a known `Content-Length` ≤ 16 MiB.
- **TTFB:** response headers start after the first upstream header (auth + first
  Range). Streaming has no wall-clock cap.
- **Large objects:** sequential 128 MiB `Range` chunks, stitched into one
  response with `Content-Length`. Mid-stream docker `401` refreshes the bearer
  token and resumes the same offset. Client `Range` is honoured (`206`).
- **Cache:** `caches.default` only, never non-200. Immutable blobs/files and
  digest-addressed manifests when small; indexes stored long enough to serve
  **stale-if-error** on `5xx`/`429`, always ETag-revalidated. Do **not** rely on
  this for multi-GB layers (per-node ~2 GB cap) — that is step 2 (R2 + DOs).

## Routing (this host only)

| Path | Upstream |
| --- | --- |
| `/v2` | local docker ping |
| `/v2/<registry>/…` | public docker/OCI: `hub`, `ghcr`, `gcr`, `k8s-gcr`, `k8s`, `quay`, `mcr`, `elastic`, `nvcr`, `ollama` |
| `/github/…` | GitHub smart-HTTP, raw, archives, releases |
| `/pypi/index/…` `/pypi/simple/…` | PyPI simple index (file links rewritten) |
| `/pypi/files/…` | `files.pythonhosted.org` |
| `/crates/…` | cargo sparse (`config.json` `dl` rewritten) |
| `/npm` `/conda` `/torch` `/goproxy` `/hf` `/maven` `/gmaven` `/gradle` `/apk` | package mirrors |
| `/apt/<host>/<path>` | apt/rpm/apk host-in-path |
| `/cache/<scheme>/<host>/<path>` | generic cache |
| `/docs` | Markdown for curl/wget/empty-UA; HTML for browsers |
| anything else | 404 + help text |

No per-service subdomains. No private/credentialed docker sources.

Upstreams live in [`src/config.ts`](src/config.ts) (same public set as
`config.default.yaml`).

## Env / secrets

| Binding | Required | Purpose |
| --- | --- | --- |
| `GITHUB_PAT` | no | Value for the `team` token alias (`?token=team` or Basic username/password `team`). Without it, GitHub is public-only (a raw `?token=<pat>` still works). |

No D1 / R2 / KV / Durable Object bindings in step 1.

## Client examples

```bash
docker pull <host>/hub/library/nginx
ollama pull <host>/ollama/library/llama3
pip install -i https://<host>/pypi/index/ requests
git clone https://<host>/github/github.com/<u>/<r>
# cargo: index = "sparse+https://<host>/crates/"
npm config set registry https://<host>/npm
```

See `/docs` on a running worker for the full all-style cheat sheet.
