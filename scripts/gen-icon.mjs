#!/usr/bin/env node
// Generate the HUD icons (pure Node, no third-party deps):
//   1. scripts/icon-source.png -- 1024x1024 app source image; derive the full set with
//      `npx tauri icon scripts/icon-source.png -o apps/hud/src-tauri/icons`.
//      Motif: rounded dark tile + three "session card" rows (green/amber/gray dots + text bars).
//   2. apps/hud/src-tauri/icons/tray.png -- 32x32 tray icon, the same motif redrawn for
//      the tray canvas (bolder dots/bars so it stays crisp at 16px).
//   3. apps/hud/src-tauri/icons/tray-capsule.png -- legacy "dashed capsule" tray icon,
//      kept as a fallback (point lib.rs back at it to revert).
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Canvas factory: RGBA pixel buffer + SDF drawing (samples x samples supersampled AA)
function canvas(w, h, samples = 2) {
  const px = Buffer.alloc(w * h * 4);
  function blend(i, c, a) {
    const na = (c[3] / 255) * a;
    const oa = px[i + 3] / 255;
    const outA = na + oa * (1 - na);
    if (outA <= 0) return;
    for (let k = 0; k < 3; k++) {
      px[i + k] = Math.round((c[k] * na + px[i + k] * oa * (1 - na)) / outA);
    }
    px[i + 3] = Math.round(outA * 255);
  }
  function paint(sdFn, color, alpha = 1) {
    const offs = [];
    for (let iy = 0; iy < samples; iy++)
      for (let ix = 0; ix < samples; ix++) offs.push([(ix + 0.5) / samples, (iy + 0.5) / samples]);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (const [ox, oy] of offs) if (sdFn(x + ox, y + oy) <= 0) acc++;
        if (acc > 0) blend((y * w + x) * 4, color, (alpha * acc) / offs.length);
      }
    }
  }
  return { px, paint };
}

function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  const ax = Math.max(dx, 0);
  const ay = Math.max(dy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(dx, dy), 0) - r;
}
function sdCircle(x, y, cx, cy, r) {
  return Math.hypot(x - cx, y - cy) - r;
}

// ---- Minimal PNG encoding (RGBA8, filter 0) ----
function crc32(buf) {
  if (!crc32.table) {
    crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[n] = c; // table holds raw values; single final XOR at lookup
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}
function encodePng(w, h, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 1. App icon source image (1024x1024) ----
{
  const W = 1024;
  const H = 1024;
  const { px, paint } = canvas(W, H);

  const BG = [18, 21, 27, 255];
  const EDGE = [46, 54, 67, 255];
  const BAR = [58, 66, 80, 255];
  const BAR_DIM = [44, 51, 62, 255];
  const GREEN = [52, 211, 153, 255];
  const AMBER = [251, 191, 36, 255];
  const GRAY = [107, 114, 128, 255];

  const tile = (x, y) => sdRoundRect(x, y, 512, 512, 448, 448, 190);
  paint(tile, BG);
  // inner stroke: the ring where |sd| <= 3
  paint((x, y) => Math.max(tile(x, y), -tile(x, y) - 3), EDGE, 0.9);

  const rows = [
    { cy: 330, dot: GREEN, bar: BAR },
    { cy: 512, dot: AMBER, bar: BAR },
    { cy: 694, dot: GRAY, bar: BAR_DIM },
  ];
  for (const { cy, dot, bar } of rows) {
    paint((x, y) => sdCircle(x, y, 300, cy, 66), dot);
    paint((x, y) => sdRoundRect(x, y, 655, cy, 195, 36, 36), bar);
  }
  // "breathing ring" around the first row's green dot
  paint((x, y) => Math.abs(sdCircle(x, y, 300, 330, 96)) - 7, GREEN, 0.55);

  writeFileSync(join(here, 'icon-source.png'), encodePng(W, H, px));
  console.log('wrote scripts/icon-source.png (1024x1024)');
}

// ---- 2. Tray icon (32x32, app motif redrawn) ----
{
  const S = 32;
  const { px, paint } = canvas(S, S, 3);
  const BG = [18, 21, 27, 255];
  const BAR = [58, 66, 80, 255];
  const BAR_DIM = [44, 51, 62, 255];
  const GREEN = [52, 211, 153, 255];
  const AMBER = [251, 191, 36, 255];
  const GRAY = [107, 114, 128, 255];

  // full-bleed rounded dark tile (1px transparent margin so the corners read on light taskbars)
  paint((x, y) => sdRoundRect(x, y, 16, 16, 15, 15, 7), BG);
  // same three card rows as the 1024 source; strokes bolded for the 16px render floor
  const rows = [
    { cy: 9.5, dot: GREEN, bar: BAR },
    { cy: 16, dot: AMBER, bar: BAR },
    { cy: 22.5, dot: GRAY, bar: BAR_DIM },
  ];
  for (const { cy, dot, bar } of rows) {
    paint((x, y) => sdCircle(x, y, 8.5, cy, 2.6), dot);
    paint((x, y) => sdRoundRect(x, y, 20, cy, 7, 2, 2), bar);
  }

  writeFileSync(join(here, '../apps/hud/src-tauri/icons/tray.png'), encodePng(S, S, px));
  console.log('wrote apps/hud/src-tauri/icons/tray.png (32x32, app motif)');
}

// ---- 3. Legacy tray icon (32x32 dashed capsule, fallback) ----
{
  const S = 32;
  const { px, paint } = canvas(S, S, 3);
  const GRAY = [139, 147, 161, 255]; // mid gray: visible on both dark and light taskbars
  const cx = 16;
  const cy = 16;
  const hw = 11;
  const hh = 6;
  const r = 6;
  const a = hw - r; // straight-segment half-length = 5

  // Arc-length parameter s along the capsule perimeter (= 4a + 2πr ~= 57.7px):
  // top edge 0..2a, left half-circle 2a..2a+πr, bottom edge ..4a+πr, right half-circle wraps
  const PERIM = 4 * a + 2 * Math.PI * r;
  function peri(x, y) {
    const qx = x - cx;
    const qy = y - cy;
    const t = Math.max(-a, Math.min(a, qx));
    const len = Math.hypot(qx - t, qy);
    if (len < 1e-6) return 0;
    const phi = Math.atan2(qy, qx - t);
    if (t > -a && t < a) {
      return qy < 0 ? a - t : 2 * a + Math.PI * r + (t + a);
    }
    if (qx >= a) return (phi + Math.PI / 2) * r; // right half-circle: top corner -> bottom corner
    let al = -Math.PI / 2 - phi; // left half-circle: top corner -> left pole -> bottom corner
    if (al < 0) al += 2 * Math.PI;
    return 2 * a + al * r;
  }

  // Even dashed stroke: 8px period, ~4.4px dash -> ~7 dashes (matches the CSS dashed border)
  const DASH = 8;
  const DUTY = 4.4;
  paint((x, y) => {
    if (peri(x, y) % DASH >= DUTY) return 1;
    return Math.abs(sdRoundRect(x, y, cx, cy, hw, hh, r)) - 1.1;
  }, GRAY);
  // inset solid bar (skeleton-style placeholder, same as the HUD empty state)
  paint((x, y) => sdRoundRect(x, y, cx, cy, 5.5, 1.5, 1.5), GRAY);

  writeFileSync(join(here, '../apps/hud/src-tauri/icons/tray-capsule.png'), encodePng(S, S, px));
  console.log('wrote apps/hud/src-tauri/icons/tray-capsule.png (32x32)');
}
