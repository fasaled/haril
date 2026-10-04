import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SqliteStore } from "../src/store/sqlite.ts";
import { fileKeyHash } from "../src/model/fileKey.ts";
import type { NormalizedEvent, InventoryEntry } from "../src/model/types.ts";

describe("SqliteStore", () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore({ path: ":memory:" });
  });

  afterEach(() => {
    store.close();
  });

  test("upsertFile and getFileByPath correctly resolves file by path and hash", () => {
    const fileId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const key = { kind: "exact" as const, volumeSerial: 0x1234n, fileId128: fileId };
    const hash = fileKeyHash(key);

    store.upsertFile(key, 1000n, "\\src\\app.ts");

    const byPath = store.getFileByPath("\\src\\app.ts");
    expect(byPath).not.toBeNull();
    expect(byPath!.fileKeyHash).toBe(hash);
    expect(byPath!.path).toBe("\\src\\app.ts");

    const byHash = store.getFilePathByHash(hash);
    expect(byHash).not.toBeNull();
    expect(byHash!.path).toBe("\\src\\app.ts");
  });

  test("enqueueEvent and flush inserts events with matching file_key_hash", () => {
    const fileId = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const key = { kind: "exact" as const, volumeSerial: 0x1234n, fileId128: fileId };
    const hash = fileKeyHash(key);

    const ev: NormalizedEvent = {
      timestamp_ns: 2000n,
      eventKind: "Create",
      fileKey: key,
      pid: 1234,
      tid: 5678,
      processImageName: "test.exe",
      irpPtr: 0xaa00n,
      ntStatus: 0,
      observedPath: "\\src\\app.ts",
      byteOffset: 0n,
      byteLength: 500,
      shareAccess: 1,
      createOptions: 0,
      createDisposition: 1,
      source: "etw",
      sourceEventIndex: 1,
    };

    store.enqueueEvent(ev);
    store.flush();

    const timeline = store.inspectFileTimeline({ fileKeyHash: hash, offset: 0, limit: 10 });
    expect(timeline.items.length).toBe(1);
    expect(timeline.items[0]!.eventKind).toBe("Create");
    expect(timeline.items[0]!.fileKeyHash).toBe(hash);

    const eventDetail = store.inspectFileTimelineEvent(hash, timeline.items[0]!.id);
    expect(eventDetail).not.toBeNull();
    expect(eventDetail!.processImageName).toBe("test.exe");

    const byId = store.getEventById(timeline.items[0]!.id);
    expect(byId).not.toBeNull();
    expect(byId!.fileKeyHash).toBe(hash);
  });

  test("fileActivitySummary and sessionOverview calculate totals correctly", () => {
    const fileId = new Uint8Array(16);
    fileId[0] = 42;
    const key = { kind: "exact" as const, volumeSerial: 0x9999n, fileId128: fileId };
    const hash = fileKeyHash(key);

    store.enqueueEvent({
      timestamp_ns: 1000n,
      eventKind: "Create",
      fileKey: key,
      pid: 100,
      tid: 101,
      processImageName: "procA.exe",
      irpPtr: null,
      ntStatus: 0,
      observedPath: "\\test.txt",
      byteOffset: null,
      byteLength: null,
      shareAccess: null,
      createOptions: null,
      createDisposition: null,
      source: "etw",
      sourceEventIndex: 1,
    });

    store.enqueueEvent({
      timestamp_ns: 2000n,
      eventKind: "Write",
      fileKey: key,
      pid: 100,
      tid: 101,
      processImageName: "procA.exe",
      irpPtr: null,
      ntStatus: 0xc0000001, // failed
      observedPath: "\\test.txt",
      byteOffset: 0n,
      byteLength: 100,
      shareAccess: null,
      createOptions: null,
      createDisposition: null,
      source: "etw",
      sourceEventIndex: 2,
    });

    store.flush();

    const summary = store.fileActivitySummary(hash);
    expect(summary.eventCount).toBe(2);
    expect(summary.failedCount).toBe(1);
    expect(summary.operationCounts["Create"]).toBe(1);
    expect(summary.operationCounts["Write"]).toBe(1);
    expect(summary.distinctProcessNames).toEqual(["procA.exe"]);

    const overview = store.sessionOverview();
    expect(overview.totalEvents).toBe(2);
    expect(overview.failedCount).toBe(1);
    expect(overview.totalFiles).toBe(1);
  });

  test("insertInventoryEntries populates files and computeSizeChanges detects length diffs", () => {
    const fileId = new Uint8Array(16);
    fileId[0] = 77;
    const initial: InventoryEntry[] = [
      {
        path: "\\docs\\readme.md",
        length: 100,
        attributes: 0x20,
        lastWriteTime: 1000n,
        creationTime: 1000n,
        fileId128: fileId,
        volumeSerial: 123n,
        observedAt: 1000n,
      },
    ];

    const finalInv: InventoryEntry[] = [
      {
        path: "\\docs\\readme.md",
        length: 250,
        attributes: 0x20,
        lastWriteTime: 2000n,
        creationTime: 1000n,
        fileId128: fileId,
        volumeSerial: 123n,
        observedAt: 2000n,
      },
    ];

    store.insertInventoryEntries(initial, true);
    store.insertInventoryEntries(finalInv, false);
    store.computeSizeChanges();

    const hash = fileKeyHash({ kind: "exact", volumeSerial: 123n, fileId128: fileId });
    const summary = store.fileActivitySummary(hash);
    expect(summary.initialLength).toBe(100);
    expect(summary.finalLength).toBe(250);

    const dirs = store.listDirectories(0, 10);
    expect(dirs.length).toBeGreaterThan(0);
  });
});
