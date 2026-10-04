/**
 * Smoke test the MCP server by spawning the CLI and exchanging JSON-RPC
 * messages over stdio. Uses child_process to keep the test simple.
 *
 * This test is skipped when haril_native.node is not loadable (e.g. Bun
 * 1.3.14 with TinyCC disabled). In that configuration the project degrades
 * gracefully to analyze-only; the MCP server cannot start without the addon.
 */

import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { native } from "../../core/src/ffi/bindings.ts";

// Bun's test.skip works with a condition evaluated at test definition time.
// We use a module-level check so the test is properly marked as skipped.
const IS_NATIVE_AVAILABLE = native() !== null;

if (IS_NATIVE_AVAILABLE) {
  describe("mcp server smoke", () => {
    test("responds to initialize + list_tools + tools/call", async () => {
      const pkgPath = join(import.meta.dir, "..", "..", "core", "test", "fixtures", "smoke.haril");
      const cwd = join(import.meta.dir, "..", "..", "..");
      const proc = spawn(
        "bun",
        ["run", "packages/cli/src/cli.ts", "mcp", pkgPath],
        { cwd, stdio: ["pipe", "pipe", "pipe"] },
      );

      const out: string[] = [];
      const errOut: string[] = [];

      let timeout: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        try { proc.kill(); } catch {}
      };

      const allRequests = [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_session_activity_overview", arguments: {} } },
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_observed_directories", arguments: { offset: 0, limit: 10 } } },
        { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "browse_file_timelines", arguments: { directory: "\\", offset: 0, limit: 10 } } },
      ];

      await new Promise<void>((resolve, reject) => {
        function checkDone() {
          const lines = out.join("").split("\n").filter((l) => l.trim());
          const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          // Expect responses for id 1, 2, 3, 4, 5
          if (parsed.some((p: any) => p.id === 5)) {
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
          reject(new Error(`mcp server did not respond in 15s. stdout: ${out.join("")} stderr: ${errOut.join("")}`));
        }, 15_000);

        let i = 0;
        function sendNext() {
          if (i >= allRequests.length) {
            return;
          }
          proc.stdin!.write(JSON.stringify(allRequests[i]) + "\n");
          i++;
          setTimeout(sendNext, 150);
        }
        // Give process a moment to initialize before pumping requests
        setTimeout(sendNext, 300);
      });
    }, 30000);
  });
} else {
  // Module-level: mark the describe as skipped
  describe.skip("mcp server smoke", () => {
    test("placeholder", () => {
      // no-op
    });
  });
}