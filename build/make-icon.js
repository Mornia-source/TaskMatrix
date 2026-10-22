// 生成应用图标 build/icon.png（256×256）：深灰圆角底板 + 四象限色块 + 左上角的勾
// 用法：node build/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 256;
const px = Buffer.alloc(S * S * 4);

const BG = [26, 28, 31];
const EDGE = [74, 80, 90];
const Q = [[255, 77, 61], [255, 176, 32], [42, 212, 255], [140, 150, 160]];

// 圆角矩形内的覆盖率（简单 4×4 超采样抗锯齿）
function cover(x, y, x0, y0, x1, y1, r) {
  let hit = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const fx = x + (sx + 0.5) / 4, fy = y + (sy + 0.5) / 4;
      if (fx < x0 || fx > x1 || fy < y0 || fy > y1) continue;
      const cx = Math.min(Math.max(fx, x0 + r), x1 - r);
      const cy = Math.min(Math.max(fy, y0 + r), y1 - r);
      if ((fx - cx) ** 2 + (fy - cy) ** 2 <= r * r) hit++;
    }
  }
  return hit / 16;
}

function blend(i, rgb, a) {
  for (let k = 0; k < 3; k++) px[i + k] = Math.round(px[i + k] * (1 - a) + rgb[k] * a);
  px[i + 3] = Math.max(px[i + 3], Math.round(a * 255));
}

// 勾：两段粗线
function distToSeg(x, y, ax, ay, bx, by) {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay)));
}

const M = 12, GAP = 12, R = 40;
const tiles = [
  [M + 24, M + 24, 128 - GAP / 2, 128 - GAP / 2],
  [128 + GAP / 2, M + 24, S - M - 24, 128 - GAP / 2],
  [M + 24, 128 + GAP / 2, 128 - GAP / 2, S - M - 24],
  [128 + GAP / 2, 128 + GAP / 2, S - M - 24, S - M - 24],
];

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const outer = cover(x, y, M, M, S - M, S - M, R);
    if (!outer) continue;
    blend(i, EDGE, outer);
    blend(i, BG, cover(x, y, M + 4, M + 4, S - M - 4, S - M - 4, R - 4));
    tiles.forEach(([x0, y0, x1, y1], q) => {
      const a = cover(x, y, x0, y0, x1, y1, 10);
      if (a) blend(i, Q[q], a);
    });
    // Q1 色块上的勾
    const d = Math.min(distToSeg(x + 0.5, y + 0.5, 56, 84, 74, 102), distToSeg(x + 0.5, y + 0.5, 74, 102, 106, 66));
    const a = Math.max(0, Math.min(1, 8 - d));
    if (a) blend(i, BG, a);
  }
}

// 编码 PNG
function chunk(type, body) {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const td = Buffer.concat([Buffer.from(type), body]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
console.log('icon.png written');
