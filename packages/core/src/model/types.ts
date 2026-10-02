/**
 * Core data model types.
 *
 * Identity: a file is keyed by exact 128-bit `FILE_ID_INFO` when the volume
 * provided it; otherwise it is path-scoped. A path alone never proves
 * continuity across renames or moves.
 */

export type FileId128 = Uint8Array; // 16 bytes, little-endian high/low halves
export type VolumeSerial = bigint; // u32

export type FileKey =
  | { kind: "exact"; volumeSerial: VolumeSerial; fileId128: FileId128 }
  | { kind: "path"; root: string; path: string };

export type EventKind =
  | "Create"
  | "Open"
  | "Read"
  | "Write"
  | "SetInfo"
  | "Rename"
  | "Delete"
  | "Close"
  | "OpEnd"
  | "Notify";

export type SourceId = "etw" | "usn" | "fsw";

export interface NormalizedEvent {
  timestamp_ns: bigint; // QPC base
  eventKind: EventKind;
  fileKey: FileKey | null;
  pid: number;
  tid: number;
  processImageName: string | null;
  irpPtr: bigint | null;
  ntStatus: number | null;
  observedPath: string | null;
  byteOffset: bigint | null;
  byteLength: number | null;
  shareAccess: number | null;
  createOptions: number | null;
  createDisposition: number | null;
  source: SourceId;
  sourceEventIndex: number;
}

export interface InventoryEntry {
  path: string;
  length: number;
  attributes: number;
  lastWriteTime: bigint;
  creationTime: bigint;
  fileId128: FileId128 | null;
  volumeSerial: VolumeSerial | null;
  observedAt: bigint;
}

export interface UsnRecord {
  fileReferenceNumber: bigint;
  parentFileReferenceNumber: bigint;
  usn: bigint;
  timestamp_ns: bigint;
  reason: number;
  fileName: string;
  fileId128: FileId128 | null; // present for V4
}

export interface PathNotification {
  timestamp_ns: bigint;
  kind: "create" | "modify" | "delete" | "rename";
  path: string;
  oldPath: string | null;
  pid: number | null;
}

export interface Manifest {
  schemaVersion: 1;
  sessionId: string;
  root: string;
  rootVolumePath: string;
  fsKind: "ntfs";
  startedAt: bigint;
  stoppedAt: bigint;
  sources: {
    etw: { available: boolean; eventsLost: number; eventsObserved: number; candidatesWithoutPath: number; candidatesOutOfScope: number; buffersWritten?: number; startRc?: number };
    usn: { available: boolean; recordsRead: number; startRc?: number; droppedUnresolved?: number };
    fsw: { available: boolean; notifications: number };
  };
  recordCounts: {
    events: number;
    inventories: number;
    usn: number;
    notifications: number;
    sourceEvents: number;
  };
  hashes: Record<string, string>;
}

export interface SourceEvent {
  index: number;
  source: SourceId;
  raw: Record<string, unknown>;
}

export interface CommandResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  kind: "text" | "json" | "none" | "error";
}

export interface EventFilter {
  opKinds?: EventKind[];
  failedOnly?: boolean;
  pid?: number;
  processName?: string;
}

export type Phase = "empty" | "live-capture" | "analyze";