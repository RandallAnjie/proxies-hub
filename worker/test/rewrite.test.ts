import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createHandler,
  MemoryCache,
  rewriteCratesConfig,
  rewriteNpmRegistry,
  rewritePypiIndex,
} from "../src/index";

describe("index URL rewriting", () => {
  it("rewrites PyPI simple file links", () => {
    const html =
      '<a href="https://files.pythonhosted.org/packages/ab/cd/foo-1.0.tar.gz">foo</a>';
    const out = rewritePypiIndex(html, "https://ph.test/pypi/files/");
    assert.equal(out, '<a href="https://ph.test/pypi/files/packages/ab/cd/foo-1.0.tar.gz">foo</a>');
  });

  it("rewrites PyPI JSON simple API", () => {
    const json = JSON.stringify({
      files: [{ url: "https://files.pythonhosted.org/packages/x/y.whl" }],
    });
    const out = rewritePypiIndex(json, "https://ph.test/pypi/files");
    assert.match(out, /https:\/\/ph\.test\/pypi\/files\/packages\/x\/y\.whl/);
    assert.doesNotMatch(out, /files\.pythonhosted\.org/);
  });

  it("rewrites crates config.json dl", () => {
    const out = rewriteCratesConfig(
      { dl: "https://static.crates.io/crates/{crate}/{crate}-{version}.crate", api: "https://crates.io" },
      "https://ph.test/crates/dl",
    );
    assert.equal(out.dl, "https://ph.test/crates/dl");
    assert.equal(out.api, "https://crates.io");
  });

  it("rewrites npm registry tarball URLs", () => {
    const body = JSON.stringify({
      dist: { tarball: "https://registry.npmjs.org/leftpad/-/leftpad-0.0.1.tgz" },
    });
    const out = rewriteNpmRegistry(body, "https://ph.test/npm/");
    assert.equal(
      JSON.parse(out).dist.tarball,
      "https://ph.test/npm/leftpad/-/leftpad-0.0.1.tgz",
    );
  });
});

describe("handler rewrites", () => {
  it("rewrites a pypi simple index through the handler", async () => {
    const fetchFn = async (input: RequestInfo | URL) => {
      const url = String(input);
      assert.match(url, /pypi\.org\/simple\/requests\//);
      return new Response(
        '<a href="https://files.pythonhosted.org/packages/aa/requests-2.0.tar.gz#sha256=abc">requests</a>',
        { status: 200, headers: { "Content-Type": "text/html", "Content-Length": "120" } },
      );
    };
    const handle = createHandler({ fetch: fetchFn, cache: new MemoryCache() });
    const r = await handle(new Request("https://ph.test/pypi/index/requests/"));
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /https:\/\/ph\.test\/pypi\/files\/packages\/aa\/requests-2.0\.tar\.gz/);
    assert.doesNotMatch(body, /files\.pythonhosted\.org/);
  });

  it("rewrites crates config.json dl to this host", async () => {
    const fetchFn = async (input: RequestInfo | URL) => {
      const url = String(input);
      assert.equal(new URL(url).pathname, "/config.json");
      return new Response(JSON.stringify({ dl: "https://static.crates.io/crates" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const handle = createHandler({ fetch: fetchFn, cache: new MemoryCache() });
    const r = await handle(new Request("https://ph.test/crates/config.json"));
    assert.equal(r.status, 200);
    const data = await r.json();
    assert.equal(data.dl, "https://ph.test/crates/dl");
  });

  it("rewrites npm packument tarball URLs", async () => {
    const pack = JSON.stringify({
      versions: {
        "1.0.0": { dist: { tarball: "https://registry.npmjs.org/leftpad/-/leftpad-1.0.0.tgz" } },
      },
    });
    const fetchFn = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("registry.npmjs.org/leftpad")) {
        return new Response(pack, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(pack.length),
            ETag: '"v1"',
          },
        });
      }
      return new Response("no", { status: 599 });
    };
    const handle = createHandler({ fetch: fetchFn, cache: new MemoryCache() });
    const r = await handle(new Request("https://ph.test/npm/leftpad"));
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /https:\/\/ph\.test\/npm\/leftpad\/-\/leftpad-1\.0\.0\.tgz/);
  });
});
