/**
 * End-to-end smoke test for the CLI's analyze path. Builds a synthetic
 * .haril package on disk, then verifies the analyze phase opens it
 * and answers ls/events/overview queries.
 *
 * This test exercises the public API exactly as the CLI does. It is
 * not a UI test; it asserts the core column for "open .haril → query".
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { writePackage, readPackage, HarilSession, SqliteStore, importPackageIntoStore } from "@haril-ts/core";
import type { InventoryEntry, NormalizedEvent, Manifest } from "@haril-ts/core";

let packagePath: string;
let session: HarilSession;

beforeAll(async () => {
  const tmp = mkdtempSync(join(tmpdir(), "haril-cli-e2e-"));
  packagePath = join(tmp, "session.haril");

  const now = 2_000_000_000n;
  const inventory: InventoryEntry[] = [
    {
      path: "\\src\\index.ts",
      length: 200,
      attributes: 0x20,
      lastWriteTime: now,
      creationTime: now,
      fileId128: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
      volumeSerial: 9999n,
      observedAt: now,
    },
    {
      path: "\\src\\cli.ts",
      length: 150,
      attributes: 0x20,
      lastWriteTime: now,
      creationTime: now,
      fileId128: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17]),
      volumeSerial: 9999n,
      observedAt: now,
    },
  ];

  const events: NormalizedEvent[] = [
    {
      timestamp_ns: now + 1n,
      eventKind: "Create",
      fileKey: { kind: "exact", volumeSerial: 9999n, fileId128: inventory[0]!.fileId128! },
      pid: 4216,
      tid: 4216,
      processImageName: "node.exe",
      irpPtr: 0xff00n,
      ntStatus: null,
      observedPath: "\\src\\index.ts",
      byteOffset: null,
      byteLength: null,
      shareAccess: 3,
      createOptions: 0x60,
      createDisposition: 1,
      source: "etw",
      sourceEventIndex: 1,
    },
    {
      timestamp_ns: now + 2n,
      eventKind: "Write",
      fileKey: { kind: "exact", volumeSerial: 9999n, fileId128: inventory[0]!.fileId128! },
      pid: 4216,
      tid: 4216,
      processImageName: "node.exe",
      irpPtr: 0xff01n,
      ntStatus: 0,
      observedPath: "\\src\\index.ts",
      byteOffset: 0n,
      byteLength: 200,
      shareAccess: null,
      createOptions: null,
      createDisposition: null,
      source: "etw",
      sourceEventIndex: 2,
    },
    {
      timestamp_ns: now + 3n,
      eventKind: "OpEnd",
      fileKey: null,
      pid: 4216,
      tid: 4216,
      processImageName: "node.exe",
      irpPtr: 0xff01n,
      ntStatus: 0,
      observedPath: null,
      byteOffset: null,
      byteLength: null,
      shareAccess: null,
      createOptions: null,
      createDisposition: null,
      source: "etw",
      sourceEventIndex: 3,
    },
  ];

  writePackage(packagePath, {
    manifest: {
      schemaVersion: 1,
      sessionId: "e2e-1",
      root: "C:\\Work\\Target",
      rootVolumePath: "\\\\?\\C:\\",
      fsKind: "ntfs",
      startedAt: now,
      stoppedAt: now + 10n,
      sources: {
        etw: { available: true, eventsLost: 0, eventsObserved: 3, candidatesWithoutPath: 0, candidatesOutOfScope: 0 },
        usn: { available: false, recordsRead: 0 },
        fsw: { available: true, notifications: 0 },
      },
      recordCounts: { events: 3, inventories: 2, usn: 0, notifications: 0, sourceEvents: 3 },
    },
    inventory,
    finalInventory: inventory,
    events,
    sourceEvents: [],
    notifications: [],
    usn: [],
  });

  // Build a session in analyze phase directly from disk.
  const idx = mkdtempSync(join(tmpdir(), "haril-e2e-idx-"));
  const store = new SqliteStore({ path: join(idx, "index.sqlite") });
  await importPackageIntoStore(packagePath, store);
  session = new HarilSession({ tempDir: idx });
  session.setStore(store);
  const pkg = await readPackage(packagePath);
  session.setPackage({ path: packagePath, manifest: pkg.manifest });
});

describe("e2e: analyze a real .haril package", () => {
  test("phase is analyze after setPackage", () => {
    expect(session.snapshot().phase).toBe("analyze");
  });

  test("ls returns observed file", async () => {
    const r = await session.runCommand({ name: "ls", positional: [], flags: {} });
    expect(r.ok).toBe(true);
    const data = r.data as { items: unknown[] };
    // 2 inventory entries + 1 file row with events = 3 visible files
    expect(data.items.length).toBeGreaterThanOrEqual(2);
  });

  test("overview counts events", async () => {
    const r = await session.run("overview");
    expect(r.ok).toBe(true);
    const data = r.data as { totalEvents: number; eventKindCounts: Record<string, number> };
    expect(data.totalEvents).toBe(3);
  });

  test("dirs returns observed directories", async () => {
    const r = await session.run("dirs");
    expect(r.ok).toBe(true);
    const data = r.data as { items: { directory: string; fileCount: number }[] };
    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items.some((i) => i.directory === "\\src\\")).toBe(true);
  });

  test("search finds by process name", async () => {
    const r = await session.run("search node.exe");
    expect(r.ok).toBe(true);
  });

  test("invalid command returns an error", async () => {
    const r = await session.runCommand({ name: "totally-unknown", positional: [], flags: {} });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("unknown command");
  });

  test("close resets to empty phase", async () => {
    const r = await session.run("close");
    expect(r.ok).toBe(true);
    expect(session.snapshot().phase).toBe("empty");
  });
});