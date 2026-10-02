import { describe, test, expect } from "bun:test";
import { writePackage } from "../src/package/writer.ts";
import { readPackage } from "../src/package/reader.ts";
import { unlink } from "node:fs/promises";
import type { Manifest } from "../src/model/types.ts";

describe("package roundtrip", () => {
  test("writes and reads back a small package with hashes", async () => {
    const outPath = `${import.meta.dir}/fixtures/smoke.haril`;
    await unlink(outPath).catch(() => {});

    const manifest: Omit<Manifest, "hashes"> = {
      schemaVersion: 1,
      sessionId: "test-session",
      root: "C:\\Work\\Target",
      rootVolumePath: "\\\\?\\C:\\",
      fsKind: "ntfs",
      startedAt: 1n,
      stoppedAt: 2n,
      sources: {
        etw: { available: true, eventsLost: 0, eventsObserved: 0, candidatesWithoutPath: 0, candidatesOutOfScope: 0 },
        usn: { available: false, recordsRead: 0 },
        fsw: { available: true, notifications: 0 },
      },
      recordCounts: {
        events: 0,
        inventories: 0,
        usn: 0,
        notifications: 0,
        sourceEvents: 0,
      },
    };

    const written = writePackage(outPath, {
      manifest,
      inventory: [],
      finalInventory: [],
      events: [],
      sourceEvents: [],
      notifications: [],
      usn: [],
    });

    expect(written.hashes["events.jsonl"]).toBeTruthy();
    expect(written.hashes["inventory.jsonl"]).toBeTruthy();
    expect(written.hashes["usn-events.jsonl"]).toBeTruthy();

    const contents = await readPackage(outPath);
    expect(contents.manifest.schemaVersion).toBe(1);
    expect(contents.manifest.fsKind).toBe("ntfs");
    expect(contents.manifest.sessionId).toBe("test-session");
  });

  test("rejects non-NTFS package", async () => {
    const outPath = `${import.meta.dir}/fixtures/non-ntfs.haril`;
    const manifest: Omit<Manifest, "hashes"> = {
      schemaVersion: 1,
      sessionId: "x",
      root: "C:\\",
      rootVolumePath: "\\\\?\\C:\\",
      fsKind: "refs" as "ntfs",
      startedAt: 1n,
      stoppedAt: 2n,
      sources: {
        etw: { available: false, eventsLost: 0, eventsObserved: 0, candidatesWithoutPath: 0, candidatesOutOfScope: 0 },
        usn: { available: false, recordsRead: 0 },
        fsw: { available: false, notifications: 0 },
      },
      recordCounts: { events: 0, inventories: 0, usn: 0, notifications: 0, sourceEvents: 0 },
    };
    writePackage(outPath, {
      manifest,
      inventory: [],
      finalInventory: [],
      events: [],
      sourceEvents: [],
      notifications: [],
      usn: [],
    });
    await expect(readPackage(outPath)).rejects.toThrow(/non-NTFS/);
  });
});