/**
 * Smoke test the MCP server by spawning the CLI and exchanging JSON-RPC
 * messages over stdio. Uses child_process to keep the test simple.
 */

import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";

function exchange(requests: any[]): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const pkgPath = join(import.meta.dir, "..", "..", "core", "test", "fixtures", "smoke.haril");
    const cwd = join(import.meta.dir, "..", "..", "..");
    const proc = spawn(
      "bun",
      ["run", "packages/cli/src/cli.ts", "mcp", pkgPath],
      { cwd, stdio: ["pipe", "pipe", "pipe"] },
    );

    const out: string[] = [];
    proc.stdout!.on("data", (chunk) => out.push(chunk.toString()));
    proc.stderr!.on("data", () => {});

    let timeout: Timer | null = null;
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
      ...requests,
    ];

    timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`mcp server did not respond in 15s. stdout so far: ${out.join("")}`));
    }, 15_000);

    // Wait for the server to flush responses before sending more.
    let i = 0;
    function nextReq() {
      if (i >= allRequests.length) {
        // Wait a bit for last responses, then resolve
        setTimeout(() => {
          cleanup();
          const lines = out.join("").split("\n").filter((l) => l.trim());
          const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          resolve(parsed);
        }, 500);
        return;
      }
      proc.stdin!.write(JSON.stringify(allRequests[i]) + "\n");
      i++;
      // small delay between requests
      setTimeout(nextReq, 50);
    }
    nextReq();
  });
}

describe("mcp server smoke", () => {
  test("responds to initialize + list_tools + tools/call", async () => {
    const responses = await exchange([
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_session_activity_overview", arguments: {} } },
    ]);

    const init = responses.find((r) => r.id === 1);
    expect(init?.result?.serverInfo?.name).toBe("haril");

    const tools = responses.find((r) => r.id === 2);
    expect(tools?.result?.tools).toBeInstanceOf(Array);
    const toolNames = tools.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain("get_session_activity_overview");
    expect(toolNames).toContain("browse_file_timelines");

    const call = responses.find((r) => r.id === 3);
    expect(call?.result?.isError).toBeFalsy();
    const parsed = JSON.parse(call.result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.totalEvents).toBe(3);
  }, 30_000);
});