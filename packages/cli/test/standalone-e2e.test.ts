/**
 * End-to-end test for the architecture-specific standalone binaries.
 *
 * Verifies that:
 * 1. The standalone binary starts cleanly and reports version/help.
 * 2. Embedded native addon auto-extracts to disk and is loadable.
 * 3. The standalone binary can run the MCP stdio server and process queries from a package.
 */

import { describe, test, expect } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, openSync, closeSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");
const executablePaths = {
  x64: join(root, "dist", "haril-x64.exe"),
  arm64: join(root, "dist", "haril-arm64.exe"),
};
const exePath = executablePaths[process.arch as keyof typeof executablePaths];

function readPeMachine(path: string): number {
  const fd = openSync(path, "r");
  try {
    const offsetBuffer = Buffer.alloc(4);
    readSync(fd, offsetBuffer, 0, offsetBuffer.length, 0x3c);
    const machineBuffer = Buffer.alloc(2);
    readSync(fd, machineBuffer, 0, machineBuffer.length, offsetBuffer.readUInt32LE(0) + 4);
    return machineBuffer.readUInt16LE(0);
  } finally {
    closeSync(fd);
  }
}

describe("standalone single-file binary e2e", () => {
  test("compiled x64 and arm64 binaries exist with unambiguous architectures", () => {
    expect(existsSync(join(root, "dist", "haril.exe"))).toBe(false);
    for (const path of Object.values(executablePaths)) {
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).size).toBeGreaterThan(1_000_000);
    }
    expect(readPeMachine(executablePaths.x64)).toBe(0x8664);
    expect(readPeMachine(executablePaths.arm64)).toBe(0xaa64);
  });

  test("executes --version successfully", () => {
    const res = spawnSync(exePath, ["--version"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("haril 0.1.3");
  });

  test("executes help successfully", () => {
    const res = spawnSync(exePath, ["help"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("USAGE");
    expect(res.stdout).toContain("Interactive TUI");
    expect(res.stdout).toContain("start-capture");
  });

  test("loads the embedded native addon through doctor", () => {
    const res = spawnSync(exePath, ["doctor"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Native capture: available");
    expect(res.stdout).toContain(`Platform: ${process.platform} ${process.arch}`);
  });

  test("runs MCP server with real fixture package over stdio", async () => {
    const pkgPath = join(root, "packages", "core", "test", "fixtures", "smoke.haril");
    const proc = spawn(exePath, ["mcp", pkgPath], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const out: string[] = [];
    const errOut: string[] = [];

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      try {
        proc.kill();
      } catch {}
    };

    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "standalone-e2e", version: "1.0" } },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_session_activity_overview", arguments: {} } },
    ];

    await new Promise<void>((resolve, reject) => {
      function checkDone() {
        const lines = out.join("").split("\n").filter((l) => l.trim());
        const parsed = lines.map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        }).filter(Boolean);

        // Expect responses for id 1, 2, 3
        const resp3 = parsed.find((p: any) => p.id === 3);
        if (resp3) {
          expect(resp3.result).toBeDefined();
          cleanup();
          resolve();
        }
      }

      proc.stdout!.on("data", (chunk) => {
        out.push(chunk.toString());
        checkDone();
      });
      proc.stderr!.on("data", (chunk) => {
        errOut.push(chunk.toString());
      });

      timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Standalone MCP did not reply in 15s. stdout: ${out.join("")} stderr: ${errOut.join("")}`));
      }, 15_000);

      let i = 0;
      function sendNext() {
        if (i >= requests.length) return;
        proc.stdin!.write(JSON.stringify(requests[i]) + "\n");
        i++;
        setTimeout(sendNext, 120);
      }
      setTimeout(sendNext, 250);
    });
  }, 20_000);
});
