/**
 * Native addon tests.
 *
 * - Slot decoding is pure and always tested with synthetic slots.
 * - The live addon test runs only when haril_native.node loads in the
 *   current runtime/architecture; otherwise it is skipped (analyze-only).
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { native, requireNative, ensureExtractedNative, getExtractedNativeDir } from "../src/ffi/bindings.ts";
import {
  decodeSlot,
  decodeSlots,
  SLOT_SIZE,
  PATH_INLINE_OFFSET,
  PATH_INLINE_CHARS,
  PROC_OFFSET,
} from "../src/ffi/ring_consumer.ts";
import { attachFileKeys, DirectoryClassifier } from "../src/capture/capture.ts";
import type { InventoryEntry, NormalizedEvent } from "../src/model/types.ts";

/** Encodes a record (head + continuation slots) like native push_record. */
function makeRecord(fields: {
  source?: number;
  kind?: number;
  ts?: bigint;
  pid?: number;
  path?: string;
  proc?: string;
  usn?: { frn: bigint; parent: bigint; usn: bigint; reason: number };
  fileId?: number[];
}): Uint8Array {
  const path = fields.path ?? "";
  const contChars = SLOT_SIZE / 2;
  const rest = Math.max(0, path.length - PATH_INLINE_CHARS);
  const extra = Math.ceil(rest / contChars);
  const rec = new Uint8Array(SLOT_SIZE * (1 + extra));
  const dv = new DataView(rec.buffer);
  dv.setUint16(0, fields.source ?? 1, true);
  dv.setUint16(2, fields.kind ?? 1, true);
  dv.setBigUint64(4, fields.ts ?? 123n, true);
  dv.setUint32(12, fields.pid ?? 42, true);
  dv.setUint16(76, path.length, true);
  dv.setUint16(80, extra, true);
  for (let i = 0; i < path.length; i++) {
    const off = i < PATH_INLINE_CHARS ? PATH_INLINE_OFFSET + i * 2 : SLOT_SIZE + (i - PATH_INLINE_CHARS) * 2;
    dv.setUint16(off, path.charCodeAt(i), true);
  }
  const proc = fields.proc ?? "";
  dv.setUint16(78, proc.length, true);
  for (let i = 0; i < proc.length; i++) dv.setUint16(PROC_OFFSET + i * 2, proc.charCodeAt(i), true);
  if (fields.fileId) {
    for (let i = 0; i < 16; i++) rec[32 + i] = fields.fileId[i] ?? 0;
  }
  if (fields.usn) {
    dv.setBigUint64(176, fields.usn.frn, true);
    dv.setBigUint64(184, fields.usn.parent, true);
    dv.setBigUint64(192, fields.usn.usn, true);
    dv.setUint32(200, fields.usn.reason, true);
  }
  return rec;
}

const makeSlot = makeRecord;

describe("decodeSlot", () => {
  test("maps kind ids to EventKind names", () => {
    expect(decodeSlot(makeSlot({ kind: 1 })).event.eventKind).toBe("Create");
    expect(decodeSlot(makeSlot({ kind: 2 })).event.eventKind).toBe("Open");
    expect(decodeSlot(makeSlot({ kind: 4 })).event.eventKind).toBe("SetInfo");
    expect(decodeSlot(makeSlot({ kind: 5 })).event.eventKind).toBe("Write");
    expect(decodeSlot(makeSlot({ kind: 6 })).event.eventKind).toBe("Close");
    expect(decodeSlot(makeSlot({ kind: 9 })).event.eventKind).toBe("OpEnd");
    expect(decodeSlot(makeSlot({ kind: 10 })).event.eventKind).toBe("Notify");
    expect(decodeSlot(makeSlot({ kind: 99 })).event.eventKind).toBe("Notify");
  });

  test("maps source ids and reads path", () => {
    const d = decodeSlot(makeSlot({ source: 2, path: "a.txt" }));
    expect(d.event.source).toBe("usn");
    expect(d.event.observedPath).toBe("a.txt");
    expect(decodeSlot(makeSlot({ source: 3 })).event.source).toBe("fsw");
  });

  test("parses USN extension block", () => {
    const d = decodeSlot(
      makeSlot({
        source: 2,
        usn: { frn: 0x1234n, parent: 0x5n, usn: 0x999n, reason: 0x100 },
      }),
    );
    expect(d.usn).toEqual({
      fileReferenceNumber: 0x1234n,
      parentFileReferenceNumber: 0x5n,
      usn: 0x999n,
      reason: 0x100,
    });
  });

  test("ETW slots have no USN identity", () => {
    expect(decodeSlot(makeSlot({ source: 1 })).usn).toBeNull();
  });

  test("builds exact file keys from nonzero fileId128", () => {
    const d = decodeSlot(makeSlot({ fileId: [1, ...new Array(15).fill(0)] }));
    expect(d.event.fileKey?.kind).toBe("exact");
    expect(decodeSlot(makeSlot({})).event.fileKey).toBeNull();
  });

  test("decodeSlots splits batches", () => {
    const a = makeSlot({ kind: 1 });
    const b = makeSlot({ kind: 5 });
    const both = new Uint8Array([...a, ...b, 0, 0, 0]);
    const out = decodeSlots(both);
    expect(out.length).toBe(2);
    expect(out[0]!.event.eventKind).toBe("Create");
    expect(out[1]!.event.eventKind).toBe("Write");
  });

  test("reads the process image name", () => {
    expect(decodeSlot(makeSlot({ proc: "notepad.exe" })).event.processImageName).toBe("notepad.exe");
  });

  test("reassembles long paths from continuation slots", () => {
    const long = "C:\\" + Array.from({ length: 120 }, (_, i) => `segment${i}`).join("\\") + "\\file.txt";
    expect(long.length).toBeGreaterThan(PATH_INLINE_CHARS + SLOT_SIZE / 2);
    const a = makeRecord({ kind: 1, path: long });
    expect(a.length).toBeGreaterThan(SLOT_SIZE * 2);
    const b = makeRecord({ kind: 5, path: "short.txt" });
    const out = decodeSlots(new Uint8Array([...a, ...b]));
    expect(out.length).toBe(2);
    expect(out[0]!.event.observedPath).toBe(long);
    expect(out[1]!.event.eventKind).toBe("Write");
    expect(out[1]!.event.observedPath).toBe("short.txt");
  });

  test("handles the 32767-char maximum", () => {
    const long = "C:\\" + "x".repeat(32767 - 3);
    const out = decodeSlots(makeRecord({ path: long }));
    expect(out.length).toBe(1);
    expect(out[0]!.event.observedPath).toBe(long);
  });
});

describe("capture file keys", () => {
  const exact = (b: number) => {
    const id = new Uint8Array(16);
    id[0] = b;
    return id;
  };
  const inv = (path: string, id: number): InventoryEntry => ({
    path,
    length: 1,
    attributes: 0x20,
    lastWriteTime: 0n,
    creationTime: 0n,
    fileId128: exact(id),
    volumeSerial: 7n,
    observedAt: 0n,
  });
  const ev = (path: string, fileKey: NormalizedEvent["fileKey"] = null): NormalizedEvent =>
    ({ source: "etw", eventKind: "Write", observedPath: path, fileKey, timestamp_ns: 1n }) as NormalizedEvent;

  test("attaches inventory identities and path keys to keyless events", () => {
    const events = [ev("\\a.txt"), ev("\\new.txt"), ev("\\tmp.txt")];
    attachFileKeys(events, [inv("\\a.txt", 1)], [inv("\\a.txt", 1), inv("\\new.txt", 2)], "C:\\r");
    expect(events[0]!.fileKey).toEqual({ kind: "exact", volumeSerial: 7n, fileId128: exact(1) });
    expect(events[1]!.fileKey).toEqual({ kind: "exact", volumeSerial: 7n, fileId128: exact(2) });
    expect(events[2]!.fileKey?.kind).toBe("path");
  });

  test("follows USN identities seen earlier for the same path", () => {
    const usnKey = { kind: "exact" as const, volumeSerial: 7n, fileId128: exact(9) };
    const events = [ev("\\a.txt", usnKey), ev("\\A.TXT")];
    attachFileKeys(events, [inv("\\a.txt", 1)], [], "C:\\r");
    expect(events[1]!.fileKey).toEqual(usnKey);
  });

  test("backfills new files from the lagging USN record", () => {
    const usnKey = { kind: "exact" as const, volumeSerial: 7n, fileId128: exact(5) };
    const events = [ev("\\n.txt"), ev("\\n.txt"), ev("\\n.txt", usnKey)];
    attachFileKeys(events, [], [], "C:\\r");
    expect(events[0]!.fileKey).toEqual(usnKey);
    expect(events[1]!.fileKey).toEqual(usnKey);
  });

  test("classifies root and inventory ancestors as directories", () => {
    const d = new DirectoryClassifier("C:\\does-not-exist", [inv("\\sub\\deep\\f.txt", 1)]);
    expect(d.isDirectory("")).toBe(true);
    expect(d.isDirectory("\\sub")).toBe(true);
    expect(d.isDirectory("\\SUB\\deep")).toBe(true);
    expect(d.isDirectory("\\sub\\deep\\f.txt")).toBe(false);
    expect(d.isDirectory("\\gone.txt")).toBe(false);
  });
});

describe("live native addon", () => {
  test("loads, opens a session, walks an inventory", () => {
    const lib = native();
    if (!lib) {
      console.log("  (skipped: haril_native.node not loadable here)");
      return;
    }
    expect(typeof lib.version).toBe("string");
    const ctx = lib.openSession();
    expect(ctx).toBeTruthy();

    const dir = mkdtempSync(join(tmpdir(), "haril-native-test-"));
    writeFileSync(join(dir, "a.txt"), "hello");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "b.txt"), "world");

    const rows = lib.inventoryWalk(dir);
    expect(rows.length).toBe(2);
    const byName = new Map(rows.map((r) => [r.path.slice(-5), r]));
    expect(byName.get("a.txt")!.length).toBe(5);
    expect(byName.get("a.txt")!.hasFileId).toBe(true);

    const id = lib.getFileId(join(dir, "a.txt"));
    expect(id).not.toBeNull();
    expect(new Uint8Array(id!.id).length).toBe(16);

    const drained = lib.drain(ctx, 64);
    expect(drained.byteLength).toBe(0);

    lib.closeSession(ctx);
  });

  test("requireNative throws a structured error when unavailable", () => {
    // Only meaningful when the addon is missing; if it loaded, skip.
    if (native()) return;
    expect(() => requireNative("test")).toThrow(/haril_native\.node not available/);
  });
});

describe("embedded native extraction", () => {
  test("getExtractedNativeDir returns valid path containing Haril", () => {
    const dir = getExtractedNativeDir();
    expect(typeof dir).toBe("string");
    expect(dir.length).toBeGreaterThan(0);
    expect(dir.includes("Haril")).toBe(true);
  });

  test("ensureExtractedNative returns null for nonexistent arch payload", () => {
    const result = ensureExtractedNative("unknown-arch" as any);
    expect(result).toBeNull();
  });
});