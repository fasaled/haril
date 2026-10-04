import { spawnSync } from "node:child_process";

if (process.platform !== "win32") {
  console.log("Native capture is Windows-only; skipping addon build.");
  process.exit(0);
}

const result = spawnSync(
  "powershell",
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "./native/build-windows.ps1",
    "-AllPlatforms",
  ],
  { stdio: "inherit" },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
