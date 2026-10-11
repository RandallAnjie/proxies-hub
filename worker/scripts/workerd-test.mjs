/**
 * Run the built worker/dist/worker.js under real workerd (wrangler --local)
 * and assert GET / HEAD / Range deliver exact bytes with matching
 * Content-Length, finishing in a few seconds (the PR #3 hang was ~15s / 0B).
 *
 * Mock origin:
 *   *.html  → generic small/direct path (finish / constrainResponseToRange)
 *   *.bin   → rangedFetch / stitch path
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REQUEST_MS = 8000;

const SMALL_HTML = Buffer.from("<!doctype html><title>ph-workerd</title>" + "A".repeat(256));
const BLOB = Buffer.alloc(8192);
for (let i = 0; i < BLOB.length; i++) BLOB[i] = i & 0xff;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on("error", reject);
  });
}

function parseBytesRange(header, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || "");
  if (!m) return null;
  let start;
  let end;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (!Number.isFinite(n) || n <= 0) return { unsatisfiable: true };
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? total - 1 : Number(m[2]);
  }
  if (!Number.isFinite(start) || start < 0 || start >= total) return { unsatisfiable: true };
  end = Math.min(end, total - 1);
  if (end < start) return { unsatisfiable: true };
  return { start, end };
}

function startOrigin() {
  return new Promise((resolve, reject) => {
    const files = new Map([
      ["/small.html", { body: SMALL_HTML, type: "text/html; charset=utf-8" }],
      ["/blob.bin", { body: BLOB, type: "application/octet-stream" }],
    ]);
    const server = createServer((req, res) => {
      const path = (req.url || "/").split("?")[0];
      const file = files.get(path);
      if (!file) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found\n");
        return;
      }
      const total = file.body.length;
      const base = {
        "Content-Type": file.type,
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=60",
      };
      if (req.method === "HEAD") {
        res.writeHead(200, { ...base, "Content-Length": String(total) });
        res.end();
        return;
      }
      const range = parseBytesRange(req.headers.range, total);
      if (req.headers.range && !range) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("bad range\n");
        return;
      }
      if (range?.unsatisfiable) {
        res.writeHead(416, { "Content-Range": `bytes */${total}` });
        res.end();
        return;
      }
      if (range) {
        const slice = file.body.subarray(range.start, range.end + 1);
        res.writeHead(206, {
          ...base,
          "Content-Length": String(slice.length),
          "Content-Range": `bytes ${range.start}-${range.end}/${total}`,
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, { ...base, "Content-Length": String(total) });
      res.end(file.body);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("origin has no port"));
        return;
      }
      resolve({
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
    server.on("error", reject);
  });
}

async function waitHttp(url, ms, log) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < ms) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (resp.status > 0) {
        await resp.arrayBuffer().catch(() => {});
        return;
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`workerd not ready at ${url}: ${last}\n${log()}`);
}

async function fetchExact(url, init = {}, ms = REQUEST_MS) {
  const headers = new Headers(init.headers);
  if (!headers.has("Accept-Encoding")) headers.set("Accept-Encoding", "identity");
  const resp = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(ms) });
  const buf = new Uint8Array(await resp.arrayBuffer());
  return { resp, buf };
}

function startWrangler(port, inspectorPort, persistDir) {
  const args = [
    "--yes",
    "wrangler@4",
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    String(inspectorPort),
    "--persist-to",
    persistDir,
    "--config",
    "wrangler.toml",
    "--no-bundle",
    "--log-level",
    "info",
  ];
  const child = spawn("npx", args, {
    cwd: root,
    env: {
      ...process.env,
      CI: "1",
      WRANGLER_SEND_METRICS: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let out = "";
  const onData = (buf) => {
    out += buf.toString();
    if (out.length > 200_000) out = out.slice(-100_000);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  return {
    child,
    log: () => out,
    stop() {
      if (!child.pid) return;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    },
  };
}

describe("workerd integration (built worker.js)", { timeout: 180000 }, () => {
  /** @type {{ port: number, url: string, close: () => Promise<void> }} */
  let origin;
  /** @type {string} */
  let workerUrl;
  /** @type {{ stop: () => void, log: () => string }} */
  let wrangler;
  /** @type {string} */
  let persistDir;

  before(async () => {
    origin = await startOrigin();
    persistDir = await mkdtemp(join(tmpdir(), "ph-wrangler-"));
    const port = await freePort();
    const inspectorPort = await freePort();
    wrangler = startWrangler(port, inspectorPort, persistDir);
    workerUrl = `http://127.0.0.1:${port}`;
    try {
      await waitHttp(`${workerUrl}/v2/`, 120000, wrangler.log);
    } catch (err) {
      wrangler.stop();
      await origin.close();
      throw err;
    }
  });

  after(async () => {
    wrangler?.stop();
    await origin?.close();
    if (persistDir) await rm(persistDir, { recursive: true, force: true });
  });

  function via(path) {
    const host = `127.0.0.1:${origin.port}`;
    return `${workerUrl}/cache/http/${host}${path}`;
  }

  it("small/direct GET / HEAD / Range on .html finish with exact bytes", async () => {
    const url = via("/small.html");
    const get = await fetchExact(url);
    assert.equal(get.resp.status, 200, headerDump(get));
    assert.equal(get.resp.headers.get("content-length"), String(SMALL_HTML.length), headerDump(get));
    assert.deepEqual(get.buf, new Uint8Array(SMALL_HTML));

    const head = await fetchExact(url, { method: "HEAD" });
    assert.equal(head.resp.status, 200);
    assert.equal(head.resp.headers.get("content-length"), String(SMALL_HTML.length));
    assert.equal(head.buf.byteLength, 0);

    const ranged = await fetchExact(url, { headers: { Range: "bytes=0-15" } });
    assert.equal(ranged.resp.status, 206);
    assert.equal(ranged.resp.headers.get("content-length"), "16");
    assert.equal(ranged.resp.headers.get("content-range"), `bytes 0-15/${SMALL_HTML.length}`);
    assert.deepEqual(ranged.buf, new Uint8Array(SMALL_HTML.subarray(0, 16)));
  });

  it("ranged/chunked GET / HEAD / Range on .bin finish with exact bytes", async () => {
    const url = via("/blob.bin");
    const get = await fetchExact(url);
    assert.equal(get.resp.status, 200, headerDump(get));
    assert.equal(get.resp.headers.get("content-length"), String(BLOB.length));
    assert.deepEqual(get.buf, new Uint8Array(BLOB));

    const head = await fetchExact(url, { method: "HEAD" });
    assert.equal(head.resp.status, 200);
    assert.equal(head.resp.headers.get("content-length"), String(BLOB.length));
    assert.equal(head.buf.byteLength, 0);

    const ranged = await fetchExact(url, { headers: { Range: "bytes=0-1023" } });
    assert.equal(ranged.resp.status, 206);
    assert.equal(ranged.resp.headers.get("content-length"), "1024");
    assert.equal(ranged.resp.headers.get("content-range"), `bytes 0-1023/${BLOB.length}`);
    assert.deepEqual(ranged.buf, new Uint8Array(BLOB.subarray(0, 1024)));
  });

  it("unsatisfiable Range returns 416 without hanging", async () => {
    const url = via("/blob.bin");
    const miss = await fetchExact(url, { headers: { Range: "bytes=999999-1000000" } });
    assert.equal(miss.resp.status, 416);
    assert.equal(miss.resp.headers.get("content-range"), `bytes */${BLOB.length}`);
    assert.equal(miss.buf.byteLength, 0);
  });

  it("GET /npm/left-pad delivers a matching Content-Length body when npm is reachable", async (t) => {
    try {
      const probe = await fetch("https://registry.npmjs.org/left-pad", {
        method: "HEAD",
        signal: AbortSignal.timeout(5000),
      });
      if (!probe.ok) {
        t.skip(`registry.npmjs.org HEAD ${probe.status}`);
        return;
      }
    } catch {
      t.skip("registry.npmjs.org unreachable");
      return;
    }
    const get = await fetchExact(`${workerUrl}/npm/left-pad`, {}, 15000);
    assert.equal(get.resp.status, 200, headerDump(get));
    const cl = get.resp.headers.get("content-length");
    assert.ok(cl, `Content-Length must be present\n${headerDump(get)}`);
    assert.equal(Number(cl), get.buf.byteLength, headerDump(get));
    assert.ok(get.buf.byteLength > 0, "body must not be 0 bytes");
    const text = new TextDecoder().decode(get.buf);
    assert.match(text, /left-pad/);
  });
});

function headerDump(got) {
  const headers = [];
  got.resp.headers.forEach((v, k) => headers.push(`${k}: ${v}`));
  const preview = new TextDecoder().decode(got.buf.subarray(0, 240));
  return `${got.resp.status} bytes=${got.buf.byteLength}\n${headers.join("\n")}\n${preview}`;
}
