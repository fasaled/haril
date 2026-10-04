import { join } from "node:path";
import type { SessionSnapshot } from "../../../core/src/index.ts";

/**
 * Timestamps reach the UI in several shapes: `bigint` from live capture,
 * `number` from SQLite rows, and `string` after JSON round-trips. Package
 * timestamps are QPC-based (not wall clock), so they are shown relative
 * to the capture start rather than as dates.
 */
export function toBigIntNs(v: unknown): bigint | null {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  return null;
}

/** Reads the event timestamp regardless of row shape (`timestamp_ns` or `timestampNs`). */
export function eventTimestampNs(ev: unknown): bigint | null {
  const e = ev as { timestamp_ns?: unknown; timestampNs?: unknown } | null;
  if (!e) return null;
  return toBigIntNs(e.timestamp_ns ?? e.timestampNs);
}

/** Formats a nanosecond offset as `+MM:SS.mmm`. */
export function formatOffsetNs(offset: bigint): string {
  const neg = offset < 0n;
  const abs = neg ? -offset : offset;
  const totalMs = Number(abs / 1_000_000n);
  const m = Math.floor(totalMs / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${neg ? "-" : "+"}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

/** Formats an event timestamp relative to `baseNs` (capture start); `?` when unknown. */
export function formatEventTime(ts: unknown, baseNs: unknown): string {
  const t = toBigIntNs(ts);
  if (t === null) return "        ?";
  const base = toBigIntNs(baseNs);
  return formatOffsetNs(base === null ? t : t - base);
}

/**
 * Real filesystem location shown in the status bar. The session `cwd` is
 * root-relative inside a package, so it is joined to the capture root;
 * with no package loaded the process working directory is shown.
 */
export function displayCwd(snap: Pick<SessionSnapshot, "cwd" | "packageManifest" | "phase">): string {
  const root = snap.packageManifest?.root;
  if (snap.phase !== "empty" && root) {
    const rel = snap.cwd.replace(/^[\\/]+/, "");
    return rel ? join(root, rel) : root;
  }
  return process.cwd();
}
