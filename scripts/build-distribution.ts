import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const packageOutfile = join(root, "packages", "cli", "dist", "cli.js");
const standaloneBuilds =
  process.platform === "win32"
    ? [
        {
          target: "bun-windows-x64",
          outfile: join(root, "dist", "haril-x64.exe"),
        },
        {
          target: "bun-windows-arm64",
          outfile: join(root, "dist", "haril-arm64.exe"),
        },
      ]
    : [
        {
          target: undefined,
          outfile: join(root, "dist", `haril-${process.arch}`),
        },
      ];

if (mode === "standalone" && process.platform === "win32") {
  rmSync(join(root, "dist", "haril.exe"), { force: true });
}

mkdirSync(
  dirname(mode === "standalone" ? standaloneBuilds[0].outfile : packageOutfile),
  { recursive: true },
);

try {
  writeFileSync(embeddedAddonPath, generated.source, "utf8");

  const builds =
    mode === "standalone"
      ? standaloneBuilds.map(({ target, outfile }) => ({
          outfile,
          args: [
            "build",
            entrypoint,
            "--compile",
            ...(target ? ["--target", target] : []),
            "--outfile",
            outfile,
          ],
        }))
      : [
          {
            outfile: packageOutfile,
            args: [
              "build",
              entrypoint,
              "--outfile",
              packageOutfile,
              "--target",
              "node",
              "--format",
              "esm",
              "--packages",
              "bundle",
            ],
          },
        ];

  for (const build of builds) {
    const result = spawnSync(process.execPath, build.args, { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
    console.log(`Distribution built: ${build.outfile}`);
  }
} finally {
  writeFileSync(embeddedAddonPath, originalSource, "utf8");
}

if (process.exitCode) {
  throw new Error(`${mode} distribution build failed`);
}
