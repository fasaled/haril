/**
 * MCP stdio server.
 *
 * Exposes the same `FileTimelineCommands` as the TUI, with the MCP SDK.
 * Tools are read-only against the open `.haril` package; `open_capture_package`
 * and `close_capture_package` manage the package lifecycle.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HarilSession, createSession, importPackageIntoStore } from "@haril-ts/core";
import { z } from "zod";
import { readFile } from "node:fs/promises";

export interface ServeOptions {
  packagePath?: string | null;
  journalPath?: string | null;
}

export async function serveMcp(opts: ServeOptions): Promise<void> {
  let session = await createSession();

  if (opts.packagePath) {
    try {
      await openPackage(session, opts.packagePath);
    } catch (err) {
      // Surface the error via stderr so the agent can react.
      console.error("failed to open package:", err instanceof Error ? err.message : String(err));
    }
  }

  const server = new McpServer({ name: "haril", version: "0.1.0" });

  registerTools(server, session);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // The MCP server runs until the client closes stdin. Cleanup happens at exit.
  process.on("SIGTERM", () => session.close());
  process.on("SIGINT", () => session.close());
}

async function openPackage(session: HarilSession, path: string): Promise<void> {
  // Always create a fresh temporary file-backed store and import the package.
  // The store is rebuilt on every open so the lifecycle is predictable.
  // We use a file instead of ":memory:" because the bundled binary appears
  // to mis-handle the in-memory database under some conditions.
  const { SqliteStore, importPackageIntoStore, readPackage } = await import("@haril-ts/core");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "haril-mcp-"));
  const tmp = new SqliteStore({ path: join(dir, "index.sqlite") });
  await importPackageIntoStore(path, tmp);
  session.setStore(tmp);
  const pkg = await readPackage(path);
  session.setPackage({ path, manifest: pkg.manifest });
}

function registerTools(server: McpServer, session: HarilSession): void {
  server.tool(
    "open_capture_package",
    "Open a .haril package. Replaces any open session.",
    { path: z.string().describe("absolute path to a .haril file") },
    async ({ path }) => {
      try {
        await openPackage(session, path);
        const snap = session.snapshot();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: true,
                session: { phase: snap.phase, packagePath: snap.packagePath },
              }),
            },
          ],
        };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "close_capture_package",
    "Close the active package.",
    {},
    async () => {
      session.close();
      const fresh = createSession();
      return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
    },
  );

  server.tool(
    "get_capture_summary",
    "Manifest summary for the active package.",
    {},
    async () => {
      const snap = session.snapshot();
      if (!snap.packageManifest) return toolError("no package is open");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: true,
              phase: snap.phase,
              manifest: snap.packageManifest,
              cwd: snap.cwd,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "get_session_activity_overview",
    "Session-wide factual totals and coverage.",
    {},
    async () => {
      const res = await session.run("overview");
      if (!res.ok) return toolError(res.error ?? "overview failed");
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: res.data }) }] };
    },
  );

  server.tool(
    "list_observed_directories",
    "List distinct directories with observed files.",
    { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(1000).default(50) },
    async (args) => {
      const res = await session.run("dirs");
      if (!res.ok) return toolError(res.error ?? "dirs failed");
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: res.data }) }] };
    },
  );

  server.tool(
    "search_file_timelines",
    "Search file timelines by path or process name substring.",
    { text: z.string().min(1), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(1000).default(50) },
    async ({ text }) => {
      const res = await session.run(`search ${JSON.stringify(text)}`);
      if (!res.ok) return toolError(res.error ?? "search failed");
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: res.data }) }] };
    },
  );

  server.tool(
    "browse_file_timelines",
    "Page file timelines under a directory.",
    {
      directory: z.string().default("\\"),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(1000).default(50),
      pathPattern: z.string().optional(),
      identityKind: z.enum(["exact", "path-scoped"]).optional(),
    },
    async ({ directory, offset, limit, pathPattern, identityKind }) => {
      const res = await session.runCommand({
        name: "ls",
        positional: [directory],
        flags: {
          ...(pathPattern ? { pattern: pathPattern } : {}),
          ...(identityKind ? { identity: identityKind } : {}),
          offset: String(offset),
          limit: String(limit),
        },
      });
      if (!res.ok) return toolError(res.error ?? "ls failed");
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: res.data }) }] };
    },
  );

  server.tool(
    "inspect_file_timeline",
    "Inspect events of one file timeline.",
    {
      fileKeyHash: z.string(),
      limit: z.number().int().min(1).max(1000).default(50),
      offset: z.number().int().min(0).default(0),
      opKinds: z.array(z.string()).optional(),
      failedOnly: z.boolean().optional(),
      pid: z.number().int().optional(),
      processName: z.string().optional(),
    },
    async ({ fileKeyHash, limit, offset, opKinds, failedOnly, pid, processName }) => {
      const filter: Record<string, unknown> = {};
      if (opKinds) filter["op"] = opKinds[0];
      if (failedOnly) filter["failed"] = true;
      if (pid != null) filter["pid"] = String(pid);
      if (processName) filter["process"] = processName;
      const res = await session.runCommand({
        name: "events",
        positional: [fileKeyHash],
        flags: { ...filter, limit: String(limit), offset: String(offset) },
      });
      if (!res.ok) return toolError(res.error ?? "events failed");
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: res.data }) }] };
    },
  );

  server.tool(
    "inspect_file_timeline_event",
    "Inspect one event of a file timeline.",
    { fileKeyHash: z.string(), eventIndex: z.number().int().min(1) },
    async ({ fileKeyHash, eventIndex }) => {
      const res = await session.runCommand({
        name: "evidence",
        positional: [String(eventIndex)],
        flags: {},
      });
      if (!res.ok) return toolError(res.error ?? "evidence failed");
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: res.data }) }] };
    },
  );

  server.tool(
    "get_file_activity_summary",
    "Aggregated metrics for one file timeline.",
    { fileKeyHash: z.string() },
    async ({ fileKeyHash }) => {
      const res = await session.runCommand({
        name: "summary",
        positional: [fileKeyHash],
        flags: {},
      });
      if (!res.ok) return toolError(res.error ?? "summary failed");
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: res.data }) }] };
    },
  );

  server.tool(
    "get_file_size_changes",
    "Observed size transitions for files with non-null FILE_ID_128 in both inventories.",
    {},
    async () => {
      const res = await session.run("size-changes");
      if (!res.ok) return toolError(res.error ?? "size-changes failed");
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, data: res.data }) }] };
    },
  );
}

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: message }) }],
  };
}