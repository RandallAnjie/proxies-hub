import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHandler, helpText, matchRoute, MemoryCache } from "../src/index";

describe("matchRoute", () => {
  it("pings /v2", () => {
    assert.deepEqual(matchRoute("/v2"), { kind: "v2-ping" });
    assert.deepEqual(matchRoute("/v2/"), { kind: "v2-ping" });
  });

  it("dispatches generic docker /v2/r/<registry-host>/… and /token/…", () => {
    assert.deepEqual(matchRoute("/v2/r/ghcr.io/jqlang/jq/manifests/latest"), {
      kind: "docker-generic",
      registryHost: "ghcr.io",
      path: "/v2/jqlang/jq/manifests/latest",
    });
    assert.deepEqual(matchRoute("/v2/r/release.cloudreve.org/cloudreve/pro/manifests/latest"), {
      kind: "docker-generic",
      registryHost: "release.cloudreve.org",
      path: "/v2/cloudreve/pro/manifests/latest",
    });
    assert.deepEqual(
      matchRoute("/v2/r/reg.example.com:5000/foo/bar/blobs/sha256:" + "ab".repeat(32)),
      {
        kind: "docker-generic",
        registryHost: "reg.example.com:5000",
        path: "/v2/foo/bar/blobs/sha256:" + "ab".repeat(32),
      },
    );
    assert.deepEqual(matchRoute("/token/r/ghcr.io"), {
      kind: "docker-token",
      target: { kind: "generic", registryHost: "ghcr.io" },
    });
    assert.deepEqual(matchRoute("/token/ghcr"), {
      kind: "docker-token",
      target: { kind: "fixed", registry: "ghcr" },
    });
  });

  it("dispatches docker /v2/<registry>/…", () => {
    assert.deepEqual(matchRoute("/v2/hub/library/nginx/manifests/latest"), {
      kind: "docker",
      registry: "hub",
      path: "/v2/library/nginx/manifests/latest",
    });
    assert.deepEqual(matchRoute("/v2/ollama/library/llama3/manifests/latest"), {
      kind: "docker",
      registry: "ollama",
      path: "/v2/library/llama3/manifests/latest",
    });
    assert.deepEqual(matchRoute("/v2/k8s-gcr/pause/manifests/latest"), {
      kind: "docker",
      registry: "k8s-gcr",
      path: "/v2/pause/manifests/latest",
    });
  });

  it("dispatches /<service>/<path> with prefix", () => {
    assert.deepEqual(matchRoute("/pypi/index/requests/"), {
      kind: "service",
      service: "pypi",
      path: "/index/requests/",
      prefix: "/pypi",
    });
    assert.deepEqual(matchRoute("/github/github.com/u/r"), {
      kind: "service",
      service: "github",
      path: "/github.com/u/r",
      prefix: "/github",
    });
    assert.deepEqual(matchRoute("/crates/config.json"), {
      kind: "service",
      service: "crates",
      path: "/config.json",
      prefix: "/crates",
    });
    assert.deepEqual(matchRoute("/apt/archive.ubuntu.com/ubuntu/dists/jammy/Release"), {
      kind: "service",
      service: "apt",
      path: "/archive.ubuntu.com/ubuntu/dists/jammy/Release",
      prefix: "/apt",
    });
    assert.deepEqual(matchRoute("/cache/https/example.com/a.tgz"), {
      kind: "service",
      service: "cache",
      path: "/https/example.com/a.tgz",
      prefix: "/cache",
    });
    for (const svc of ["npm", "conda", "torch", "goproxy", "hf", "maven", "gmaven", "gradle", "apk"]) {
      const r = matchRoute(`/${svc}/foo`);
      assert.equal(r.kind, "service");
      if (r.kind === "service") {
        assert.equal(r.service, svc);
        assert.equal(r.prefix, `/${svc}`);
        assert.equal(r.path, "/foo");
      }
    }
  });

  it("docs, home, and unknown paths", () => {
    assert.deepEqual(matchRoute("/docs"), { kind: "docs" });
    assert.equal(matchRoute("/").kind, "home");
    assert.equal(matchRoute("/nope").kind, "help");
  });
});

describe("handler routing", () => {
  const cache = new MemoryCache();
  const fetchFn = async () => new Response("no", { status: 599 });
  const handle = createHandler({ fetch: fetchFn, cache });

  it("serves v2 ping and help", async () => {
    const ping = await handle(new Request("https://ph.test/v2/"));
    assert.equal(ping.status, 200);
    assert.equal(ping.headers.get("Docker-Distribution-Api-Version"), "registry/2.0");

    const help = await handle(new Request("https://ph.test/unknown"));
    assert.equal(help.status, 404);
    const body = await help.text();
    assert.match(body, /all-in-one/);
    assert.match(body, /hub/);
    assert.match(body, /pypi/);
    assert.match(body, /\/v2\/r\/<registry-host>/);
    assert.equal(body, helpText());
  });

  it("rejects unknown docker registry", async () => {
    const r = await handle(new Request("https://ph.test/v2/private/foo/manifests/x"));
    assert.equal(r.status, 404);
    assert.match(await r.text(), /unknown or non-public/);
  });

  it("docs: markdown for curl, html for browsers", async () => {
    const md = await handle(
      new Request("https://edge.example/docs", { headers: { "User-Agent": "curl/8.0" } }),
    );
    assert.equal(md.headers.get("Content-Type")?.includes("markdown"), true);
    const text = await md.text();
    assert.match(text, /docker pull edge.example\/hub/);
    assert.match(text, /docker pull edge.example\/r\/ghcr.io/);
    assert.match(text, /docker login edge.example/);
    assert.match(text, /never cached/);
    assert.match(text, /one credential per registry host/);
    assert.match(text, /pypi\/index/);
    assert.doesNotMatch(text, /hub\.docker\./);

    const html = await handle(
      new Request("https://edge.example/docs", { headers: { "User-Agent": "Mozilla/5.0" } }),
    );
    assert.equal(html.headers.get("Content-Type")?.includes("html"), true);
    assert.match(await html.text(), /<!doctype html>/i);
  });
});
