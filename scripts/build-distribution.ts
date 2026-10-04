import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createEmbeddedNativeSource } from "./embedded-native-source.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const embeddedAddonPath = join(
  root,
  "packages",
  "core",
  "src",
  "ffi",
  "embedded_addon.ts",
);
const mode = process.argv[2];

if (mode !== "standalone" && mode !== "package") {
  throw new Error("Usage: bun run scripts/build-distribution.ts <standalone|package>");
}

const originalSource = readFileSync(embeddedAddonPath, "utf8");
const generated = createEmbeddedNativeSource(root);

const requiredArchitectures = ["x64", "arm64"];
const missingArchitectures = requiredArchitectures.filter(
  (architecture) => !generated.architectures.includes(architecture),
);

if (
  (process.platform === "win32" || mode === "package") &&
  missingArchitectures.length > 0
) {
  throw new Error(
    `Missing Windows native addons: ${missingArchitectures.join(", ")}. ` +
      "Run bun run build:native:all before building this distribution.",
  );
}

if (generated.architectures.length === 0) {
  console.warn("Building an analysis-only distribution without native capture.");
} else {
  console.log(`Embedding native addons: ${generated.architectures.join(", ")}`);
}

const entrypoint = join(root, "packages", "cli", "src", "cli.ts");
const outfile =
  mode === "standalone"
    ? join(root, "dist", process.platform === "win32" ? "haril.exe" : "haril")
    : join(root, "packages", "cli", "dist", "cli.js");

mkdirSync(dirname(outfile), { recursive: true });

try {
  writeFileSync(embeddedAddonPath, generated.source, "utf8");

  const args =
    mode === "standalone"
      ? ["build", entrypoint, "--compile", "--outfile", outfile]
      : [
          "build",
          entrypoint,
          "--outfile",
          outfile,
          "--target",
          "node",
          "--format",
          "esm",
          "--packages",
          "bundle",
        ];
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  writeFileSync(embeddedAddonPath, originalSource, "utf8");
}

if (process.exitCode) {
  throw new Error(`${mode} distribution build failed`);
}

console.log(`Distribution built: ${outfile}`);
