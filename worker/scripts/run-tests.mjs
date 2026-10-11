import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../dist/test");
const wantIntegration = process.argv.includes("--integration");
const files = (await readdir(dir))
  .filter((f) => f.endsWith(".test.js"))
  .filter((f) => (wantIntegration ? f === "integration.test.js" : f !== "integration.test.js"))
  .map((f) => join(dir, f))
  .sort();
if (!files.length) {
  console.error("no test files in", dir);
  process.exit(1);
}
const child = spawn(process.execPath, ["--test", ...files], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
