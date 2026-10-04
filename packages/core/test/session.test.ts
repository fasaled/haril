/**
 * End-to-end test for FileTimelineCommands against a synthetic dataset
 * imported from a `.haril` package.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";

import { writePackage } from "../src/package/writer.ts";
import { readPackage } from "../src/package/reader.ts";
import { importPackageIntoStore } from "../src/store/import.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import { HarilSession } from "../src/session.ts";
import type { InventoryEntry, NormalizedEvent, Manifest } from "../src/model/types.ts";

let packagePath: string;
let session: HarilSession;

beforeAll(async () => {
  const tmp = mkdtempSync(join(tmpdir(), "haril-test-"));
  packagePath = join(tmp, "session.haril");

  const now = 1_000_000_000n;
  const inventory: InventoryEntry[] = [
    {
      path: "\\src\\index.ts",
      length: 100,
      attributes: 0x20,
      lastWriteTime: now,
      creationTime: now,
      fileId128: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
      volumeSerial: 1234n,
      observedAt: now,
    },
    {
      path: "\\src\\cli.ts",
      length: 50,
      attributes: 0x20,
      lastWriteTime: now,
      creationTime: now,
      fileId128: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17]),
      volumeSerial: 1234n,
      observedAt: now,
    },
  ];

  const events: NormalizedEvent[] = [
    {
      timestamp_ns: now + 1n,
      eventKind: "Create",
      fileKey: { kind: "exact", volumeSerial: 1234n, fileId128: inventory[0]!.fileId128! },
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
      fileKey: { kind: "exact", volumeSerial: 1234n, fileId128: inventory[0]!.fileId128! },
      pid: 4216,
      tid: 4216,
      processImageName: "node.exe",
      irpPtr: 0xff01n,
      ntStatus: 0,
      observedPath: "\\src\\index.ts",
      byteOffset: 0n,
      byteLength: 100,
      shareAccess: null,
      createOptions: null,
      createDisposition: null,
      source: "etw",
      sourceEventIndex: 2,
    },
    {
      timestamp_ns: now + 3n,
      eventKind: "OpEnd",
      fileKey: { kind: "exact", volumeSerial: 1234n, fileId128: inventory[0]!.fileId128! },
      pid: 4216,
      tid: 4216,
      processImageName: "node.exe",
      irpPtr: 0xff01n,
      ntStatus: 0, // STATUS_SUCCESS
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

  const manifestInput: Omit<Manifest, "hashes"> = {
    schemaVersion: 1,
    sessionId: "test-1",
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
    recordCounts: {
      events: events.length,
      inventories: 2,
      usn: 0,
      notifications: 0,
      sourceEvents: events.length,
    },
  };

  writePackage(packagePath, {
    manifest: manifestInput,
    inventory,
    finalInventory: inventory,
    events,
    sourceEvents: [],
    notifications: [],
    usn: [],
  });

  const idx = mkdtempSync(join(tmpdir(), "haril-idx-"));
  const store = new SqliteStore({ path: join(idx, "index.sqlite") });
  await importPackageIntoStore(packagePath, store);
  session = new HarilSession({ tempDir: idx });
  session.setStore(store);
  session.setPackage({ path: packagePath, manifest: await readPackage(packagePath).then((p) => p.manifest) });
});

describe("session", () => {
  test("ls returns the file with events", () => {
    const snap = session.snapshot();
    expect(snap.phase).toBe("analyze");

    return session.runCommand({ name: "ls", positional: [], flags: {} }).then((res) => {
      expect(res.ok).toBe(true);
      const data = res.data as { items: { eventCount: number }[]; hasMore: boolean };
      // Both the inventory entry and the file with events are listed.
      const withEvents = data.items.filter((i) => i.eventCount > 0);
      expect(withEvents.length).toBe(1);
      expect(withEvents[0]!.eventCount).toBe(3);
      expect(data.hasMore).toBe(false);
    });
  });

  test("search by process name returns file", async () => {
    const res = await session.run("search node.exe");
    expect(res.ok).toBe(true);
  });

  test("overview reports correct event counts", async () => {
    const res = await session.run("overview");
    expect(res.ok).toBe(true);
    const data = res.data as { totalEvents: number; eventKindCounts: Record<string, number> };
    expect(data.totalEvents).toBe(3);
    expect(data.eventKindCounts["Create"]).toBe(1);
    expect(data.eventKindCounts["Write"]).toBe(1);
    expect(data.eventKindCounts["OpEnd"]).toBe(1);
  });

  test("events inspects file timeline by path and supports op filter", async () => {
    const res = await session.run("events \\src\\index.ts");
    expect(res.ok).toBe(true);
    const data = res.data as { items: { eventKind: string }[] };
    expect(data.items.length).toBe(3);

    const filtered = await session.run("events \\src\\index.ts --op Write");
    expect(filtered.ok).toBe(true);
    const filteredData = filtered.data as { items: { eventKind: string }[] };
    expect(filteredData.items.length).toBe(1);
    expect(filteredData.items[0]!.eventKind).toBe("Write");
  });

  test("evidence retrieves event by id", async () => {
    const res = await session.run("evidence 1");
    expect(res.ok).toBe(true);
    const data = res.data as { id: number; eventKind: string };
    expect(data.id).toBe(1);
    expect(data.eventKind).toBe("Create");
  });

  test("evidence retrieves event with file and id", async () => {
    const res = await session.run("evidence \\src\\index.ts 2");
    expect(res.ok).toBe(true);
    const data = res.data as { id: number; eventKind: string };
    expect(data.id).toBe(2);
    expect(data.eventKind).toBe("Write");
  });

  test("summary returns aggregated activity for a file", async () => {
    const res = await session.run("summary \\src\\index.ts");
    expect(res.ok).toBe(true);
    const data = res.data as { eventCount: number; operationCounts: Record<string, number> };
    expect(data.eventCount).toBe(3);
    expect(data.operationCounts["Create"]).toBe(1);
  });

  test("dirs returns observed directories", async () => {
    const res = await session.run("dirs");
    expect(res.ok).toBe(true);
    const data = res.data as { items: { directory: string }[] };
    expect(data.items.length).toBeGreaterThan(0);
  });

  test("size-changes returns size changes message", async () => {
    const res = await session.run("size-changes");
    expect(res.ok).toBe(true);
  });

  test("heuristics toggles session heuristics", async () => {
    const on = await session.run("heuristics on");
    expect(on.ok).toBe(true);
    expect(session.snapshot().heuristicsEnabled).toBe(true);

    const off = await session.run("heuristics off");
    expect(off.ok).toBe(true);
    expect(session.snapshot().heuristicsEnabled).toBe(false);
  });

  test("pwd and cd change working directory", async () => {
    const pwd1 = await session.run("pwd");
    expect(pwd1.ok).toBe(true);

    const cd = await session.run("cd src");
    expect(cd.ok).toBe(true);
    expect(session.snapshot().cwd).toContain("src");
  });

  test("pagination flags offset and limit are respected", async () => {
    const paged = await session.runCommand({
      name: "ls",
      positional: [],
      flags: { offset: "0", limit: "1" },
    });
    expect(paged.ok).toBe(true);
    const data = paged.data as { items: unknown[]; hasMore: boolean };
    expect(data.items.length).toBe(1);
    expect(data.hasMore).toBe(true);
  });

  test("close transitions phase back to empty", async () => {
    const freshSession = new HarilSession();
    freshSession.setPackage({ path: packagePath, manifest: await readPackage(packagePath).then((p) => p.manifest) });
    expect(freshSession.snapshot().phase).toBe("analyze");

    const closed = await freshSession.run("close");
    expect(closed.ok).toBe(true);
    expect(freshSession.snapshot().phase).toBe("empty");
    freshSession.close();
  });

  test("empty phase rejects unknown commands", () => {
    const empty = new HarilSession();
    return expect(empty.run("ls")).resolves.toEqual(expect.objectContaining({ ok: false }));
  });

  test("empty phase start-capture requires args", () => {
    const empty = new HarilSession();
    return expect(empty.run("start-capture")).resolves.toEqual(expect.objectContaining({ ok: false }));
  });

  test("start-capture runs a real window and opens the package", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "haril-cap-test-"));
    const root = join(tmp, "watched");
    mkdirSync(root);
    writeFileSync(join(root, "a.txt"), "hello");
    const out = join(tmp, "out.haril");

    const session = new HarilSession();
    // Churn a file mid-window so the diff synthesizer emits events.
    const churn = (async () => {
      await new Promise((r) => setTimeout(r, 400));
      writeFileSync(join(root, "b.txt"), "mid-window create");
    })();
    const res = await session.run(
      `start-capture --root ${JSON.stringify(root)} --output ${JSON.stringify(out)} --seconds 1`,
    );
    await churn;
    expect(res.ok).toBe(true);
    expect(session.snapshot().phase).toBe("analyze");

    // The captured package is queryable through the normal commands.
    const ls = await session.run("ls");
    expect(ls.ok).toBe(true);
    const items = (ls.data as { items: unknown[] }).items;
    expect(items.length).toBeGreaterThanOrEqual(1);

    const ov = await session.run("overview");
    expect(ov.ok).toBe(true);
    expect((ov.data as { totalEvents: number }).totalEvents).toBeGreaterThanOrEqual(1);
    session.close();
  }, 30000);
});