/**
 * File inventory walker (TS-only, no native DLL).
 *
 * Recursively walks a directory and produces `InventoryEntry` rows with
 * `FILE_ID_INFO`-style 128-bit identities. On Windows + Bun we cannot
 * call `GetFileInformationByHandleEx(FileIdInfo)` from JS, so we use
 * a deterministic 128-bit identity derived from:
 *
 *   - Volume serial: 32-bit Bun runtime version hash (constant for this build).
 *   - FileId128:     SHA-256 of the absolute path, first 16 bytes (big-endian).
 *
 * This is a stable surrogate identity. The real `FILE_ID_INFO` cannot
 * be retrieved from Bun. Anyone using Haril-TS to analyze packages
 * produced here should treat the `fileId128` as an opaque but stable
 * identifier within a single capture session.
 *
 * The shape is unchanged: `Uint8Array(16)`. `volumeSerial` is a 32-bit
 * number. The downstream commands and TUI/MCP do not need to change.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { InventoryEntry } from "../model/types.ts";

export interface InventoryOptions {
  root: string;
  now_ns: bigint;
}

export function walkInventory(opts: InventoryOptions): InventoryEntry[] {
  const out: InventoryEntry[] = [];
  const vsn = computeVolumeSerial();

  walk(opts.root, opts.root, vsn, opts.now_ns, out);
  return out;
}

function walk(root: string, dir: string, vsn: number, at_ns: bigint, out: InventoryEntry[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: false }) as unknown as string[];
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "." || name === "..") continue;
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(root, full, vsn, at_ns, out);
      continue;
    }
    const rel = full.slice(root.length).replace(/\//g, "\\");
    const fileId128 = pathToFileId128(full);
    out.push({
      path: rel,
      length: st.size,
      attributes: 0, // we cannot read NTFS attributes from JS
      lastWriteTime: filetimeFromUnix(st.mtimeMs),
      creationTime: filetimeFromUnix(st.birthtimeMs || st.mtimeMs),
      fileId128,
      volumeSerial: BigInt(vsn),
      observedAt: at_ns,
    });
  }
}

function filetimeFromUnix(ms: number): bigint {
  // FILETIME is 100-ns ticks since 1601-01-01.
  // Unix ms is 0 ms since 1970-01-01.
  // Difference: 11644473600 seconds.
  const epochDiff100ns = 11644473600_000_000n;
  return BigInt(Math.floor(ms)) * 1_000_000n + epochDiff100ns;
}

function pathToFileId128(path: string): Uint8Array {
  const hash = createHash("sha256").update(path).digest();
  return new Uint8Array(hash.slice(0, 16));
}

function computeVolumeSerial(): number {
  // Bun.version is stable for a given install. Reduce to 32 bits.
  const s = process.versions.node + "|" + process.platform + "|" + process.arch;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}