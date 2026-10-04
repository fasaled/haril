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
 *   2. Next to the running executable/bundle (distributed portable layout).
 *   3. Auto-extracted embedded addon (standalone single-file layout).
 *   4. `<repo>/native/out/bin[-<arch>]/haril_native.node` (dev layout).
 *   5. Standard `%LOCALAPPDATA%/Haril/bin/<arch>/haril_native.node` directory.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { EMBEDDED_NATIVE_PAYLOADS } from "./embedded_addon.ts";

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

/**
 * Returns the directory where embedded native addons are extracted.
 * Defaults to `%LOCALAPPDATA%/Haril/bin` on Windows, or `<tmpdir>/Haril/bin`.
 */
export function getExtractedNativeDir(): string {
  const localAppData = process.env["LOCALAPPDATA"] ?? tmpdir();
  return join(localAppData, "Haril", "bin");
}

const cachedExtractedPaths = new Map<string, string>();

/**
 * Ensures the embedded native addon for the specified architecture is
 * extracted to disk in a persistent location (%LOCALAPPDATA%/Haril/bin/<arch>).
 * Returns the path on disk if available, or null if no embedded payload exists.
 */
export function ensureExtractedNative(arch: string = process.arch): string | null {
  const cached = cachedExtractedPaths.get(arch);
  if (cached) return cached;

  const payload = EMBEDDED_NATIVE_PAYLOADS[arch as "x64" | "arm64"];
  if (!payload || !payload.base64) return null;

  try {
    const dir = join(getExtractedNativeDir(), arch);
    const target = join(dir, "haril_native.node");
    const buffer = Buffer.from(payload.base64, "base64");

    if (existsSync(target)) {
      try {
        const existing = readFileSync(target);
        if (existing.length === buffer.length && existing.equals(buffer)) {
          cachedExtractedPaths.set(arch, target);
          return target;
        }
      } catch {
        // Fallback to re-writing
      }
    }

    mkdirSync(dir, { recursive: true });
    writeFileSync(target, buffer);
    cachedExtractedPaths.set(arch, target);
    return target;
  } catch {
    // If LOCALAPPDATA write fails, fallback to temp directory
    try {
      const fallbackDir = join(tmpdir(), "haril-bin", arch);
      const target = join(fallbackDir, "haril_native.node");
      const buffer = Buffer.from(payload.base64, "base64");
      mkdirSync(fallbackDir, { recursive: true });
      writeFileSync(target, buffer);
      cachedExtractedPaths.set(arch, target);
      return target;
    } catch {
      return null;
    }
  }
}

function candidatePaths(): string[] {
  const out: string[] = [];
  const override = process.env["HARIL_NATIVE_NODE"] ?? process.env["HARIL_NATIVE_DLL"];
  if (override) out.push(override);

  // 1. Distributed portable layout: next to the executable or bundle.
  try {
    out.push(join(dirname(process.execPath), "haril_native.node"));
  } catch {
    // ignore
  }

  // 2. Standalone layout: auto-extracted embedded native addon.
  try {
    const extracted = ensureExtractedNative(process.arch);
    if (extracted) out.push(extracted);
  } catch {
    // ignore
  }

  // 3. Dev layout: <repo>/packages/core/src/ffi/bindings.ts -> <repo>/native/...
  const archDir = process.arch === "arm64" ? "bin-arm64" : "bin";
  out.push(join(thisDir(), "..", "..", "..", "..", "native", "out", archDir, "haril_native.node"));

  // 4. Previously extracted locations in %LOCALAPPDATA%/Haril/bin
  try {
    out.push(join(getExtractedNativeDir(), process.arch, "haril_native.node"));
    out.push(join(getExtractedNativeDir(), "haril_native.node"));
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
