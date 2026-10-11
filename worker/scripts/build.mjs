import * as esbuild from "esbuild";
import { mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const withTests = process.argv.includes("--test");
const withIntegration = process.argv.includes("--integration");

await mkdir(join(root, "dist"), { recursive: true });

await esbuild.build({
  absWorkingDir: root,
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  outfile: "dist/worker.js",
  platform: "neutral",
  target: "es2022",
  legalComments: "none",
  logLevel: "info",
});

if (withTests) {
  const testDir = join(root, "test");
  const files = (await readdir(testDir)).filter((f) => {
    if (!f.endsWith(".test.ts")) return false;
    if (!withIntegration && f === "integration.test.ts") return false;
    return true;
  });
  if (files.length) {
    await esbuild.build({
      absWorkingDir: root,
      entryPoints: files.map((f) => join("test", f)),
      bundle: true,
      format: "esm",
      platform: "node",
      outdir: "dist/test",
      target: "es2022",
      legalComments: "none",
      external: ["node:test", "node:assert/strict", "node:http", "node:child_process", "node:fs", "node:os", "node:path"],
      logLevel: "info",
    });
  }
}
