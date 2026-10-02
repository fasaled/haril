/**
 * Helpers for working with FileKey and FileId128.
 *
 * FILE_ID_128 is serialized as 16 bytes. In the canonical representation
 * used by Haril-TS, the first 8 bytes are the high 64-bit half, the next
 * 8 bytes are the low 64-bit half, both little-endian.
 */

import type { FileId128, FileKey, VolumeSerial } from "./types.ts";

export const FILE_ID_128_SIZE = 16;

/** Compare two FileId128 byte-by-byte. */
export function fileId128Equals(a: FileId128, b: FileId128): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Hash a FileKey into a stable string for use as a SQLite key. */
export function fileKeyHash(key: FileKey): string {
  if (key.kind === "exact") {
    const hex = new Array<string>();
    hex.push(key.volumeSerial.toString(16));
    for (const byte of key.fileId128) {
      hex.push(byte.toString(16).padStart(2, "0"));
    }
    return "exact:" + hex.join("");
  }
  return "path:" + normalizePath(key.root) + "|" + normalizePath(key.path);
}

export function normalizePath(p: string): string {
  // Normalize Windows paths to a canonical form.
  // Convert to backslashes, lowercase drive letters, strip trailing separators.
  let s = p.replace(/\//g, "\\");
  // Lowercase drive letter
  if (s.length >= 2 && s[1] === ":") {
    s = (s[0] ?? "").toLowerCase() + s.slice(1);
  }
  // Resolve .\ and ..\ trivially (no realpath needed)
  const parts: string[] = [];
  const segments = s.split(/[\\]+/).filter(Boolean);
  for (const seg of segments) {
    if (seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  if (parts.length === 0) return "\\";
  return parts.join("\\");
}

/** Convert an exact FileKey to its display string. */
export function fileKeyDisplay(key: FileKey): string {
  if (key.kind === "exact") {
    return `id:${key.volumeSerial.toString(16)}:${bytesToHex(key.fileId128).slice(0, 8)}…`;
  }
  return `path:${normalizePath(key.path)}`;
}

export function bytesToHex(bytes: Uint8Array): string {
  const out: string[] = [];
  for (const b of bytes) {
    out.push(b.toString(16).padStart(2, "0"));
  }
  return out.join("");
}

/** Build an exact FileKey from raw numbers + 16 bytes. */
export function makeExactKey(volumeSerial: VolumeSerial, fileId128: FileId128): FileKey {
  return { kind: "exact", volumeSerial, fileId128 };
}

/** Build a path-scoped FileKey. */
export function makePathKey(root: string, path: string): FileKey {
  return { kind: "path", root: normalizePath(root), path: normalizePath(path) };
}