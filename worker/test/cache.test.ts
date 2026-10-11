import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHandler, MemoryCache, resetDockerAuth } from "../src/index";
import { wrapCache } from "../src/safe-cache";

class ThrowingCache implements Cache {
  matches = 0;
  puts = 0;
  deletes = 0;
  constructor(private readonly message = "No Cache was configured") {}
  async match(): Promise<Response | undefined> {
    this.matches += 1;
    throw new Error(this.message);
  }
  async matchAll(): Promise<readonly Response[]> {
    throw new Error(this.message);
  }
  async put(): Promise<void> {
    this.puts += 1;
    throw new Error(this.message);
  }
  async delete(): Promise<boolean> {
    this.deletes += 1;
    throw new Error(this.message);
  }
  async keys(): Promise<readonly Request[]> {
    return [];
  }
  async add(): Promise<void> {
    throw new Error(this.message);
  }
  async addAll(): Promise<void> {
    throw new Error(this.message);
  }
}

function bytes(body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain",
      "Content-Length": String(body.length),
      ...extra,
    },
  });
}

describe("caches.default policy", () => {
  it("never stores a non-200", async () => {
    let n = 0;
    const fetchFn = async () => {
      n += 1;
      return new Response("nope", { status: 503, headers: { "Content-Length": "4" } });
    };
    const cache = new MemoryCache();
    const handle = createHandler({ fetch: fetchFn, cache });
    assert.equal((await handle(new Request("https://ph.test/crates/se/rd/serde"))).status, 503);
    assert.equal((await handle(new Request("https://ph.test/crates/se/rd/serde"))).status, 503);
    assert.equal(n, 2);
  });

  it("serves stale-if-error for a revalidated index", async () => {
    let n = 0;
    const body = '{"name":"serde"}\n';
    const fetchFn = async (_input: RequestInfo | URL, init?: RequestInit) => {
      n += 1;
      const headers = new Headers(init?.headers);
      if (n === 1) {
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "text/plain",
            "Content-Length": String(body.length),
            ETag: '"e1"',
          },
        });
      }
      assert.equal(headers.get("If-None-Match"), '"e1"');
      return new Response("upstream down", { status: 502 });
    };
    const cache = new MemoryCache();
    const handle = createHandler({ fetch: fetchFn, cache });
    const a = await handle(new Request("https://ph.test/crates/se/rd/serde"));
    assert.equal(a.status, 200);
    assert.equal(await a.text(), body);
    const b = await handle(new Request("https://ph.test/crates/se/rd/serde"));
    assert.equal(b.status, 200);
    assert.equal(b.headers.get("X-Proxyhub-Cache"), "STALE");
    assert.equal(await b.text(), body);
    assert.equal(n, 2);
  });

  it("uses 304 to keep the cached index", async () => {
    let n = 0;
    const body = "line\n";
    const fetchFn = async () => {
      n += 1;
      if (n === 1) {
        return new Response(body, {
          status: 200,
          headers: { "Content-Length": String(body.length), ETag: '"x"' },
        });
      }
      return new Response(null, { status: 304, headers: { ETag: '"x"' } });
    };
    const handle = createHandler({ fetch: fetchFn, cache: new MemoryCache() });
    await handle(new Request("https://ph.test/crates/se/rd/serde"));
    const b = await handle(new Request("https://ph.test/crates/se/rd/serde"));
    assert.equal(b.status, 200);
    assert.equal(await b.text(), body);
    assert.equal(b.headers.get("X-Proxyhub-Cache"), "REVALIDATED");
  });
});

describe("throwing Cache API is best-effort", () => {
  it("streams cached routes from upstream with status, headers, and Content-Length", async () => {
    resetDockerAuth();
    const cratesBody = '{"name":"serde"}\n';
    const pypiHtml =
      '<a href="https://files.pythonhosted.org/packages/aa/requests-2.0.tar.gz#sha256=abc">requests</a>';
    const npmJson = JSON.stringify({
      name: "left-pad",
      versions: {
        "1.0.0": { dist: { tarball: "https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz" } },
      },
    });
    const pom = "<project/>";
    const info = '{"Version":"v1.2.3","Time":"2024-01-01T00:00:00Z"}';
    const apk = "APKINDEX";
    const manifest = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json" });

    const fetchFn = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("index.crates.io/se/rd/serde")) {
        return bytes(cratesBody, { "Content-Type": "text/plain", ETag: '"s1"' });
      }
      if (url.includes("pypi.org/simple/requests")) {
        return bytes(pypiHtml, { "Content-Type": "text/html" });
      }
      if (url.includes("registry.npmjs.org/left-pad") && !url.includes(".tgz")) {
        return bytes(npmJson, { "Content-Type": "application/json" });
      }
      if (url.includes("repo1.maven.org/maven2/") && url.endsWith(".pom")) {
        return bytes(pom, { "Content-Type": "text/xml" });
      }
      if (url.includes("proxy.golang.org/") && url.endsWith(".info")) {
        return bytes(info, { "Content-Type": "application/json" });
      }
      if (url.includes("APKINDEX.tar.gz")) {
        return bytes(apk, { "Content-Type": "application/octet-stream" });
      }
      if (url.includes("registry-1.docker.io/v2/library/alpine/manifests/latest")) {
        return bytes(manifest, {
          "Content-Type": "application/vnd.oci.image.manifest.v1+json",
        });
      }
      return new Response(`unexpected ${url}`, { status: 599 });
    };

    const cache = new ThrowingCache();
    const handle = createHandler({ fetch: fetchFn, cache });

    const crates = await handle(new Request("https://ph.test/crates/se/rd/serde"));
    assert.equal(crates.status, 200);
    assert.equal(crates.headers.get("X-Proxyhub"), "1");
    assert.equal(crates.headers.get("Content-Length"), String(cratesBody.length));
    assert.equal(await crates.text(), cratesBody);
    assert.notEqual(crates.headers.get("X-Proxyhub-Cache"), "HIT");

    const pypi = await handle(new Request("https://ph.test/pypi/index/requests/"));
    assert.equal(pypi.status, 200);
    const pypiText = await pypi.text();
    assert.match(pypiText, /https:\/\/ph\.test\/pypi\/files\/packages\/aa\/requests-2\.0\.tar\.gz/);
    assert.doesNotMatch(pypiText, /files\.pythonhosted\.org/);
    assert.equal(pypi.headers.get("Content-Length"), String(new TextEncoder().encode(pypiText).byteLength));

    const npm = await handle(new Request("https://ph.test/npm/left-pad"));
    assert.equal(npm.status, 200);
    const npmText = await npm.text();
    assert.match(npmText, /https:\/\/ph\.test\/npm\/left-pad\/-\/left-pad-1\.0\.0\.tgz/);
    assert.doesNotMatch(npmText, /registry\.npmjs\.org/);
    assert.equal(npm.headers.get("Content-Length"), String(new TextEncoder().encode(npmText).byteLength));

    const maven = await handle(
      new Request("https://ph.test/maven/org/example/lib/1.0/lib-1.0.pom"),
    );
    assert.equal(maven.status, 200);
    assert.equal(maven.headers.get("Content-Length"), String(pom.length));
    assert.equal(await maven.text(), pom);

    const goproxy = await handle(
      new Request("https://ph.test/goproxy/github.com/foo/bar/@v/v1.2.3.info"),
    );
    assert.equal(goproxy.status, 200);
    assert.equal(goproxy.headers.get("Content-Length"), String(info.length));
    assert.equal(await goproxy.text(), info);

    const apkIdx = await handle(
      new Request("https://ph.test/apk/alpine/v3.20/main/x86_64/APKINDEX.tar.gz"),
    );
    assert.equal(apkIdx.status, 200);
    assert.equal(apkIdx.headers.get("Content-Length"), String(apk.length));
    assert.equal(await apkIdx.text(), apk);

    const docker = await handle(
      new Request("https://ph.test/v2/hub/library/alpine/manifests/latest", {
        headers: { Accept: "application/vnd.oci.image.manifest.v1+json" },
      }),
    );
    assert.equal(docker.status, 200, await docker.clone().text());
    assert.equal(docker.headers.get("X-Proxyhub"), "1");
    assert.equal(await docker.text(), manifest);
  });

  it("honours a client Range as 206 with Content-Length and Content-Range", async () => {
    const total = 10000;
    const slice = "R".repeat(1024);
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      assert.match(url, /download\.pytorch\.org\/whl\/cpu\/torch-2\.5\.1(?:\+|%2B)cpu-cp312-cp312-linux_x86_64\.whl/);
      assert.equal(headers.get("Range"), "bytes=0-1023");
      return new Response(slice, {
        status: 206,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": "1024",
          "Content-Range": `bytes 0-1023/${total}`,
          "Accept-Ranges": "bytes",
        },
      });
    };
    const handle = createHandler({
      fetch: fetchFn,
      cache: new ThrowingCache(),
      rangeChunk: 1024,
    });
    const r = await handle(
      new Request(
        "https://ph.test/torch/whl/cpu/torch-2.5.1%2Bcpu-cp312-cp312-linux_x86_64.whl",
        { headers: { Range: "bytes=0-1023" } },
      ),
    );
    assert.equal(r.status, 206);
    assert.equal(r.headers.get("X-Proxyhub"), "1");
    assert.equal(r.headers.get("Content-Length"), "1024");
    assert.equal(r.headers.get("Content-Range"), `bytes 0-1023/${total}`);
    assert.equal(r.headers.get("Accept-Ranges"), "bytes");
    assert.equal(await r.text(), slice);
  });

  it("HEAD on an immutable object falls through to upstream", async () => {
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method || "GET").toUpperCase();
      assert.equal(method, "HEAD");
      assert.match(String(input), /files\.pythonhosted\.org\/packages\/aa\/foo\.whl/);
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": "42",
        },
      });
    };
    const handle = createHandler({ fetch: fetchFn, cache: new ThrowingCache() });
    const r = await handle(
      new Request("https://ph.test/pypi/files/packages/aa/foo.whl", { method: "HEAD" }),
    );
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("Content-Length"), "42");
    assert.equal(r.headers.get("X-Proxyhub"), "1");
    assert.equal(await r.text(), "");
  });

  it("revalidate does not invent stale when match throws; upstream 503 is passed through", async () => {
    const fetchFn = async () => new Response("nope", { status: 503, headers: { "Content-Length": "4" } });
    const handle = createHandler({ fetch: fetchFn, cache: new ThrowingCache() });
    const r = await handle(new Request("https://ph.test/crates/se/rd/serde"));
    assert.equal(r.status, 503);
    assert.equal(await r.text(), "nope");
  });

  it("logs the first cache error once and stops calling a cache that keeps failing", async () => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    };
    try {
      const cache = new ThrowingCache();
      let fetches = 0;
      const fetchFn = async () => {
        fetches += 1;
        return bytes("idx\n", { ETag: '"x"' });
      };
      const handle = createHandler({ fetch: fetchFn, cache });
      for (let i = 0; i < 4; i++) {
        const r = await handle(new Request("https://ph.test/crates/se/rd/serde"));
        assert.equal(r.status, 200);
        assert.equal(await r.text(), "idx\n");
      }
      assert.equal(fetches, 4);
      assert.equal(cache.matches, 1, "circuit-break after the first hard cache failure");
      assert.equal(cache.puts, 0, "put skipped once match has already disabled the cache");
      assert.equal(warns.length, 1);
      assert.match(warns[0], /No Cache was configured/);
    } finally {
      console.warn = orig;
    }
  });

  it("survives a broken globalThis.caches.default (RandallFlare production path)", async () => {
    const g = globalThis as typeof globalThis & { caches?: { default?: Cache } };
    const prev = g.caches;
    const native = new ThrowingCache();
    g.caches = { default: native };
    try {
      const body = '{"name":"serde"}\n';
      const fetchFn = async () => bytes(body, { "Content-Type": "application/json" });
      const handle = createHandler({ fetch: fetchFn });
      const r = await handle(new Request("https://ph.test/crates/se/rd/serde"));
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("Content-Length"), String(body.length));
      assert.equal(await r.text(), body);
      assert.ok(native.matches >= 1);
    } finally {
      if (prev) g.caches = prev;
      else delete g.caches;
    }
  });

  it("does not disable a working cache when only put rejects", async () => {
    const store = new MemoryCache();
    let matches = 0;
    let puts = 0;
    const cache: Cache = {
      async match(req, opts) {
        matches += 1;
        return store.match(req, opts);
      },
      async put() {
        puts += 1;
        throw new Error("Cache put rejected: 20971520 exceeds 16777216");
      },
      delete: (req, opts) => store.delete(req, opts),
      matchAll: (req, opts) => store.matchAll(req, opts),
      keys: (req, opts) => store.keys(req, opts),
      add: (req) => store.add(req),
      addAll: (reqs) => store.addAll(reqs),
    };
    const handle = createHandler({
      fetch: async () => bytes('{"name":"serde"}\n', { ETag: '"e"' }),
      cache,
    });
    assert.equal((await handle(new Request("https://ph.test/crates/se/rd/serde"))).status, 200);
    assert.equal((await handle(new Request("https://ph.test/crates/se/rd/serde"))).status, 200);
    assert.equal(matches, 2, "oversized put must not circuit-break later matches");
    assert.equal(puts, 2);
  });

  it("wrapCache match/put/delete never throw", async () => {
    const inner = new ThrowingCache("boom");
    const cache = wrapCache(inner);
    assert.equal(await cache.match(new Request("https://ph.cache/k")), undefined);
    await cache.put(new Request("https://ph.cache/k"), new Response("x"));
    assert.equal(await cache.delete(new Request("https://ph.cache/k")), false);
  });
});
