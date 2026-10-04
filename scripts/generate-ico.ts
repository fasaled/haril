/**
 * Generates assets/icon.ico from mathematical vector primitives matching assets/icon.svg.
 *
 * Produces a multi-resolution Windows icon (256x256, 48x48, 32x32, 16x16)
 * using standard 32-bit RGBA BMP/DIB structures inside an ICO container.
 *
 * Usage:
 *   bun run scripts/generate-ico.ts
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(root, "assets", "icon.ico");

interface Pixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

function inRoundedRect(
  x: number,
  y: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  radius: number,
): boolean {
  if (x < rx || x > rx + rw || y < ry || y > ry + rh) return false;
  const cx = x < rx + radius ? rx + radius : x > rx + rw - radius ? rx + rw - radius : x;
  const cy = y < ry + radius ? ry + radius : y > ry + rh - radius ? ry + rh - radius : y;
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function drawIconPixels(size: number): Pixel[][] {
  const scale = size / 256.0;
  const rows: Pixel[][] = [];

  for (let sy = 0; sy < size; sy++) {
    const row: Pixel[] = [];
    for (let sx = 0; sx < size; sx++) {
      const x = sx / scale;
      const y = sy / scale;

      // Outer rounded container (16..240, r=48)
      if (!inRoundedRect(x, y, 16, 16, 224, 224, 48)) {
        row.push({ r: 0, g: 0, b: 0, a: 0 }); // Transparent
        continue;
      }

      // Border highlight of the container
      const isBorder = !inRoundedRect(x, y, 18, 18, 220, 220, 46);
      if (isBorder) {
        row.push({ r: 46, g: 56, b: 77, a: 255 }); // #2E384D
        continue;
      }

      // Document Sheet with top-right folded corner (68..188, 56..208)
      let inSheet = false;
      if (x >= 68 && x <= 188 && y >= 56 && y <= 208) {
        if ((x - 144) + (y - 56) <= 44) {
          inSheet = true;
        } else if (y >= 100) {
          inSheet = true;
        } else if (x <= 144) {
          inSheet = true;
        }
      }

      // Folded corner tab
      const inTab = x >= 144 && x <= 188 && y >= 56 && y <= 100 && (x - 144) + (y - 56) > 44;

      // Vertical timeline axis (x ~ 102, y from 90 to 184)
      const inAxis = x >= 100 && x <= 104 && y >= 90 && y <= 184;

      // Event 1 (Origin/Create): Circle at (102, 104), r=6 + bar
      const d1 = (x - 102) ** 2 + (y - 104) ** 2;
      const inNode1 = d1 <= 6 ** 2;
      const inBar1 = x >= 134 && x <= 162 && y >= 98 && y <= 110;

      // Event 2 (Kernel pulse / Modifications): Circle at (102, 136), r=7 + ECG wave
      const d2 = (x - 102) ** 2 + (y - 136) ** 2;
      const inNode2 = d2 <= 7 ** 2;
      let inEcg = false;
      if (x >= 116 && x <= 162) {
        let targetY = 136;
        if (x <= 123) targetY = 136 + (124 - 136) * ((x - 116) / 7.0);
        else if (x <= 132) targetY = 124 + (148 - 124) * ((x - 123) / 9.0);
        else if (x <= 139) targetY = 148 + (132 - 148) * ((x - 132) / 7.0);
        else if (x <= 145) targetY = 132 + (136 - 132) * ((x - 139) / 6.0);
        if (Math.abs(y - targetY) <= 2.2) inEcg = true;
      }

      // Event 3 (Manifest / Verification): Circle at (102, 168), r=6 + bar
      const d3 = (x - 102) ** 2 + (y - 168) ** 2;
      const inNode3 = d3 <= 6 ** 2;
      const inBar3 = x >= 126 && x <= 160 && y >= 162 && y <= 174;

      // Shading and colors
      if (inNode1 || inBar1) {
        row.push({ r: 56, g: 189, b: 248, a: 255 }); // Cyan #38BDF8
      } else if (inNode2) {
        row.push({ r: 129, g: 140, b: 248, a: 255 }); // Indigo #818CF8
      } else if (inEcg) {
        row.push({ r: 96, g: 165, b: 250, a: 255 }); // Electric Blue #60A5FA
      } else if (inNode3 || inBar3) {
        row.push({ r: 52, g: 211, b: 153, a: 255 }); // Emerald #34D399
      } else if (inAxis) {
        row.push({ r: 2, g: 132, b: 199, a: 255 }); // Sky Blue
      } else if (inTab) {
        row.push({ r: 28, g: 35, b: 49, a: 255 }); // Dark Tab
      } else if (inSheet) {
        const tint = Math.floor(36 + (y - 56) * 0.08);
        row.push({ r: tint, g: tint + 8, b: tint + 24, a: 255 }); // Subtle slate blue
      } else {
        row.push({ r: 16, g: 20, b: 30, a: 255 }); // Dark Background #10141E
      }
    }
    rows.push(row);
  }
  return rows;
}

function makeIcoImage(size: number): Buffer {
  const pixels = drawIconPixels(size);

  // DIB expects bottom-to-top rows in BGRA format
  const xorBytes: number[] = [];
  for (let y = size - 1; y >= 0; y--) {
    const row = pixels[y]!;
    for (let x = 0; x < size; x++) {
      const p = row[x]!;
      xorBytes.push(p.b, p.g, p.r, p.a);
    }
  }

  // 1-bit AND mask (row size padded to 32 bits = 4 bytes)
  const rowBytes = Math.floor((size + 31) / 32) * 4;
  const andMask = Buffer.alloc(rowBytes * size, 0);

  // BITMAPINFOHEADER (40 bytes)
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight (XOR image + AND mask)
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount (32-bit RGBA)
  header.writeUInt32LE(0, 16); // biCompression (BI_RGB)
  header.writeUInt32LE(xorBytes.length + andMask.length, 20); // biSizeImage

  return Buffer.concat([header, Buffer.from(xorBytes), andMask]);
}

export function buildIco(outputPath: string, sizes = [256, 48, 32, 16]): void {
  const images = sizes.map((s) => ({ size: s, data: makeIcoImage(s) }));
  const count = images.length;
  const headerSize = 6;
  const dirEntrySize = 16;
  let offset = headerSize + count * dirEntrySize;

  const icoHeader = Buffer.alloc(headerSize);
  icoHeader.writeUInt16LE(0, 0); // reserved
  icoHeader.writeUInt16LE(1, 2); // type 1 = ICO
  icoHeader.writeUInt16LE(count, 4); // image count

  const entries: Buffer[] = [];
  const blobs: Buffer[] = [];

  for (const img of images) {
    const entry = Buffer.alloc(dirEntrySize);
    entry.writeUInt8(img.size >= 256 ? 0 : img.size, 0); // width (0 = 256)
    entry.writeUInt8(img.size >= 256 ? 0 : img.size, 1); // height
    entry.writeUInt8(0, 2); // palette colors
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(img.data.length, 8); // data size
    entry.writeUInt32LE(offset, 12); // data offset

    entries.push(entry);
    blobs.push(img.data);
    offset += img.data.length;
  }

  const finalBuffer = Buffer.concat([icoHeader, ...entries, ...blobs]);
  writeFileSync(outputPath, finalBuffer);
  console.log(`Generated ${outputPath} with sizes [${sizes.join(", ")}] (${finalBuffer.length} bytes)`);
}

buildIco(outputPath);
