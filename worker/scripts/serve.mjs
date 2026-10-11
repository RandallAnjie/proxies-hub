/**
 * Local Node host for the built worker (caches.default polyfill).
 * Usage: npm start   or   node scripts/serve.mjs
 * Prefer `npx wrangler@4 dev` when you want a real workerd runtime.
 */
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { default: worker, MemoryCache } = await import(join(root, "dist/worker.js"));

if (!globalThis.caches) {
  const mem = new MemoryCache();
  globalThis.caches = { default: mem };
}

const port = Number(process.env.PORT || 8787);
const env = { GITHUB_PAT: process.env.GITHUB_PAT || "" };

const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host || `127.0.0.1:${port}`;
    const url = `http://${host}${req.url || "/"}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v == null) continue;
      headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }
    const method = req.method || "GET";
    const body = method === "GET" || method === "HEAD" ? undefined : req;
    const init = { method, headers, body };
    if (body) init.duplex = "half";
    const request = new Request(url, init);
    const response = await worker.fetch(request, env, { waitUntil() {} });
    const out = {};
    response.headers.forEach((value, key) => {
      out[key] = value;
    });
    res.writeHead(response.status, out);
    if (method === "HEAD" || !response.body) {
      res.end();
      return;
    }
    Readable.fromWeb(response.body).pipe(res);
  } catch (err) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`serve error: ${err}\n`);
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`proxies-hub worker on http://127.0.0.1:${port}  (docs: /docs)`);
});
