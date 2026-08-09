import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";

const CRC = [];
for (let n = 0, c = 0; n < 256; n += 1) {
  c = n;
  for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, "latin1");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  name.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.subarray(y * stride, y * stride + stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function lineX(ax, ay, bx, by, y) {
  if (ay === by) return ax;
  return ax + (bx - ax) * ((y - ay) / (by - ay));
}

function smooth(d, thickness) {
  return Math.max(0, Math.min(1, (thickness - d) / (Math.max(2, thickness * 0.2))));
}

function composeCanvas(size) {
  const s = size / 1024;
  const rgba = Buffer.alloc(size * size * 4);

  const topH = 168 * s;
  const topW = 512 * s;
  const bottomY = 1010 * s;
  const barY = 560 * s;
  const legThickness = 104 * s;
  const barT = 92 * s;
  const radius = 226 * s;

  const spread = 268 * s;
  const leftBottom = { x: (topW - 268) * s, y: bottomY };
  const rightBottom = { x: (topW + 268) * s, y: bottomY };
  const barLeft = { x: lineX(topW, topH, leftBottom.x, leftBottom.y, barY), y: barY };
  const barRight = { x: lineX(topW, topH, rightBottom.x, rightBottom.y, barY), y: barY };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const idx = (y * size + x) * 4;
      const cx = (px / size - 0.5) * 2;
      const cy = (py / size - 0.5) * 2;

      const inner = size / 2 - radius;
      const nx = Math.max(inner, Math.min(px, size - inner));
      const ny = Math.max(inner, Math.min(py, size - inner));
      const bgAlpha = (px - nx) * (px - nx) + (py - ny) * (py - ny) <= radius * radius ? 1 : 0;

      const glow = 0.05 + 0.1 * Math.max(0, 1 - Math.hypot(cx, cy) * 0.55);
      const topLight = Math.max(0, -cy);
      let r = Math.round(24 + 14 * glow + 26 * topLight);
      let g = Math.round(28 + 18 * glow + 30 * topLight);
      let b = Math.round(24 + 14 * glow + 26 * topLight);

      const dLeft = distToSegment(px, py, topW, topH, leftBottom.x, leftBottom.y);
      const dRight = distToSegment(px, py, topW, topH, rightBottom.x, rightBottom.y);
      const dBar = distToSegment(px, py, barLeft.x, barLeft.y, barRight.x, barRight.y);
      const shape = Math.max(smooth(dLeft, legThickness), smooth(dRight, legThickness), smooth(dBar, barT));

      if (shape > 0.01) {
        const lighten = 1 - Math.abs(cy) * 0.3;
        r = Math.round(160 + 60 * lighten);
        g = Math.round(228 + 28 * lighten);
        b = 74;
      }

      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = Math.round(bgAlpha * 255);
    }
  }
  return encodePng(size, rgba);
}

function writeIco(sizesArray) {
  const blobs = sizesArray.map((n) => ({ size: n, data: composeCanvas(n) }));
  const headerSize = 6;
  const entrySize = 16;
  let offset = headerSize + entrySize * blobs.length;
  const parts = [Buffer.alloc(headerSize)];
  parts[0].writeUInt16LE(0, 0);
  parts[0].writeUInt16LE(1, 2);
  parts[0].writeUInt16LE(blobs.length, 4);
  for (const obj of blobs) {
    const e = Buffer.alloc(entrySize);
    e[0] = obj.size === 256 ? 0 : obj.size;
    e[1] = obj.size === 256 ? 0 : obj.size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(obj.data.length, 8);
    e.writeUInt32LE(offset, 12);
    parts.push(e);
    offset += obj.data.length;
  }
  for (const obj of blobs) parts.push(obj.data);
  return Buffer.concat(parts);
}

function writeIcns(sizes) {
  const ICNS_TYPE = { 16: "icp4", 32: "icp5", 64: "icp6", 128: "ic07", 256: "ic08", 512: "ic09", 1024: "ic10" };
  const blobs = sizes.map((n) => ({ type: ICNS_TYPE[n], data: composeCanvas(n) }));
  const total = 8 + blobs.reduce((sum, it) => sum + 8 + it.data.length, 0);
  const head = Buffer.alloc(8);
  head.write("icns", 0, 4, "latin1");
  head.writeUInt32BE(total, 4);
  const parts = [head];
  for (const it of blobs) {
    const e = Buffer.alloc(8);
    e.write(it.type, 0, 4, "latin1");
    e.writeUInt32BE(8 + it.data.length, 4);
    parts.push(e, it.data);
  }
  return Buffer.concat(parts);
}

mkdirSync("build", { recursive: true });
writeFileSync("build/icon.ico", writeIco([16, 24, 32, 48, 64, 128, 256]));
writeFileSync("build/icon.icns", writeIcns([16, 32, 64, 128, 256, 512, 1024]));
writeFileSync("build/icon.png", composeCanvas(512));
writeFileSync("build/icon-1024.png", composeCanvas(1024));
console.log("Icons written to build/");