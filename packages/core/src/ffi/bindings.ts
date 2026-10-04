/**
 * Node-API bindings for `haril_native.node`.
 *
 * The addon is **optional**: if it cannot be found or loaded (wrong
 * architecture, missing build, N-API unavailable), this module returns
 * `null` and the runtime degrades gracefully — the TUI/MCP can still
 * open existing `.haril` packages, but capture calls raise a structured
 * error explaining how to build the addon.
 *
 * Resolution order:
 *   1. `$HARIL_NATIVE_NODE` (explicit override, file path).
 *   2. `<repo>/native/out/bin[-<arch>]/haril_native.node` (dev).
 *   3. Next to the running executable/bundle (distributed layout).
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export interface NativeInventoryRow {
  path: string;
  length: number;
  attributes: number;
  lastWriteTime: bigint;
  creationTime: bigint;
  fileId: ArrayBuffer | null;
  volumeSerial: number;
  hasFileId: boolean;
}

export interface NativeFileId {
  id: ArrayBuffer;
  volumeSerial: number;
}

export interface NativeBindings {
  version: string;
  openSession: () => unknown;
  closeSession: (ctx: unknown) => void;
  sourceStatus: (ctx: unknown, source: number) => number;
  etwStart: (ctx: unknown, session: string, root: string) => number;
  etwStop: (ctx: unknown) => number;
  etwEventsLost: (ctx: unknown) => bigint;
  etwBuffersWritten: (ctx: unknown) => bigint;
  etwEventsObserved: (ctx: unknown) => bigint;
  etwCandidatesOutOfScope: (ctx: unknown) => bigint;
  etwCandidatesWithoutPath: (ctx: unknown) => bigint;
  etwRingPushFailed: (ctx: unknown) => bigint;
  etwPushAttempted: (ctx: unknown) => bigint;
  etwKindZero: (ctx: unknown) => bigint;
  etwAfterKind: (ctx: unknown) => bigint;
  etwAfterScope: (ctx: unknown) => bigint;
  ringHead: (ctx: unknown) => bigint;
  ringTail: (ctx: unknown) => bigint;
  usnStart: (ctx: unknown, volume: string, root: string) => number;
  usnStop: (ctx: unknown) => number;
  usnRecordsRead: (ctx: unknown) => bigint;
  usnDroppedUnresolved: (ctx: unknown) => bigint;
  /** Returns an ArrayBuffer of n*256 bytes (one 256-byte slot each). */
  drain: (ctx: unknown, maxSlots: number) => ArrayBuffer;
  isAdmin: () => number;
  nowNs: () => bigint;
  fsKind: (root: string) => string | null;
  relaunchElevated: (exe: string, args: string) => number;
  getFileId: (path: string) => NativeFileId | null;
  inventoryWalk: (root: string) => NativeInventoryRow[];
}

function thisDir(): string {
  // Bun exposes import.meta.dir; Node does not — derive it portably.
  const meta = import.meta as unknown as { dir?: string; url: string };
  if (typeof meta.dir === "string") return meta.dir;
  return dirname(fileURLToPath(meta.url));
}

function candidatePaths(): string[] {
  const out: string[] = [];
  const override = process.env["HARIL_NATIVE_NODE"] ?? process.env["HARIL_NATIVE_DLL"];
  if (override) out.push(override);

  const archDir = process.arch === "arm64" ? "bin-arm64" : "bin";
  // Dev layout: <repo>/packages/core/src/ffi/bindings.ts -> <repo>/native/...
  out.push(join(thisDir(), "..", "..", "..", "..", "native", "out", archDir, "haril_native.node"));

  // Distributed layout: next to the executable or bundle.
  try {
    out.push(join(dirname(process.execPath), "haril_native.node"));
  } catch {
    // ignore
  }
  return out;
}

let cached: NativeBindings | null = null;
let attemptedLoad = false;

export function native(): NativeBindings | null {
  if (attemptedLoad) return cached;
  attemptedLoad = true;

  for (const p of candidatePaths()) {
    if (!p || !existsSync(p)) continue;
    try {
      const req = createRequire(import.meta.url);
      const mod = req(p) as NativeBindings;
      if (mod && typeof mod.openSession === "function" && typeof mod.version === "string") {
        cached = mod;
        return cached;
      }
    } catch {
      // try next candidate
    }
  }
  cached = null;
  return null;
}

/** Throw a structured error if the native addon is unavailable. */
export function requireNative(feature: string): NativeBindings {
  const n = native();
  if (!n) {
    throw new Error(
      `haril_native.node not available. ${feature} is unavailable.\n` +
        `Build it with: bun run build:native  (or: bun run build:native:arm64)\n` +
        `Or set HARIL_NATIVE_NODE to the path of an existing addon.`,
    );
  }
  return n;
}
