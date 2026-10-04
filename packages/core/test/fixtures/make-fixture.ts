/**
 * Generates a small but realistic .haril fixture under
 * packages/core/test/fixtures/smoke.haril so we can smoke-test the CLI
 * outside of the bun test runner.
 *
 * Usage: bun run packages/core/test/fixtures/make-fixture.ts
 */

import { mkdirSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePackage } from "../../src/package/writer.ts";
import type { InventoryEntry, NormalizedEvent, Manifest } from "../../src/model/types.ts";

const outPath = join(import.meta.dir, "smoke.haril");

// Always regenerate to keep schema in sync with the current writer.
if (existsSync(outPath)) unlinkSync(outPath);

const now = 5_000_000_000n;
const fileIdA = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10]);
const inventory: InventoryEntry[] = [
  {
    path: "\\src\\index.ts",
    length: 1024,
    attributes: 0x20,
    lastWriteTime: now,
    creationTime: now,
    fileId128: fileIdA,
    volumeSerial: 12345n,
    observedAt: now,
  },
];

const events: NormalizedEvent[] = [
  {
    timestamp_ns: now + 1n,
    eventKind: "Create",
    fileKey: { kind: "exact", volumeSerial: 12345n, fileId128: fileIdA },
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
    fileKey: { kind: "exact", volumeSerial: 12345n, fileId128: fileIdA },
    pid: 4216,
    tid: 4216,
    processImageName: "node.exe",
    irpPtr: 0xff01n,
    ntStatus: 0,
    observedPath: "\\src\\index.ts",
    byteOffset: 0n,
    byteLength: 1024,
    shareAccess: null,
    createOptions: null,
    createDisposition: null,
    source: "etw",
    sourceEventIndex: 2,
  },
  {
    timestamp_ns: now + 3n,
    eventKind: "OpEnd",
    fileKey: { kind: "exact", volumeSerial: 12345n, fileId128: fileIdA },
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

const manifest: Omit<Manifest, "hashes"> = {
  schemaVersion: 1,
  sessionId: "smoke",
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
  recordCounts: { events: 3, inventories: 1, usn: 0, notifications: 0, sourceEvents: 3 },
};

mkdirSync(dirname(outPath), { recursive: true });
writePackage(outPath, {
  manifest,
  inventory,
  finalInventory: inventory,
  events,
  sourceEvents: [],
  notifications: [],
  usn: [],
});
console.log("wrote " + outPath);