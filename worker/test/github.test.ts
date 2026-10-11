import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHandler, MemoryCache, resolveGithubAuth } from "../src/index";

describe("github token aliases", () => {
  it("maps ?token=team to GITHUB_PAT", () => {
    const req = new Request("https://ph.test/github/github.com/u/r?token=team");
    const { auth, fromAlias } = resolveGithubAuth(req, { GITHUB_PAT: "ghp_secret" });
    assert.equal(fromAlias, true);
    assert.ok(auth?.startsWith("Basic "));
  });

  it("treats an unknown token as a raw PAT (not an alias)", () => {
    const req = new Request("https://ph.test/github/github.com/u/r?token=ghp_raw");
    const { fromAlias } = resolveGithubAuth(req, {});
    assert.equal(fromAlias, false);
  });

  it("blocks receive-pack when the alias was used", async () => {
    const handle = createHandler({
      fetch: async () => new Response("no", { status: 599 }),
      cache: new MemoryCache(),
    });
    const r = await handle(
      new Request(
        "https://ph.test/github/github.com/u/r/info/refs?service=git-receive-pack&token=team",
        { headers: {} },
      ),
      { GITHUB_PAT: "ghp_secret" },
    );
    assert.equal(r.status, 403);
    assert.match(await r.text(), /read-only/);
  });

  it("rejects hosts outside the allow-list", async () => {
    const handle = createHandler({
      fetch: async () => new Response("no", { status: 599 }),
      cache: new MemoryCache(),
    });
    const r = await handle(new Request("https://ph.test/github/evil.example/x"));
    assert.equal(r.status, 403);
    assert.match(await r.text(), /host not allowed/);
  });
});
