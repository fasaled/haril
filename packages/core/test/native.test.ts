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

import { native, requireNative } from "../src/ffi/bindings.ts";
import { decodeSlot, decodeSlots, SLOT_SIZE } from "../src/ffi/ring_consumer.ts";

function makeSlot(fields: {
  source?: number;
  kind?: number;
  ts?: bigint;
  pid?: number;
  path?: string;
  usn?: { frn: bigint; parent: bigint; usn: bigint; reason: number };
  fileId?: number[];
}): Uint8Array {
  const slot = new Uint8Array(SLOT_SIZE);
  const dv = new DataView(slot.buffer);
  dv.setUint16(0, fields.source ?? 1, true);
  dv.setUint16(2, fields.kind ?? 1, true);
  dv.setBigUint64(4, fields.ts ?? 123n, true);
  dv.setUint32(12, fields.pid ?? 42, true);
  const path = fields.path ?? "";
  slot[76] = Math.min(path.length, 16);
  for (let i = 0; i < Math.min(path.length, 16); i++) {
    dv.setUint16(80 + i * 2, path.charCodeAt(i), true);
  }
  if (fields.fileId) {
    for (let i = 0; i < 16; i++) slot[32 + i] = fields.fileId[i] ?? 0;
  }
  if (fields.usn) {
    dv.setBigUint64(176, fields.usn.frn, true);
    dv.setBigUint64(184, fields.usn.parent, true);
    dv.setBigUint64(192, fields.usn.usn, true);
    dv.setUint32(200, fields.usn.reason, true);
  }
  return slot;
}

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