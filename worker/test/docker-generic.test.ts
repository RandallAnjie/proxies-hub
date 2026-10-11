import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createHandler,
  hostAllowed,
  MemoryCache,
  parseRegistryHost,
  resetDockerAuth,
  rewriteScopeFromClient,
  rewriteScopeToClient,
} from "../src/index";

const DIGEST = "sha256:" + "ab".repeat(32);
const MANIFEST = JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.manifest.v1+json",
});

class CountingCache extends MemoryCache {
  puts = 0;
  matches = 0;
  override async match(request: RequestInfo | URL, options?: CacheQueryOptions): Promise<Response | undefined> {
    this.matches += 1;
    return super.match(request, options);
  }
  override async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.puts += 1;
    return super.put(request, response);
  }
}

function basic(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

describe("registry host validation", () => {
  it("accepts public hostnames and ports", () => {
    assert.equal(parseRegistryHost("ghcr.io").ok, true);
    assert.equal(parseRegistryHost("release.cloudreve.org").ok, true);
    assert.equal(parseRegistryHost("reg.example.com:5000").ok, true);
    const port = parseRegistryHost("reg.example.com:5000");
    assert.equal(port.ok && port.host, "reg.example.com:5000");
    assert.equal(parseRegistryHost("8.8.8.8").ok, true);
  });

  it("rejects SSRF targets and userinfo", () => {
    for (const h of [
      "127.0.0.1",
      "127.0.0.1:5000",
      "localhost",
      "foo.localhost",
      "intranet",
      "192.168.1.1",
      "10.0.0.1",
      "172.16.0.5",
      "169.254.169.254",
      "100.64.1.1",
      "[::1]",
      "[fe80::1]",
      "[fd00::1]",
      "[::ffff:127.0.0.1]",
      "user@ghcr.io",
      "https://ghcr.io",
      "ghcr.io/evil",
      "not_a_host",
    ]) {
      const r = parseRegistryHost(h);
      assert.equal(r.ok, false, h);
    }
  });

  it("honours allowlists and wildcards", () => {
    assert.equal(hostAllowed("ghcr.io", undefined), true);
    assert.equal(hostAllowed("ghcr.io", ""), true);
    assert.equal(hostAllowed("ghcr.io", "ghcr.io,quay.io"), true);
    assert.equal(hostAllowed("evil.example", "ghcr.io,quay.io"), false);
    assert.equal(hostAllowed("k8s.gcr.io", "*.gcr.io"), true);
    assert.equal(hostAllowed("gcr.io", "*.gcr.io"), false);
    assert.equal(hostAllowed("anything.io", "*"), true);
  });

  it("translates client-visible scopes", () => {
    assert.equal(
      rewriteScopeToClient("repository:owner/img:pull", "r/ghcr.io"),
      "repository:r/ghcr.io/owner/img:pull",
    );
    assert.equal(
      rewriteScopeFromClient("repository:r/ghcr.io/owner/img:pull", "r/ghcr.io"),
      "repository:owner/img:pull",
    );
    assert.equal(
      rewriteScopeFromClient("repository:ghcr/owner/img:pull,push", "ghcr"),
      "repository:owner/img:pull,push",
    );
  });
});

describe("generic /r/ Basic registry", () => {
  it("returns a Basic challenge, then forwards client credentials", async () => {
    resetDockerAuth();
    const calls: { url: string; auth: string | null }[] = [];
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, auth: headers.get("Authorization") });
      if (url.startsWith("https://release.cloudreve.org/")) {
        if (headers.get("Authorization") === basic("alice", "s3cret")) {
          return new Response(MANIFEST, {
            status: 200,
            headers: {
              "Content-Type": "application/vnd.oci.image.manifest.v1+json",
              "Content-Length": String(MANIFEST.length),
            },
          });
        }
        return new Response(null, {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="https://release.cloudreve.org/v2/"' },
        });
      }
      return new Response(`unexpected ${url}`, { status: 599 });
    };
    const handle = createHandler({ fetch: fetchFn, cache: new MemoryCache() });

    const anon = await handle(
      new Request("https://ph.test/v2/r/release.cloudreve.org/cloudreve/pro/manifests/latest"),
    );
    assert.equal(anon.status, 401);
    const www = anon.headers.get("WWW-Authenticate") || "";
    assert.match(www, /^Basic realm="https:\/\/ph\.test\/v2\/"$/);
    assert.equal(anon.headers.get("Docker-Distribution-Api-Version"), "registry/2.0");

    const ok = await handle(
      new Request("https://ph.test/v2/r/release.cloudreve.org/cloudreve/pro/manifests/latest", {
        headers: { Authorization: basic("alice", "s3cret") },
      }),
    );
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal(await ok.text(), MANIFEST);
    assert.ok(calls.some((c) => c.auth === basic("alice", "s3cret")));
    assert.ok(calls.every((c) => c.auth !== "s3cret"));
  });
});

describe("generic /r/ Bearer registry", () => {
  it("rewrites the challenge, brokers a token, and translates scope", async () => {
    resetDockerAuth();
    const tokenCalls: { url: string; auth: string | null }[] = [];
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.startsWith("https://harbor.example/v2/")) {
        if (headers.get("Authorization") === "Bearer upstream-tok") {
          return new Response(MANIFEST, {
            status: 200,
            headers: {
              "Content-Type": "application/vnd.oci.image.manifest.v1+json",
              "Content-Length": String(MANIFEST.length),
            },
          });
        }
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate":
              'Bearer realm="https://harbor.example/service/token",service="harbor.example",scope="repository:org/app:pull"',
          },
        });
      }
      if (url.startsWith("https://harbor.example/service/token")) {
        tokenCalls.push({ url, auth: headers.get("Authorization") });
        const u = new URL(url);
        assert.equal(u.searchParams.get("service"), "harbor.example");
        assert.equal(u.searchParams.get("scope"), "repository:org/app:pull");
        if (headers.get("Authorization") === basic("bob", "tok")) {
          return Response.json({ token: "upstream-tok" });
        }
        return new Response(null, { status: 401 });
      }
      return new Response(`unexpected ${url}`, { status: 599 });
    };
    const handle = createHandler({ fetch: fetchFn, cache: new MemoryCache() });

    const denied = await handle(
      new Request("https://ph.test/v2/r/harbor.example/org/app/manifests/latest"),
    );
    assert.equal(denied.status, 401);
    const www = denied.headers.get("WWW-Authenticate") || "";
    assert.match(www, /Bearer /);
    assert.match(www, /realm="https:\/\/ph\.test\/token\/r\/harbor.example"/);
    assert.match(www, /scope="repository:r\/harbor.example\/org\/app:pull"/);
    assert.doesNotMatch(www, /harbor\.example\/service\/token/);

    const tok = await handle(
      new Request(
        "https://ph.test/token/r/harbor.example?service=harbor.example&scope=repository:r/harbor.example/org/app:pull",
        { headers: { Authorization: basic("bob", "tok") } },
      ),
    );
    assert.equal(tok.status, 200, await tok.clone().text());
    assert.equal(tok.headers.get("Cache-Control"), "no-store");
    const body = (await tok.json()) as { token: string };
    assert.equal(body.token, "upstream-tok");
    assert.ok(tokenCalls.some((c) => c.auth === basic("bob", "tok")));
    const last = tokenCalls[tokenCalls.length - 1];
    assert.equal(last?.auth, basic("bob", "tok"));
    assert.match(last?.url || "", /scope=repository%3Aorg%2Fapp%3Apull|scope=repository:org\/app:pull/);

    const pull = await handle(
      new Request("https://ph.test/v2/r/harbor.example/org/app/manifests/latest", {
        headers: { Authorization: "Bearer upstream-tok" },
      }),
    );
    assert.equal(pull.status, 200);
    assert.equal(await pull.text(), MANIFEST);
  });

  it("anonymous /r/ pull uses the existing token dance", async () => {
    resetDockerAuth();
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.startsWith("https://ghcr.io/v2/") && !headers.get("Authorization")) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
          },
        });
      }
      if (url.startsWith("https://ghcr.io/token")) {
        const u = new URL(url);
        assert.equal(u.searchParams.get("scope"), "repository:jqlang/jq:pull");
        assert.equal(headers.get("Authorization"), null);
        return Response.json({ token: "anon-tok" });
      }
      if (url.includes("/v2/jqlang/jq/manifests/latest") && headers.get("Authorization") === "Bearer anon-tok") {
        return new Response(MANIFEST, {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.oci.image.manifest.v1+json",
            "Content-Length": String(MANIFEST.length),
          },
        });
      }
      return new Response(`unexpected ${url}`, { status: 599 });
    };
    const handle = createHandler({ fetch: fetchFn, cache: new MemoryCache() });
    const r = await handle(new Request("https://ph.test/v2/r/ghcr.io/jqlang/jq/manifests/latest"));
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(r.headers.get("WWW-Authenticate"), null);
    assert.equal(await r.text(), MANIFEST);
  });

  it("pulls a multi-level repo by digest and a blob", async () => {
    resetDockerAuth();
    const bytes = "LAYERDATA";
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.startsWith("https://ghcr.io/v2/") && !headers.get("Authorization")) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
          },
        });
      }
      if (url.startsWith("https://ghcr.io/token")) {
        return Response.json({ token: "d-tok" });
      }
      if (url.includes(`/v2/a/b/c/manifests/${DIGEST}`) && headers.get("Authorization") === "Bearer d-tok") {
        return new Response(MANIFEST, {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.oci.image.manifest.v1+json",
            "Content-Length": String(MANIFEST.length),
          },
        });
      }
      if (url.includes(`/v2/a/b/c/blobs/${DIGEST}`)) {
        const rng = headers.get("Range");
        if (rng) {
          return new Response(bytes, {
            status: 206,
            headers: {
              "Content-Range": `bytes 0-${bytes.length - 1}/${bytes.length}`,
              "Content-Length": String(bytes.length),
            },
          });
        }
        return new Response(bytes, {
          status: 200,
          headers: { "Content-Length": String(bytes.length) },
        });
      }
      return new Response(`unexpected ${url}`, { status: 599 });
    };
    const handle = createHandler({ fetch: fetchFn, cache: new MemoryCache(), rangeChunk: 64 });
    const man = await handle(new Request(`https://ph.test/v2/r/ghcr.io/a/b/c/manifests/${DIGEST}`));
    assert.equal(man.status, 200);
    assert.equal(man.headers.get("Docker-Content-Digest"), DIGEST);

    const blob = await handle(new Request(`https://ph.test/v2/r/ghcr.io/a/b/c/blobs/${DIGEST}`));
    assert.equal(blob.status, 200);
    assert.equal(blob.headers.get("Content-Length"), String(bytes.length));
    assert.equal(blob.headers.get("Docker-Content-Digest"), DIGEST);
    assert.equal(await blob.text(), bytes);
  });
});

describe("authenticated docker is never cached", () => {
  it("skips cache match/put when the client sent credentials", async () => {
    resetDockerAuth();
    let upstream = 0;
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.startsWith("https://ghcr.io/v2/") && !headers.get("Authorization")) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
          },
        });
      }
      if (url.startsWith("https://ghcr.io/token")) {
        return Response.json({ token: headers.get("Authorization") ? "priv-tok" : "anon-tok" });
      }
      if (url.includes(`/blobs/${DIGEST}`)) {
        upstream += 1;
        const body = "SECRET";
        return new Response(body, {
          status: 200,
          headers: { "Content-Length": String(body.length) },
        });
      }
      return new Response(`unexpected ${url}`, { status: 599 });
    };
    const cache = new CountingCache();
    const handle = createHandler({ fetch: fetchFn, cache, rangeChunk: 64 });

    const auth = await handle(
      new Request(`https://ph.test/v2/r/ghcr.io/priv/img/blobs/${DIGEST}`, {
        headers: { Authorization: basic("u", "p") },
      }),
    );
    assert.equal(auth.status, 200);
    assert.equal(await auth.text(), "SECRET");
    assert.equal(auth.headers.get("Cache-Control"), "no-store");
    assert.equal(cache.puts, 0);
    assert.equal((await cache.keys()).length, 0);

    const anon = await handle(new Request(`https://ph.test/v2/r/ghcr.io/priv/img/blobs/${DIGEST}`));
    assert.equal(anon.status, 200);
    assert.notEqual(anon.headers.get("X-Proxyhub-Cache"), "HIT");
    assert.equal(upstream, 2);
  });
});

describe("fixed registries accept client credentials", () => {
  it("sends client Basic to the token realm for /v2/ghcr/…", async () => {
    resetDockerAuth();
    let tokenAuth: string | null = null;
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.startsWith("https://ghcr.io/v2/") && !headers.get("Authorization")) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
          },
        });
      }
      if (url.startsWith("https://ghcr.io/token")) {
        tokenAuth = headers.get("Authorization");
        if (tokenAuth === basic("gh", "pat")) return Response.json({ token: "priv" });
        return new Response(null, { status: 401 });
      }
      if (headers.get("Authorization") === "Bearer priv") {
        return new Response(MANIFEST, {
          status: 200,
          headers: { "Content-Length": String(MANIFEST.length) },
        });
      }
      return new Response(`unexpected ${url}`, { status: 599 });
    };
    const handle = createHandler({ fetch: fetchFn, cache: new MemoryCache() });
    const r = await handle(
      new Request("https://ph.test/v2/ghcr/owner/private/manifests/latest", {
        headers: { Authorization: basic("gh", "pat") },
      }),
    );
    assert.equal(r.status, 200);
    assert.equal(tokenAuth, basic("gh", "pat"));
    assert.equal(r.headers.get("Cache-Control"), "no-store");
  });

  it("still pulls public /v2/ghcr/… anonymously", async () => {
    resetDockerAuth();
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.startsWith("https://ghcr.io/v2/") && !headers.get("Authorization")) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
          },
        });
      }
      if (url.startsWith("https://ghcr.io/token")) {
        assert.equal(headers.get("Authorization"), null);
        return Response.json({ token: "pub" });
      }
      if (headers.get("Authorization") === "Bearer pub") {
        return new Response(MANIFEST, {
          status: 200,
          headers: { "Content-Length": String(MANIFEST.length) },
        });
      }
      return new Response(`unexpected ${url}`, { status: 599 });
    };
    const handle = createHandler({ fetch: fetchFn, cache: new MemoryCache() });
    const r = await handle(new Request("https://ph.test/v2/ghcr/jqlang/jq/manifests/latest"));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("Cache-Control"), null);
  });
});

describe("generic /r/ safety", () => {
  it("rejects SSRF hosts with 400 and does not fetch them", async () => {
    resetDockerAuth();
    let fetched = 0;
    const fetchFn = async () => {
      fetched += 1;
      return new Response("no", { status: 599 });
    };
    const handle = createHandler({ fetch: fetchFn, cache: new MemoryCache() });
    for (const host of ["127.0.0.1", "localhost", "192.168.0.5", "169.254.169.254", "[::1]", "intranet"]) {
      const r = await handle(new Request(`https://ph.test/v2/r/${host}/foo/manifests/latest`));
      assert.equal(r.status, 400, host);
      assert.match(await r.text(), /invalid registry host/);
    }
    assert.equal(fetched, 0);
  });

  it("enforces GENERIC_REGISTRY_ALLOWLIST", async () => {
    resetDockerAuth();
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.startsWith("https://ghcr.io/v2/") && !headers.get("Authorization")) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"',
          },
        });
      }
      if (url.startsWith("https://ghcr.io/token")) return Response.json({ token: "t" });
      if (headers.get("Authorization") === "Bearer t") {
        return new Response(MANIFEST, {
          status: 200,
          headers: { "Content-Length": String(MANIFEST.length) },
        });
      }
      return new Response(`unexpected ${url}`, { status: 599 });
    };
    const handle = createHandler({ fetch: fetchFn, cache: new MemoryCache() });
    const env = { GENERIC_REGISTRY_ALLOWLIST: "ghcr.io,*.ok.example" };

    const denied = await handle(
      new Request("https://ph.test/v2/r/evil.example/foo/manifests/latest"),
      env,
    );
    assert.equal(denied.status, 403);
    assert.match(await denied.text(), /not allowlisted/);

    const ok = await handle(
      new Request("https://ph.test/v2/r/ghcr.io/jqlang/jq/manifests/latest"),
      env,
    );
    assert.equal(ok.status, 200, await ok.clone().text());

    const wild = await handle(
      new Request("https://ph.test/v2/r/a.ok.example/foo/manifests/latest"),
      env,
    );
    assert.notEqual(wild.status, 403);
  });
});
