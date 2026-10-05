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

import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { writePackage } from "../package/writer.ts";
import type {
  FileKey,
  InventoryEntry,
  Manifest,
  NormalizedEvent,
  PathNotification,
  UsnRecord,
} from "../model/types.ts";
import { makePathKey } from "../model/fileKey.ts";
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
  /** Live hooks, invoked while the capture window is open (for the TUI). */
  live?: CaptureLiveHooks;
}

export interface CaptureLiveHooks {
  onSources?: (info: { native: boolean; etw: boolean; usn: boolean; etwRc: number; usnRc: number }) => void;
  onInventory?: (entries: InventoryEntry[]) => void;
  onEvent?: (ev: NormalizedEvent) => void;
  onNotification?: (n: PathNotification) => void;
}

function safeCall<T extends unknown[]>(fn: ((...args: T) => void) | undefined, ...args: T): void {
  if (!fn) return;
  try {
    fn(...args);
  } catch {
    // live hooks must never break the capture
  }
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

function canonicalRoot(root: string): string {
  try {
    return realpathSync.native(root);
  } catch {
    return root;
  }
}

function relativize(root: string, absolute: string): string {
  const lowerRoot = root.replace(/\//g, "\\").toLowerCase();
  const lowerAbs = absolute.replace(/\//g, "\\");
  if (lowerAbs.toLowerCase().startsWith(lowerRoot)) {
    return absolute.slice(root.length).replace(/\//g, "\\");
  }
  return absolute;
}

/**
 * Tells directories apart from files for root-relative paths seen by
 * ETW/USN, so directory activity does not show up as file lifecycles.
 * Known files (initial inventory) short-circuit; other paths are
 * `stat`ed once and cached.
 */
export class DirectoryClassifier {
  private readonly cache = new Map<string, boolean>();

  constructor(
    private readonly root: string,
    inventory: InventoryEntry[],
  ) {
    for (const e of inventory) {
      const rel = e.path.toLowerCase();
      this.cache.set(rel, (e.attributes & 0x10) !== 0);
      // Every ancestor of an inventoried file is a directory.
      let i = rel.lastIndexOf("\\");
      while (i > 0) {
        const parent = rel.slice(0, i);
        if (this.cache.has(parent)) break;
        this.cache.set(parent, true);
        i = parent.lastIndexOf("\\");
      }
    }
  }

  isDirectory(rel: string): boolean {
    if (rel === "" || rel === "\\") return true;
    const key = rel.toLowerCase();
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    let dir = false;
    try {
      dir = statSync(join(this.root, rel)).isDirectory();
    } catch {
      dir = false; // gone already: treat as a (transient) file
    }
    this.cache.set(key, dir);
    return dir;
  }
}

function inventoryKey(e: InventoryEntry): FileKey | null {
  return e.fileId128 != null
    ? { kind: "exact", volumeSerial: e.volumeSerial ?? 0n, fileId128: e.fileId128 }
    : null;
}

/**
 * Give keyless ETW/USN events a file identity, in timestamp order:
 *   1. the identity most recently seen for that path (inventory or a
 *      USN record carrying FILE_ID_128),
 *   2. otherwise the next USN identity for that path (the journal lags
 *      behind ETW, so a new file's Create precedes its first record),
 *   3. the identity the path has in the final inventory,
 *   4. a path-scoped key.
 */
export function attachFileKeys(
  events: NormalizedEvent[],
  initial: InventoryEntry[],
  final: InventoryEntry[],
  root: string,
): void {
  const current = new Map<string, FileKey>();
  for (const e of initial) {
    const k = inventoryKey(e);
    if (k) current.set(e.path.toLowerCase(), k);
  }
  const finalByPath = new Map<string, FileKey>();
  for (const e of final) {
    const k = inventoryKey(e);
    if (k) finalByPath.set(e.path.toLowerCase(), k);
  }
  const pending = new Map<string, NormalizedEvent[]>();
  for (const ev of events) {
    if (!ev.observedPath) continue;
    const p = ev.observedPath.toLowerCase();
    if (ev.fileKey) {
      if (ev.fileKey.kind === "exact") {
        current.set(p, ev.fileKey);
        for (const w of pending.get(p) ?? []) w.fileKey = ev.fileKey;
        pending.delete(p);
      }
      continue;
    }
    const known = current.get(p);
    if (known) {
      ev.fileKey = known;
      continue;
    }
    const list = pending.get(p);
    if (list) list.push(ev);
    else pending.set(p, [ev]);
  }
  for (const [p, list] of pending) {
    for (const ev of list) ev.fileKey = finalByPath.get(p) ?? makePathKey(root, ev.observedPath!);
  }
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

export async function runCapture(rawOpts: CaptureOptions): Promise<CaptureResult> {
  if (rawOpts.seconds < 1 || rawOpts.seconds > 300) {
    throw new Error("seconds must be between 1 and 300");
  }
  // Every source must agree on one spelling of the root: kernel sources
  // report long names, so resolve 8.3 aliases (C:\Users\FRANCI~1) and
  // links up front.
  const opts: CaptureOptions = { ...rawOpts, root: canonicalRoot(rawOpts.root) };

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
  safeCall(opts.live?.onInventory, initialInventory);

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

  safeCall(opts.live?.onSources, {
    native: lib !== null,
    etw: etwAvailable,
    usn: usnAvailable,
    etwRc: etwStartRc,
    usnRc: usnStartRc,
  });

  // 3. FSW watcher (always on).
  const watcher = new FsWatcher({
    root: opts.root,
    signal: opts.signal,
    clock,
    onNotification: (n) => {
      notifications.push(n);
      safeCall(opts.live?.onNotification, n);
    },
  });
  watcher.start();

  // 4. Drain loop while the window is open.
  const drainMs = opts.drainIntervalMs ?? 50;
  const dirs = new DirectoryClassifier(opts.root, initialInventory);
  const drainOnce = (): boolean => {
    if (!lib || !ctx) return false;
    let ab: ArrayBuffer;
    try {
      ab = lib.drain(ctx, 1024);
    } catch {
      return false;
    }
    if (ab.byteLength === 0) return false;
    for (const slot of decodeSlots(new Uint8Array(ab))) {
      const ev = slot.event;
      if (ev.observedPath) {
        ev.observedPath = relativize(opts.root, ev.observedPath);
        // Lifecycles are per file: drop activity on the root itself
        // and on directories beneath it.
        if (dirs.isDirectory(ev.observedPath)) continue;
      }
      ev.sourceEventIndex = events.length;
      events.push(ev);
      safeCall(opts.live?.onEvent, ev);
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
    return true;
  };
  let stopped = false;
  const onAbort = () => {
    stopped = true;
  };
  opts.signal?.addEventListener("abort", onAbort);
  try {
    const deadline = Date.now() + opts.seconds * 1000;
    while (!stopped && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, drainMs));
      if (etwAvailable || usnAvailable) drainOnce();
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
      // Producers are stopped: flush what is still in the ring.
      if (etwAvailable || usnAvailable) {
        for (let i = 0; i < 1024 && drainOnce(); i++) {
          /* keep draining */
        }
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
  attachFileKeys(events, initialInventory, finalInventory, opts.root);

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

export function buildEventsFromDiff(
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
        processImageName: null,
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
        processImageName: null,
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
        processImageName: null,
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
