import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { config } from "../src/config";
import {
  catalogItems,
  createHandler,
  helpText,
  landingHtml,
  MemoryCache,
  snippetFor,
  wantsLandingHtml,
} from "../src/index";

const handle = createHandler({
  fetch: async () => new Response("no", { status: 599 }),
  cache: new MemoryCache(),
});

function req(url: string, headers?: Record<string, string>): Request {
  return new Request(url, headers ? { headers } : undefined);
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

describe("catalogItems", () => {
  it("covers every docker registry and path-dispatched service from config", () => {
    const items = catalogItems();
    const ids = new Set(items.map((i) => i.id));
    for (const id of Object.keys(config.docker)) {
      const row = items.find((i) => i.id === id && i.family === "docker");
      assert.ok(row, `missing docker ${id}`);
      assert.equal(row.prefix, `/v2/${id}`);
      assert.equal(row.upstream, config.docker[id].upstream);
    }
    for (const id of Object.keys(config.web)) {
      assert.ok(ids.has(id), `missing web ${id}`);
      assert.equal(items.find((i) => i.id === id)?.prefix, `/${id}`);
      assert.equal(items.find((i) => i.id === id)?.upstream, config.web[id].upstream);
    }
    for (const id of ["github", "pypi", "crates", "apt", "cache"]) {
      assert.ok(ids.has(id), `missing service ${id}`);
    }
  });
});

describe("wantsLandingHtml", () => {
  it("is true only for non-CLI clients that accept HTML", () => {
    assert.equal(
      wantsLandingHtml(req("https://h/", { Accept: "text/html", "User-Agent": "Mozilla/5.0" })),
      true,
    );
    assert.equal(
      wantsLandingHtml(
        req("https://h/", {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "User-Agent": "Mozilla/5.0 (Macintosh) Chrome/120",
        }),
      ),
      true,
    );
    assert.equal(wantsLandingHtml(req("https://h/", { "User-Agent": "curl/8.0" })), false);
    assert.equal(
      wantsLandingHtml(req("https://h/", { Accept: "text/html", "User-Agent": "curl/8.0" })),
      false,
    );
    assert.equal(
      wantsLandingHtml(req("https://h/", { Accept: "text/html", "User-Agent": "Wget/1.21" })),
      false,
    );
    assert.equal(wantsLandingHtml(req("https://h/", { Accept: "text/html" })), false);
    assert.equal(
      wantsLandingHtml(req("https://h/", { Accept: "*/*", "User-Agent": "Mozilla/5.0" })),
      false,
    );
    assert.equal(
      wantsLandingHtml(req("https://h/", { Accept: "application/json", "User-Agent": "Mozilla/5.0" })),
      false,
    );
  });
});

describe("GET / landing", () => {
  it("returns host-derived HTML for a browser Accept: text/html", async () => {
    const r = await handle(
      req("https://edge.example/", {
        Accept: "text/html",
        "User-Agent": "Mozilla/5.0",
      }),
    );
    assert.equal(r.status, 200);
    assert.match(r.headers.get("Content-Type") || "", /text\/html/);
    const html = await r.text();
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /lang="zh-CN"/);
    assert.match(html, /A single, hackable pull-through mirror proxy/);
    assert.match(html, /拉取式镜像代理/);
    assert.match(html, /href="\/docs"/);
    assert.match(html, /github\.com\/RandallAnjie\/proxies-hub/);
    assert.match(html, /Powered By/);
    assert.match(html, /id="q"/);
    assert.match(html, /prefers-color-scheme/);

    assert.match(html, /docker pull edge\.example\/hub\/library\/nginx/);
    assert.match(html, /ollama pull edge\.example\/ollama\/library\/llama3/);
    assert.match(html, /pip install -i https:\/\/edge\.example\/pypi\/index\//);
    assert.match(html, /uv pip install --index-url https:\/\/edge\.example\/pypi\/index\//);
    assert.match(html, /npm config set registry https:\/\/edge\.example\/npm/);
    assert.match(html, /conda config --set channel_alias https:\/\/edge\.example\/conda/);
    assert.match(html, /--index-url https:\/\/edge\.example\/torch\/whl\/cu121/);
    assert.match(html, /GOPROXY=https:\/\/edge\.example\/goproxy,direct/);
    assert.match(html, /HF_ENDPOINT=https:\/\/edge\.example\/hf/);
    assert.match(html, /sparse\+https:\/\/edge\.example\/crates\//);
    assert.match(html, /https:\/\/edge\.example\/maven/);
    assert.match(html, /https:\/\/edge\.example\/gradle/);
    assert.match(html, /https:\/\/edge\.example\/apk\/alpine\/v3\.19\/main/);
    assert.match(html, /apt\/archive\.ubuntu\.com\/ubuntu/);
    assert.match(html, /cache\/https\/&lt;host&gt;\/&lt;path&gt;/);
    assert.match(html, /git clone https:\/\/edge\.example\/github\/github\.com\/&lt;u&gt;\/&lt;r&gt;/);
    assert.match(html, /raw\.githubusercontent\.com/);

    assert.doesNotMatch(html, /proxies\.live/);
    assert.doesNotMatch(html, /bigrandall/);

    for (const item of catalogItems()) {
      assert.ok(html.includes(item.prefix), `missing prefix ${item.prefix}`);
      assert.ok(html.includes(esc(item.upstream)), `missing upstream ${item.upstream}`);
      assert.ok(html.includes(esc(snippetFor(item, "edge.example"))), `missing snippet for ${item.id}`);
    }
  });

  it("returns plain-text help for curl, wget, empty UA, and non-HTML Accept", async () => {
    const cases: Record<string, string>[] = [
      {},
      { "User-Agent": "curl/8.0" },
      { "User-Agent": "Wget/1.21.3" },
      { Accept: "text/html" },
      { Accept: "*/*", "User-Agent": "Mozilla/5.0" },
      { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
    ];
    for (const headers of cases) {
      const r = await handle(req("https://edge.example/", headers));
      assert.equal(r.status, 200, JSON.stringify(headers));
      assert.match(r.headers.get("Content-Type") || "", /text\/plain/);
      assert.equal(await r.text(), helpText());
    }
  });

  it("leaves /docs, /v2/, and unknown paths unchanged", async () => {
    const md = await handle(req("https://edge.example/docs", { "User-Agent": "curl/8.0" }));
    assert.equal(md.status, 200);
    assert.match(md.headers.get("Content-Type") || "", /markdown/);

    const docsHtml = await handle(req("https://edge.example/docs", { "User-Agent": "Mozilla/5.0" }));
    assert.match(docsHtml.headers.get("Content-Type") || "", /html/);
    const docsBody = await docsHtml.text();
    assert.match(docsBody, /<!doctype html>/i);
    assert.doesNotMatch(docsBody, /id="q"/);

    const ping = await handle(req("https://edge.example/v2/"));
    assert.equal(ping.status, 200);
    assert.equal(ping.headers.get("Docker-Distribution-Api-Version"), "registry/2.0");
    assert.equal(await ping.text(), "");

    const unknown = await handle(req("https://edge.example/nope"));
    assert.equal(unknown.status, 404);
    assert.equal(await unknown.text(), helpText());
  });
});

describe("landingHtml", () => {
  it("embeds the request host and not a baked-in domain", () => {
    const html = landingHtml("ph.test:8787");
    assert.match(html, /docker pull ph\.test:8787\/hub\//);
    assert.doesNotMatch(html, /proxies-hub-randall/);
    assert.match(html, /data-probe="\/v2\/"/);
    assert.match(html, /data-probe="\/pypi\/index\/pip\/"/);
  });
});
