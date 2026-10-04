/**
 * Portable `.haril` archive writer.
 *
 * Format: a ZIP (STORE) containing JSONL streams and a `manifest.json`.
 * Each entry has a SHA-256 hash recorded in the manifest. The manifest
 * also declares schemaVersion and `fsKind` ("ntfs" only). NTFS-only
 * enforcement (HARIL DEC-040).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import type { InventoryEntry, Manifest, NormalizedEvent, PathNotification, SourceEvent, UsnRecord } from "../model/types.ts";
import { buildZip } from "./zip.ts";

export interface PackageInput {
  manifest: Omit<Manifest, "hashes">;
  inventory: InventoryEntry[];
  finalInventory: InventoryEntry[];
  events: NormalizedEvent[];
  sourceEvents: SourceEvent[];
  notifications: PathNotification[];
  usn: UsnRecord[];
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function encodeJsonl<T>(rows: T[]): Uint8Array {
  if (rows.length === 0) return new Uint8Array(0);
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(JSON.stringify(row, (_key, value) => {
      if (typeof value === "bigint") return value.toString();
      if (value instanceof Uint8Array) return Array.from(value);
      return value;
    }));
  }
  return new TextEncoder().encode(lines.join("\n") + "\n");
}

export function writePackage(outPath: string, input: PackageInput): Manifest {
  const data: Record<string, Uint8Array> = {
    "inventory.jsonl": encodeJsonl(input.inventory),
    "final-inventory.jsonl": encodeJsonl(input.finalInventory),
    "events.jsonl": encodeJsonl(input.events),
    "source-events.jsonl": encodeJsonl(input.sourceEvents),
    "path-notifications.jsonl": encodeJsonl(input.notifications),
    "usn-events.jsonl": encodeJsonl(input.usn),
  };

  const hashes: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(data)) {
    hashes[name] = sha256Hex(bytes);
  }

  const manifest: Manifest = { ...input.manifest, hashes };
  data["manifest.json"] = new TextEncoder().encode(JSON.stringify(manifest, (_k, v) => {
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Uint8Array) return Array.from(v);
    return v;
  }, 2));

  const entries = Object.entries(data).map(([name, bytes]) => ({ name, data: bytes }));
  const zipBytes = buildZip(entries);

  const dir = dirname(outPath);
  if (dir && dir !== "." && dir !== "") {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(outPath, zipBytes);

  return manifest;
}