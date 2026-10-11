import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { createHandler, MemoryCache } from "../src/index";

const ACCEPT = [
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v1+prettyjws",
  "*/*",
].join(", ");

async function live(url: string, ms = 10000): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "GET", signal: AbortSignal.timeout(ms) });
    return r.status > 0;
  } catch {
    return false;
  }
}

function startServer(handle: (req: Request) => Promise<Response>): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer(async (req, res) => {
      try {
        const host = req.headers.host || "127.0.0.1";
        const url = `http://${host}${req.url || "/"}`;
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (v == null) continue;
          headers.set(k, Array.isArray(v) ? v.join(", ") : v);
        }
        const method = req.method || "GET";
        const init: RequestInit & { duplex?: string } = { method, headers };
        if (method !== "GET" && method !== "HEAD") {
          init.body = req;
          init.duplex = "half";
        }
        const response = await handle(new Request(url, init));
        const out: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          out[key] = value;
        });
        res.writeHead(response.status, out);
        if (method === "HEAD" || !response.body) {
          res.end();
          return;
        }
        Readable.fromWeb(response.body as import("node:stream/web").ReadableStream).pipe(res);
      } catch (err) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(String(err));
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("no addr"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

function run(cmd: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => {
      out += b;
    });
    child.stderr.on("data", (b) => {
      out += b;
    });
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout: ${cmd} ${args.join(" ")}\n${out}`));
    }, opts.timeout ?? 90000);
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 1, out });
    });
  });
}

describe("integration (live upstreams)", { timeout: 180000 }, () => {
  it("docker manifest + blob for library/alpine via /v2/hub/…", async (t) => {
    if (!(await live("https://registry-1.docker.io/v2/"))) {
      t.skip("registry-1.docker.io unreachable");
      return;
    }
    const handle = createHandler({ cache: new MemoryCache() });
    const ping = await handle(new Request("https://ph.test/v2/"));
    assert.equal(ping.status, 200);

    const man = await handle(
      new Request("https://ph.test/v2/hub/library/alpine/manifests/latest", {
        headers: { Accept: ACCEPT },
      }),
    );
    assert.equal(man.status, 200, await man.clone().text());
    const ctype = man.headers.get("Content-Type") || "";
    const doc = (await man.json()) as {
      manifests?: { digest: string; platform?: { architecture?: string; os?: string } }[];
      config?: { digest: string };
      layers?: { digest: string }[];
    };
    assert.ok(ctype.includes("json") || ctype.includes("prettyjws") || doc.config || doc.manifests);

    let blobDigest = doc.config?.digest;
    if (!blobDigest && doc.manifests?.length) {
      const amd = doc.manifests.find(
        (m) => m.platform?.os === "linux" && (m.platform?.architecture === "amd64" || m.platform?.architecture === "arm64"),
      ) || doc.manifests[0];
      const inner = await handle(
        new Request(`https://ph.test/v2/hub/library/alpine/manifests/${amd.digest}`, {
          headers: { Accept: ACCEPT },
        }),
      );
      assert.equal(inner.status, 200, await inner.clone().text());
      const img = (await inner.json()) as { config?: { digest: string } };
      blobDigest = img.config?.digest;
    }
    assert.ok(blobDigest && blobDigest.startsWith("sha256:"), "expected a config digest");
    const blob = await handle(new Request(`https://ph.test/v2/hub/library/alpine/blobs/${blobDigest}`));
    assert.equal(blob.status, 200, await blob.clone().text());
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert.ok(bytes.byteLength > 0);
    assert.equal(blob.headers.get("Docker-Content-Digest"), blobDigest);
    assert.ok(blob.headers.get("Content-Length"));
  });

  it("anonymous /r/ghcr.io pull of a public manifest", async (t) => {
    if (!(await live("https://ghcr.io/v2/"))) {
      t.skip("ghcr.io unreachable");
      return;
    }
    const handle = createHandler({ cache: new MemoryCache() });
    const r = await handle(
      new Request("https://ph.test/v2/r/ghcr.io/jqlang/jq/manifests/latest", {
        headers: { Accept: ACCEPT },
      }),
    );
    assert.equal(r.status, 200, await r.clone().text());
    const ctype = r.headers.get("Content-Type") || "";
    assert.ok(ctype.includes("json") || ctype.includes("prettyjws"), ctype);
    const doc = (await r.json()) as { schemaVersion?: number; manifests?: unknown[]; config?: unknown };
    assert.ok(doc.schemaVersion || doc.manifests || doc.config);
  });

  it("release.cloudreve.org via /r/ returns a Basic challenge without credentials", async (t) => {
    if (!(await live("https://release.cloudreve.org/v2/"))) {
      t.skip("release.cloudreve.org unreachable");
      return;
    }
    const handle = createHandler({ cache: new MemoryCache() });
    const r = await handle(
      new Request("https://ph.test/v2/r/release.cloudreve.org/cloudreve/pro/manifests/latest", {
        headers: { Accept: ACCEPT },
      }),
    );
    assert.equal(r.status, 401, await r.clone().text());
    const www = r.headers.get("WWW-Authenticate") || "";
    assert.match(www, /^Basic realm="https:\/\/ph\.test\/v2\/"$/);
    assert.equal(r.headers.get("Docker-Distribution-Api-Version"), "registry/2.0");
  });

  it("pypi simple index rewrite + pip download", async (t) => {
    if (!(await live("https://pypi.org/simple/pip/"))) {
      t.skip("pypi.org unreachable");
      return;
    }
    const handle = createHandler({ cache: new MemoryCache() });
    const idx = await handle(
      new Request("https://ph.test/pypi/index/pip/", {
        headers: { Accept: "text/html" },
      }),
    );
    assert.equal(idx.status, 200);
    const html = await idx.text();
    assert.match(html, /https:\/\/ph\.test\/pypi\/files\//);
    assert.doesNotMatch(html, /files\.pythonhosted\.org/);

    const srv = await startServer((req) => handle(req));
    const viaHttp = await fetch(`${srv.url}/pypi/index/pip/`);
    assert.equal(viaHttp.status, 200);
    assert.equal(viaHttp.headers.get("content-encoding"), null);
    assert.match(await viaHttp.text(), /href=/);
    const dir = await mkdtemp(join(tmpdir(), "ph-pip-"));
    try {
      const { code, out } = await run(
        "pip",
        [
          "download",
          "pip",
          "-i",
          `${srv.url}/pypi/index/`,
          "--no-deps",
          "-d",
          dir,
          "--retries",
          "2",
          "--trusted-host",
          "127.0.0.1",
        ],
        { timeout: 90000 },
      );
      assert.equal(code, 0, out);
      assert.match(out, /pip-/);
    } finally {
      await srv.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("git clone via /github/github.com/…", async (t) => {
    if (!(await live("https://github.com/octocat/Hello-World"))) {
      t.skip("github.com unreachable");
      return;
    }
    const handle = createHandler({ cache: new MemoryCache() });
    const refs = await handle(
      new Request("https://ph.test/github/github.com/octocat/Hello-World/info/refs?service=git-upload-pack", {
        headers: { "User-Agent": "git/2.40.0" },
      }),
    );
    assert.ok(refs.status === 200 || refs.status === 401, `info/refs ${refs.status}`);
    if (refs.status === 200) {
      const body = await refs.text();
      assert.match(body, /git-upload-pack|refs\/heads/);
    }

    const srv = await startServer((req) => handle(req));
    const dir = await mkdtemp(join(tmpdir(), "ph-git-"));
    try {
      const { code, out } = await run(
        "git",
        ["clone", "--depth", "1", `${srv.url}/github/github.com/octocat/Hello-World`, join(dir, "repo")],
        { timeout: 90000 },
      );
      assert.equal(code, 0, out);
    } finally {
      await srv.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("crates sparse config + index file", async (t) => {
    if (!(await live("https://index.crates.io/config.json"))) {
      t.skip("index.crates.io unreachable");
      return;
    }
    const handle = createHandler({ cache: new MemoryCache() });
    const cfg = await handle(new Request("https://ph.test/crates/config.json"));
    assert.equal(cfg.status, 200);
    const data = (await cfg.json()) as { dl: string };
    assert.equal(data.dl, "https://ph.test/crates/dl");

    const idx = await handle(new Request("https://ph.test/crates/se/rd/serde"));
    assert.equal(idx.status, 200, await idx.clone().text());
    const text = await idx.text();
    assert.match(text, /"name":"serde"/);
    assert.match(text, /"vers":/);
  });
});
