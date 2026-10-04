import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist", process.platform === "win32" ? "haril.exe" : "haril");

mkdirSync(dirname(outfile), { recursive: true });

const result = spawnSync(
  process.execPath,
  [
    "build",
    join(root, "packages", "cli", "src", "cli.ts"),
    "--compile",
    "--outfile",
    outfile,
  ],
  { stdio: "inherit" },
);

if (result.error) {
  throw result.error;
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Standalone executable built: ${outfile}`);
