import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");
const cliPath = join(root, "packages", "cli", "dist", "cli.js");
const packagePath = join(root, "packages", "core", "test", "fixtures", "smoke.haril");

interface Runtime {
  name: "Node.js" | "Bun";
  command: string;
}

const runtimes: Runtime[] = [
  { name: "Node.js", command: "node" },
  { name: "Bun", command: "bun" },
];

async function exerciseMcp(runtime: Runtime): Promise<void> {
  const proc = spawn(runtime.command, [cliPath, "mcp", packagePath], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: string[] = [];
  const stderr: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill();
      reject(
        new Error(
          `${runtime.name} MCP timed out. stdout=${stdout.join("")} stderr=${stderr.join("")}`,
        ),
      );
    }, 15_000);

    proc.stdout.on("data", (chunk) => {
      stdout.push(chunk.toString());
      const responses = stdout
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
          } catch {
            return null;
          }
        })
        .filter((value) => value !== null);
      const finalResponse = responses.find((response) => response.id === 3);
      if (!finalResponse) return;

      clearTimeout(timeout);
      proc.kill();
      if (finalResponse.error) {
        reject(new Error(`${runtime.name} MCP returned ${JSON.stringify(finalResponse.error)}`));
      } else {
        expect(finalResponse.result).toBeDefined();
        resolve();
      }
    });
    proc.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
    proc.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    const requests = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "dual-runtime-e2e", version: "1" },
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_session_activity_overview", arguments: {} },
      },
    ];
    requests.forEach((request, index) => {
      setTimeout(() => proc.stdin.write(`${JSON.stringify(request)}\n`), 200 + index * 100);
    });
  });
}

describe("published CLI dual-runtime compatibility", () => {
  test("published bundle embeds native addons for x64 and arm64", () => {
    const bundle = readFileSync(cliPath, "utf8");
    const nativePayloadPrefixes = [
      join(root, "native", "out", "bin", "haril_native.node"),
      join(root, "native", "out", "bin-arm64", "haril_native.node"),
    ].map((path) => readFileSync(path).toString("base64").slice(0, 128));

    for (const prefix of nativePayloadPrefixes) {
      expect(bundle).toContain(prefix);
    }
  });

  for (const runtime of runtimes) {
    test(`${runtime.name} reports version and runtime`, () => {
      const version = spawnSync(runtime.command, [cliPath, "--version"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(version.status).toBe(0);
      expect(version.stdout).toContain("haril 0.1.2");

      const doctor = spawnSync(runtime.command, [cliPath, "doctor"], {
        cwd: root,
        encoding: "utf8",
      });
      expect(doctor.status).toBe(0);
      expect(doctor.stdout).toContain(`Runtime: ${runtime.name}`);
      expect(doctor.stdout).toContain("Native capture: available");
    });

    test(`${runtime.name} opens and queries a package over MCP`, async () => {
      await exerciseMcp(runtime);
    }, 20_000);
  }
});
