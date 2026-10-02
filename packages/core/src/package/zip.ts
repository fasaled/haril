/**
 * Minimal ZIP writer/reader using STORE (no compression). Compatible with
 * every standard ZIP reader.
 *
 * We avoid `fflate` because its streaming API is async with callback-only
 * completion, which made the package code needlessly hard to test. The
 * Haril-TS `.haril` package does not need deflate: the JSONL streams are
 * already compact, and the manifest SHA-256 protects integrity.
 *
 * Layout:
 *   [local file header + file data] ... [central directory headers] ...
 *   [end of central directory record]
 */

const CRC_TABLE: number[] = (() => {
  const t = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xFF]! ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export function buildZip(entries: ZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const now = new Date();
  const dosTime = ((now.getHours() & 0x1F) << 11) | ((now.getMinutes() & 0x3F) << 5) | ((Math.floor(now.getSeconds() / 2)) & 0x1F);
  const dosDay = (((now.getFullYear() - 1980) & 0x7F) << 9) | (((now.getMonth() + 1) & 0x0F) << 5) | (now.getDate() & 0x1F);

  let offset = 0;
  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    // Local file header
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);     // signature
    lv.setUint16(4, 20, true);             // version needed
    lv.setUint16(6, 0, true);               // flags
    lv.setUint16(8, 0, true);               // compression: store
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDay, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);          // compressed size
    lv.setUint32(22, size, true);          // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);              // extra field length
    local.set(nameBytes, 30);
    localParts.push(local);
    localParts.push(entry.data);

    // Central directory header
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);              // version made by
    cv.setUint16(6, 20, true);              // version needed
    cv.setUint16(8, 0, true);               // flags
    cv.setUint16(10, 0, true);              // compression
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDay, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);              // extra
    cv.setUint16(32, 0, true);              // comment
    cv.setUint16(34, 0, true);              // disk
    cv.setUint16(36, 0, true);              // internal attrs
    cv.setUint32(38, 0, true);              // external attrs
    cv.setUint32(42, offset, true);         // local header offset
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length + entry.data.length;
  }

  const cdStart = offset;
  const cdSize = centralParts.reduce((s, p) => s + p.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  ev.setUint16(20, 0, true);

  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of localParts) { out.set(part, p); p += part.length; }
  for (const part of centralParts) { out.set(part, p); p += part.length; }
  out.set(eocd, p);
  return out;
}

export function readZip(bytes: Uint8Array): ZipEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Find EOCD
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 22 - 65535; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("EOCD not found");

  const totalEntries = dv.getUint16(eocdOffset + 10, true);
  const cdSize = dv.getUint32(eocdOffset + 12, true);
  const cdStart = dv.getUint32(eocdOffset + 16, true);

  const entries: ZipEntry[] = [];
  let p = cdStart;
  for (let n = 0; n < totalEntries; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("bad central header");
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.slice(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    // Read local header to find the data
    if (dv.getUint32(localOffset, true) !== 0x04034b50) throw new Error("bad local header");
    const lNameLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const compSize = dv.getUint32(localOffset + 18, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    entries.push({ name, data: bytes.slice(dataStart, dataStart + compSize) });
  }
  return entries;
}