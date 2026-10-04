/**
 * Portable `.haril` archive reader and validator.
 */

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { InventoryEntry, Manifest, NormalizedEvent, PathNotification, SourceEvent, UsnRecord } from "../model/types.ts";
import { readZip } from "./zip.ts";

export interface PackageContents {
  manifest: Manifest;
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

const BIGINT_KEY_RE = /(?:^|_)(?:ns|serial|FileReference|fileRef|usn|Timestamp)(?:$|_)/i;

function decodeRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "string" && /^\d{10,}$/.test(v) && BIGINT_KEY_RE.test(k)) {
      out[k] = BigInt(v);
    } else if (Array.isArray(v) && /fileId128/i.test(k)) {
      out[k] = new Uint8Array(v as number[]);
    } else {
      out[k] = v;
    }
  }
  return out as unknown as T;
}

function parseJsonl<T>(bytes: Uint8Array): T[] {
  if (bytes.length === 0) return [];
  const text = new TextDecoder().decode(bytes);
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => decodeRow<T>(JSON.parse(l)));
}

export async function readPackage(path: string): Promise<PackageContents> {
  const data = await readFile(path);
  const bytes = new Uint8Array(data);
  const entries = readZip(bytes);
  const map: Record<string, Uint8Array> = {};
  for (const e of entries) map[e.name] = e.data;

  const manifestBytes = map["manifest.json"];
  if (!manifestBytes) throw new Error("missing manifest.json");
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
  if (manifest.schemaVersion !== 1) {
    throw new Error(`unsupported schemaVersion: ${manifest.schemaVersion}`);
  }
  if (manifest.fsKind !== "ntfs") {
    throw new Error(`non-NTFS package rejected (fsKind=${manifest.fsKind})`);
  }
  for (const [name, expected] of Object.entries(manifest.hashes)) {
    const got = map[name];
    if (!got) throw new Error(`missing entry: ${name}`);
    const actual = sha256Hex(got);
    if (actual !== expected) {
      throw new Error(`hash mismatch for ${name} (expected ${expected}, got ${actual})`);
    }
  }

  return {
    manifest,
    inventory: parseJsonl<InventoryEntry>(map["inventory.jsonl"] ?? new Uint8Array(0)),
    finalInventory: parseJsonl<InventoryEntry>(map["final-inventory.jsonl"] ?? new Uint8Array(0)),
    events: parseJsonl<NormalizedEvent>(map["events.jsonl"] ?? new Uint8Array(0)),
    sourceEvents: parseJsonl<SourceEvent>(map["source-events.jsonl"] ?? new Uint8Array(0)),
    notifications: parseJsonl<PathNotification>(map["path-notifications.jsonl"] ?? new Uint8Array(0)),
    usn: parseJsonl<UsnRecord>(map["usn-events.jsonl"] ?? new Uint8Array(0)),
  };
}

export async function readPackageManifest(path: string): Promise<Manifest> {
  const data = await readFile(path);
  const bytes = new Uint8Array(data);
  const entries = readZip(bytes);
  const manifestEntry = entries.find((e) => e.name === "manifest.json");
  if (!manifestEntry) throw new Error("missing manifest.json");
  return JSON.parse(new TextDecoder().decode(manifestEntry.data)) as Manifest;
}