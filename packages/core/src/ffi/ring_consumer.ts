/**
 * TS consumer for the native ring buffer. Polls the addon `drain`
 * (which returns an ArrayBuffer of n*SLOT_SIZE bytes) and decodes each
 * record into a NormalizedEvent plus, for USN records, the journal
 * identity carried in the slot extension block.
 *
 * Slot layout (little-endian; mirrors native/src/core.cpp):
 *   [0..1]    source            u16 (1=ETW, 2=USN, 3=FSW)
 *   [2..3]    kind              u16 (1=Create 2=Open 3=Read 4=SetInfo
 *                                    5=Write 6=Close 7=Rename 8=Delete
 *                                    9=OpEnd 10=Notify)
 *   [4..11]   timestamp_ns      u64
 *   [12..15]  pid               u32
 *   [16..19]  tid               u32
 *   [20..27]  irpPtr            u64
 *   [28..31]  ntStatus          u32
 *   [32..47]  fileId128         16 bytes
 *   [48..51]  volumeSerial      u32
 *   [52..55]  byteOffset        u32 (low 32 bits)
 *   [56..59]  byteLength        u32
 *   [60..63]  shareAccess       u32
 *   [64..67]  createOptions     u32
 *   [68..71]  createDisposition u32
 *   [72..75]  sourceEventIndex  u32
 *   [76..77]  pathLen           u16 (total UTF-16 units, up to 32767)
 *   [78..79]  procLen           u16
 *   [80..81]  extraSlots        u16 (continuation slots that follow)
 *   [112..175] processImage     UTF-16LE (32 units)
 *   USN extension (USN slots only):
 *   [176..183] fileReferenceNumber       u64
 *   [184..191] parentFileReferenceNumber u64
 *   [192..199] usn                       u64
 *   [200..203] reason                    u32
 *   [256..1023] observedPath    UTF-16LE (first PATH_INLINE_CHARS units)
 *
 * Paths longer than PATH_INLINE_CHARS continue in `extraSlots`
 * continuation slots of raw UTF-16LE (SLOT_SIZE / 2 units each), so
 * long paths (\\?\ limit) are carried without truncation.
 */
import type { NativeBindings } from "./bindings.ts";
import { native, NATIVE_SLOT_SIZE } from "./bindings.ts";
import type { NormalizedEvent, EventKind, SourceId, FileKey } from "../model/types.ts";
import { makeExactKey } from "../model/fileKey.ts";

export interface UsnSlotIdentity {
  fileReferenceNumber: bigint;
  parentFileReferenceNumber: bigint;
  usn: bigint;
  reason: number;
}

export interface DecodedSlot {
  event: NormalizedEvent;
  /** Present only for USN-sourced slots. */
  usn: UsnSlotIdentity | null;
}

export interface RingConsumer {
  poll(batchSize?: number): DecodedSlot[];
  close(): void;
}

const KIND_TO_EVENT: Record<number, EventKind> = {
  1: "Create",
  2: "Open",
  3: "Read",
  4: "SetInfo",
  5: "Write",
  6: "Close",
  7: "Rename",
  8: "Delete",
  9: "OpEnd",
  10: "Notify",
};

export const SLOT_SIZE = NATIVE_SLOT_SIZE;
export const PATH_INLINE_OFFSET = 256;
export const PATH_INLINE_CHARS = 384;
export const PROC_OFFSET = 112;
export const PROC_CHARS = 32;

export function ringConsumer(): RingConsumer | null {
  const lib = native();
  if (!lib) return null;

  let ctx: unknown = null;
  try {
    ctx = lib.openSession();
  } catch {
    return null;
  }

  return {
    poll(batchSize: number = 1024) {
      const maxSlots = Math.min(batchSize, 4096);
      let ab: ArrayBuffer;
      try {
        ab = lib.drain(ctx, maxSlots);
      } catch {
        return [];
      }
      return decodeSlots(new Uint8Array(ab));
    },
    close() {
      try {
        lib.closeSession(ctx);
      } catch {
        // ignore
      }
    },
  };
}

export function drainOnce(lib: NativeBindings, ctx: unknown, batchSize = 1024): DecodedSlot[] {
  const ab = lib.drain(ctx, batchSize);
  return decodeSlots(new Uint8Array(ab));
}

export function decodeSlots(bytes: Uint8Array): DecodedSlot[] {
  const out: DecodedSlot[] = [];
  const n = Math.floor(bytes.length / SLOT_SIZE);
  for (let i = 0; i < n; ) {
    const head = bytes.subarray(i * SLOT_SIZE, (i + 1) * SLOT_SIZE);
    const extra = Math.min(slotExtra(head), n - i - 1);
    const cont = extra > 0 ? bytes.subarray((i + 1) * SLOT_SIZE, (i + 1 + extra) * SLOT_SIZE) : undefined;
    out.push(decodeSlot(head, cont));
    i += 1 + extra;
  }
  return out;
}

function slotExtra(slot: Uint8Array): number {
  return (slot[80] ?? 0) | ((slot[81] ?? 0) << 8);
}

function readUtf16(dv: DataView, offset: number, chars: number): string {
  let s = "";
  for (let i = 0; i < chars; i++) {
    const c = dv.getUint16(offset + i * 2, true);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/**
 * Decode one record: `slot` is the head slot and `continuation` (when
 * present) holds its continuation slots with the rest of the path.
 */
export function decodeSlot(slot: Uint8Array, continuation?: Uint8Array): DecodedSlot {
  const dv = new DataView(slot.buffer, slot.byteOffset, slot.byteLength);
  const source: SourceId = slot[0] === 1 ? "etw" : slot[0] === 2 ? "usn" : "fsw";
  const kind: EventKind = KIND_TO_EVENT[dv.getUint16(2, true)] ?? "Notify";
  const ts = dv.getBigUint64(4, true);
  const pid = dv.getUint32(12, true);
  const tid = dv.getUint32(16, true);
  const irpPtr = dv.getBigUint64(20, true);
  const ntStatus = dv.getUint32(28, true);
  const fileId = new Uint8Array(slot.slice(32, 48));
  const vsn = BigInt(dv.getUint32(48, true));
  const byteOffset = BigInt(dv.getUint32(52, true));
  const byteLength = dv.getUint32(56, true);
  const shareAccess = dv.getUint32(60, true);
  const createOpts = dv.getUint32(64, true);
  const createDisp = dv.getUint32(68, true);
  const sourceIdx = dv.getUint32(72, true);

  const pathLen = dv.getUint16(76, true);
  const procLen = Math.min(dv.getUint16(78, true), PROC_CHARS);
  let path = readUtf16(dv, PATH_INLINE_OFFSET, Math.min(pathLen, PATH_INLINE_CHARS));
  if (pathLen > PATH_INLINE_CHARS && continuation) {
    const cdv = new DataView(continuation.buffer, continuation.byteOffset, continuation.byteLength);
    const rest = Math.min(pathLen - PATH_INLINE_CHARS, Math.floor(continuation.byteLength / 2));
    path += readUtf16(cdv, 0, rest);
  }
  const proc = readUtf16(dv, PROC_OFFSET, procLen);
  let fileKey: FileKey | null = null;
  let hasFileId = false;
  for (const b of fileId) {
    if (b !== 0) {
      hasFileId = true;
      break;
    }
  }
  if (hasFileId) {
    fileKey = makeExactKey(vsn, fileId);
  }

  let usn: UsnSlotIdentity | null = null;
  if (source === "usn") {
    usn = {
      fileReferenceNumber: dv.getBigUint64(176, true),
      parentFileReferenceNumber: dv.getBigUint64(184, true),
      usn: dv.getBigUint64(192, true),
      reason: dv.getUint32(200, true),
    };
  }

  return {
    event: {
      timestamp_ns: ts,
      eventKind: kind,
      fileKey,
      pid,
      tid,
      processImageName: proc || null,
      irpPtr: irpPtr === 0n ? null : irpPtr,
      ntStatus: ntStatus === 0 ? null : ntStatus,
      observedPath: path || null,
      byteOffset: byteOffset === 0n ? null : byteOffset,
      byteLength: byteLength === 0 ? null : byteLength,
      shareAccess: shareAccess === 0 ? null : shareAccess,
      createOptions: createOpts === 0 ? null : createOpts,
      createDisposition: createDisp === 0 ? null : createDisp,
      source,
      sourceEventIndex: sourceIdx,
    },
    usn,
  };
}
