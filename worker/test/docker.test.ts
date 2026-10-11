import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHandler, MemoryCache, resetDockerAuth } from "../src/index";

describe("docker bearer dance", () => {
  it("probes WWW-Authenticate, fetches a scope token, retries the manifest", async () => {
    resetDockerAuth();
    const calls: { url: string; method: string; auth: string | null; accept: string | null }[] = [];
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method: (init?.method || "GET").toUpperCase(),
        auth: headers.get("Authorization"),
        accept: headers.get("Accept"),
      });
      if (url.startsWith("https://registry-1.docker.io/") && !headers.get("Authorization")) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate":
              'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/probe:pull"',
          },
        });
      }
      if (url.startsWith("https://auth.docker.io/token")) {
        const u = new URL(url);
        assert.equal(u.searchParams.get("service"), "registry.docker.io");
        assert.equal(u.searchParams.get("scope"), "repository:library/alpine:pull");
        return Response.json({ token: "tok-alpine" });
      }
      if (url.includes("/v2/library/alpine/manifests/latest") && headers.get("Authorization") === "Bearer tok-alpine") {
        const body = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.docker.distribution.manifest.v2+json" });
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.docker.distribution.manifest.v2+json",
            "Content-Length": String(body.length),
            ETag: '"m1"',
          },
        });
      }
      return new Response(`unexpected ${url}`, { status: 599 });
    };

    const handle = createHandler({ fetch: fetchFn, cache: new MemoryCache() });
    const r = await handle(
      new Request("https://ph.test/v2/hub/library/alpine/manifests/latest", {
        headers: {
          Accept: "application/vnd.docker.distribution.manifest.v2+json",
        },
      }),
    );
    assert.equal(r.status, 200);
    const json = await r.json();
    assert.equal(json.schemaVersion, 2);
    assert.ok(calls.some((c) => c.url.startsWith("https://auth.docker.io/token")));
    assert.equal(r.headers.get("X-Proxyhub"), "1");
    assert.equal(r.headers.get("WWW-Authenticate"), null);
  });

  it("range-fetches a blob and resumes after 401", async () => {
    resetDockerAuth();
    let blobGets = 0;
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.startsWith("https://registry-1.docker.io/") && !headers.get("Authorization")) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
          },
        });
      }
      if (url.startsWith("https://auth.docker.io/token")) {
        return Response.json({ token: "tok-blob" });
      }
      if (url.includes("/blobs/sha256:")) {
        blobGets += 1;
        if (blobGets === 1) return new Response("expired", { status: 401 });
        const rng = headers.get("Range") || "";
        if (rng === "bytes=0-3") {
          return new Response("ABCD", {
            status: 206,
            headers: { "Content-Range": "bytes 0-3/8", "Content-Type": "application/octet-stream" },
          });
        }
        if (rng === "bytes=4-7") {
          return new Response("EFGH", {
            status: 206,
            headers: { "Content-Range": "bytes 4-7/8" },
          });
        }
      }
      return new Response(`unexpected ${url} ${headers.get("Range")}`, { status: 599 });
    };
    const handle = createHandler({
      fetch: fetchFn,
      cache: new MemoryCache(),
      rangeChunk: 4,
    });
    const digest = "sha256:" + "ab".repeat(32);
    const r = await handle(new Request(`https://ph.test/v2/hub/library/alpine/blobs/${digest}`));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("Content-Length"), "8");
    assert.equal(r.headers.get("Docker-Content-Digest"), digest);
    assert.equal(await r.text(), "ABCDEFGH");
  });

  it("HEAD on a blob reports Content-Length from a range probe", async () => {
    resetDockerAuth();
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const method = (init?.method || "GET").toUpperCase();
      if (url.startsWith("https://registry-1.docker.io/") && !headers.get("Authorization")) {
        return new Response(null, {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
          },
        });
      }
      if (url.startsWith("https://auth.docker.io/token")) {
        return Response.json({ token: "tok-head" });
      }
      if (url.includes("/blobs/sha256:")) {
        if (method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "Content-Type": "application/octet-stream" },
          });
        }
        assert.equal(headers.get("Range"), "bytes=0-0");
        return new Response("A", {
          status: 206,
          headers: { "Content-Range": "bytes 0-0/8", "Content-Length": "1" },
        });
      }
      return new Response(`unexpected ${url}`, { status: 599 });
    };
    const handle = createHandler({ fetch: fetchFn, cache: new MemoryCache() });
    const digest = "sha256:" + "cd".repeat(32);
    const r = await handle(
      new Request(`https://ph.test/v2/hub/library/alpine/blobs/${digest}`, { method: "HEAD" }),
    );
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("Content-Length"), "8");
    assert.equal(r.headers.get("Docker-Content-Digest"), digest);
    assert.equal(await r.text(), "");
  });
});
