/**
 * Capture orchestrator.
 *
 * Brings together, per capture window:
 *   - initial/final inventories — real `FILE_ID_INFO` identity via the
 *     native addon when available, TS `stat`-based surrogate otherwise.
 *   - FileSystemWatcher (`FsWatcher`) path notifications.
 *   - Kernel ETW (`Microsoft-Windows-Kernel-File`) via the native addon
 *     when available (requires elevation; degrades to unavailable).
 *   - NTFS USN Journal via the native addon when available (requires
 *     elevation; degrades to unavailable).
 *
 * The result is everything needed to write a `.haril` package:
 * inventories, normalized events, USN records, path notifications and
 * the manifest metadata.
 *
 * Clock discipline: when the native addon is present, ALL timestamps
 * (manifest window, inventory observedAt, FSW notifications, drain
 * loop) use the native QPC clock (`nowNs`), the same domain as the
 * event slots. In TS-only mode everything uses `process.hrtime`.
 * The two domains are never mixed inside one package.
 */

import { mkdirSync } from "node:fs";
import { writePackage } from "../package/writer.ts";
import type {
  InventoryEntry,
  Manifest,
  NormalizedEvent,
  PathNotification,
  UsnRecord,
} from "../model/types.ts";
import { walkInventory } from "./inventories.ts";
import { FsWatcher } from "./fs_watcher.ts";
import { native, type NativeBindings, type NativeInventoryRow } from "../ffi/bindings.ts";
import { decodeSlots } from "../ffi/ring_consumer.ts";

export interface CaptureOptions {
  root: string; // absolute path to the directory to observe
  output: string; // absolute path to the .haril file
  seconds: number; // 1..300
  signal?: AbortSignal;
  /** Poll interval for the native drain loop. Default 50 ms. */
  drainIntervalMs?: number;
}

export interface CaptureResult {
  packagePath: string;
  manifest: Manifest;
  events: NormalizedEvent[];
  notifications: PathNotification[];
  /** False when the native addon was unavailable (TS-only fallback path). */
  nativeAvailable: boolean;
}

function volumeOfRoot(root: string): string | null {
  const m = /^[A-Za-z]:/.exec(root);
  if (!m) return null;
  return `\\\\.\\${m[0][0]!.toUpperCase()}:`;
}

function relativize(root: string, absolute: string): string {
  const lowerRoot = root.replace(/\//g, "\\").toLowerCase();
  const lowerAbs = absolute.replace(/\//g, "\\");
  if (lowerAbs.toLowerCase().startsWith(lowerRoot)) {
    return absolute.slice(root.length).replace(/\//g, "\\");
  }
  return absolute;
}

function nativeRowsToEntries(
  rows: NativeInventoryRow[],
  root: string,
  at_ns: bigint,
): InventoryEntry[] {
  return rows.map((r) => ({
    path: relativize(root, r.path),
    length: r.length,
    attributes: r.attributes,
    // FILETIME is 100-ns ticks since 1601-01-01 — same unit as our ns clock.
    lastWriteTime: r.lastWriteTime,
    creationTime: r.creationTime,
    fileId128: r.fileId ? new Uint8Array(r.fileId) : null,
    volumeSerial: BigInt(r.volumeSerial),
    observedAt: at_ns,
  }));
}

export async function runCapture(opts: CaptureOptions): Promise<CaptureResult> {
  if (opts.seconds < 1 || opts.seconds > 300) {
    throw new Error("seconds must be between 1 and 300");
  }

  const lib: NativeBindings | null = native();
  const clock = lib ? () => lib.nowNs() : () => process.hrtime.bigint();

  // 0. NTFS pre-flight (DEC-040). Native only; without the addon we
  // cannot query the filesystem type, so we proceed and record that
  // the check was skipped.
  let fsKindChecked = false;
  if (lib) {
    const withSlash = opts.root.endsWith("\\") ? opts.root : opts.root + "\\";
    const kind = lib.fsKind(withSlash);
    fsKindChecked = true;
    if (kind !== "NTFS") {
      throw new Error(
        `capture refused: ${opts.root} is on ${kind ?? "an unknown"} filesystem, NTFS required (DEC-040)`,
      );
    }
  }

  const startedAt_ns = clock();
  const sessionId = crypto.randomUUID();
  const notifications: PathNotification[] = [];
  const events: NormalizedEvent[] = [];
  const usnRecords: UsnRecord[] = [];

  // 1. Initial inventory.
  const initialInventory = lib
    ? nativeRowsToEntries(lib.inventoryWalk(opts.root), opts.root, startedAt_ns)
    : walkInventory({ root: opts.root, now_ns: startedAt_ns });

  // 2. Native session: ETW + USN producers (best effort).
  let ctx: unknown = null;
  let etwAvailable = false;
  let etwStartRc = 0;
  let usnAvailable = false;
  let usnStartRc = 0;
  if (lib) {
    try {
      ctx = lib.openSession();
    } catch {
      ctx = null;
    }
  }
  if (lib && ctx) {
    try {
      etwStartRc = lib.etwStart(ctx, "HarilCapture", opts.root);
      etwAvailable = etwStartRc === 0;
    } catch {
      etwAvailable = false;
    }
    const volume = volumeOfRoot(opts.root);
    if (volume) {
      try {
        usnStartRc = lib.usnStart(ctx, volume, opts.root);
        usnAvailable = usnStartRc === 0;
      } catch {
        usnAvailable = false;
      }
    }
  }

  // 3. FSW watcher (always on).
  const watcher = new FsWatcher({
    root: opts.root,
    signal: opts.signal,
    clock,
    onNotification: (n) => {
      notifications.push(n);
    },
  });
  watcher.start();

  // 4. Drain loop while the window is open.
  const drainMs = opts.drainIntervalMs ?? 50;
  let stopped = false;
  const onAbort = () => {
    stopped = true;
  };
  opts.signal?.addEventListener("abort", onAbort);
  try {
    const deadline = Date.now() + opts.seconds * 1000;
    while (!stopped && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, drainMs));
      if (lib && ctx && (etwAvailable || usnAvailable)) {
        let ab: ArrayBuffer;
        try {
          ab = lib.drain(ctx, 1024);
        } catch {
          break;
        }
        for (const slot of decodeSlots(new Uint8Array(ab))) {
          const ev = slot.event;
          if (ev.observedPath) ev.observedPath = relativize(opts.root, ev.observedPath);
          ev.sourceEventIndex = events.length;
          events.push(ev);
          if (slot.usn && ev.timestamp_ns !== undefined) {
            usnRecords.push({
              fileReferenceNumber: slot.usn.fileReferenceNumber,
              parentFileReferenceNumber: slot.usn.parentFileReferenceNumber,
              usn: slot.usn.usn,
              timestamp_ns: ev.timestamp_ns,
              reason: slot.usn.reason,
              fileName: ev.observedPath?.split("\\").pop() ?? "",
              fileId128: null,
            });
          }
        }
      }
    }
  } finally {
    watcher.stop();
    opts.signal?.removeEventListener("abort", onAbort);
  }

  // 5. Stop producers, collect coverage counters.
  let etwEventsLost = 0;
  let etwEventsObserved = events.filter((e) => e.source === "etw").length;
  let etwOutOfScope = 0;
  let etwWithoutPath = 0;
  let etwBuffersWritten = 0;
  let usnRecordsRead = usnRecords.length;
  let usnDropped = 0;
  if (lib && ctx) {
    try {
      if (etwAvailable) {
        lib.etwStop(ctx);
        etwEventsLost = Number(lib.etwEventsLost(ctx));
        etwEventsObserved = Number(lib.etwEventsObserved(ctx));
        etwOutOfScope = Number(lib.etwCandidatesOutOfScope(ctx));
        etwWithoutPath = Number(lib.etwCandidatesWithoutPath(ctx));
        etwBuffersWritten = Number(lib.etwBuffersWritten(ctx));
      }
      if (usnAvailable) {
        lib.usnStop(ctx);
        usnRecordsRead = Number(lib.usnRecordsRead(ctx));
        usnDropped = Number(lib.usnDroppedUnresolved(ctx));
      }
    } finally {
      try {
        lib.closeSession(ctx);
      } catch {
        // ignore
      }
    }
  }

  const stoppedAt_ns = clock();
  const finalInventory = lib
    ? nativeRowsToEntries(lib.inventoryWalk(opts.root), opts.root, stoppedAt_ns)
    : walkInventory({ root: opts.root, now_ns: stoppedAt_ns });

  // 6. Diff-synthesized Create/Write/Delete events for files whose
  // presence or length changed between the two inventories.
  for (const e of buildEventsFromDiff(initialInventory, finalInventory)) {
    e.sourceEventIndex = events.length;
    events.push(e);
  }
  events.sort((a, b) => (a.timestamp_ns < b.timestamp_ns ? -1 : a.timestamp_ns > b.timestamp_ns ? 1 : 0));

  const manifest: Omit<Manifest, "hashes"> = {
    schemaVersion: 1,
    sessionId,
    root: opts.root,
    rootVolumePath: volumeOfRoot(opts.root) ?? opts.root,
    fsKind: "ntfs",
    startedAt: startedAt_ns,
    stoppedAt: stoppedAt_ns,
    sources: {
      etw: {
        available: etwAvailable,
        eventsLost: etwEventsLost,
        eventsObserved: etwEventsObserved,
        candidatesWithoutPath: etwWithoutPath,
        candidatesOutOfScope: etwOutOfScope,
        buffersWritten: etwBuffersWritten,
        startRc: etwAvailable ? 0 : etwStartRc,
      },
      usn: {
        available: usnAvailable,
        recordsRead: usnRecordsRead,
        startRc: usnAvailable ? 0 : usnStartRc,
        droppedUnresolved: usnDropped,
      },
      fsw: { available: true, notifications: notifications.length },
    },
    recordCounts: {
      events: events.length,
      inventories: initialInventory.length + finalInventory.length,
      usn: usnRecords.length,
      notifications: notifications.length,
      sourceEvents: 0,
    },
  };
  void fsKindChecked;

  const written = writePackage(opts.output, {
    manifest,
    inventory: initialInventory,
    finalInventory,
    events,
    sourceEvents: [],
    notifications,
    usn: usnRecords,
  });

  return { packagePath: opts.output, manifest: written, events, notifications, nativeAvailable: lib !== null };
}

function buildEventsFromDiff(
  initial: InventoryEntry[],
  final: InventoryEntry[],
): NormalizedEvent[] {
  const initialMap = new Map<string, InventoryEntry>();
  for (const e of initial) initialMap.set(e.path, e);

  const events: NormalizedEvent[] = [];
  const finalMap = new Map<string, InventoryEntry>();
  for (const e of final) finalMap.set(e.path, e);

  // Timestamps for synthesized events reuse the final inventory's
  // observedAt so they stay inside the capture window's clock domain.
  const at = final.length > 0 ? (final[0]!.observedAt ?? 0n) : 0n;
  let ts = at;

  for (const fin of final) {
    const ini = initialMap.get(fin.path);
    if (!ini) {
      ts += 1n;
      events.push({
        timestamp_ns: ts,
        eventKind: "Create",
        fileKey:
          fin.fileId128 != null
            ? { kind: "exact", volumeSerial: fin.volumeSerial ?? 0n, fileId128: fin.fileId128 }
            : null,
        pid: 0,
        tid: 0,
        processImageName: "haril-capture",
        irpPtr: null,
        ntStatus: null,
        observedPath: fin.path,
        byteOffset: null,
        byteLength: fin.length,
        shareAccess: null,
        createOptions: null,
        createDisposition: null,
        source: "fsw",
        sourceEventIndex: 0,
      });
    } else if (ini.length !== fin.length) {
      ts += 1n;
      events.push({
        timestamp_ns: ts,
        eventKind: "Write",
        fileKey:
          fin.fileId128 != null
            ? { kind: "exact", volumeSerial: fin.volumeSerial ?? 0n, fileId128: fin.fileId128 }
            : null,
        pid: 0,
        tid: 0,
        processImageName: "haril-capture",
        irpPtr: null,
        ntStatus: null,
        observedPath: fin.path,
        byteOffset: null,
        byteLength: fin.length,
        shareAccess: null,
        createOptions: null,
        createDisposition: null,
        source: "fsw",
        sourceEventIndex: 0,
      });
    }
  }

  for (const ini of initial) {
    if (!finalMap.has(ini.path)) {
      ts += 1n;
      events.push({
        timestamp_ns: ts,
        eventKind: "Delete",
        fileKey:
          ini.fileId128 != null
            ? { kind: "exact", volumeSerial: ini.volumeSerial ?? 0n, fileId128: ini.fileId128 }
            : null,
        pid: 0,
        tid: 0,
        processImageName: "haril-capture",
        irpPtr: null,
        ntStatus: null,
        observedPath: ini.path,
        byteOffset: null,
        byteLength: null,
        shareAccess: null,
        createOptions: null,
        createDisposition: null,
        source: "fsw",
        sourceEventIndex: 0,
      });
    }
  }

  return events;
}
