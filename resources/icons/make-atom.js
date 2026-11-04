// Generates the gold atom mark for LiBER: resources/icons/appIcon.png (256),
// a 512 variant, and a matching SVG. No dependencies — PNG is encoded by hand.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const TRANSPARENT = process.argv.includes('--transparent');
const SIZE = Number(process.argv[3]) || 256;
const OUT = process.argv[2] || 'resources/icons/appIcon.png';

const GOLD_HI = [246, 208, 132];
const GOLD = [229, 178, 92];
const GOLD_LO = [176, 126, 45];

function render(W) {
  const px = Buffer.alloc(W * W * 4, 0);
  const s = W / 256; // all geometry is authored at 256 and scaled

  const blend = (x, y, r, g, b, a) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= W || y >= W || a <= 0) return;
    const i = (y * W + x) * 4;
    const src = Math.min(255, a) / 255;
    const dst = px[i + 3] / 255;
    const out = src + dst * (1 - src);
    if (out <= 0) return;
    px[i] = Math.round((r * src + px[i] * dst * (1 - src)) / out);
    px[i + 1] = Math.round((g * src + px[i + 1] * dst * (1 - src)) / out);
    px[i + 2] = Math.round((b * src + px[i + 2] * dst * (1 - src)) / out);
    px[i + 3] = Math.round(out * 255);
  };

  const R = 46 * s;
  const cx0 = W / 2, cy0 = W / 2;

  // ── plate: dark rounded square with a warm vertical gradient (skipped with --transparent)
  if (!TRANSPARENT) for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const cx = Math.min(x, W - 1 - x), cy = Math.min(y, W - 1 - y);
      let inside = true;
      if (cx < R && cy < R) inside = (R - cx) ** 2 + (R - cy) ** 2 <= R * R;
      if (!inside) continue;
      const t = y / W;
      blend(x, y, Math.round(26 - 12 * t), Math.round(25 - 12 * t), Math.round(24 - 12 * t), 255);
    }
  }

  // ── warm rim
  if (!TRANSPARENT) for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const cx = Math.min(x, W - 1 - x), cy = Math.min(y, W - 1 - y);
      const edge = (cx === 0 || cy === 0) || (cx < R && cy < R && Math.abs(Math.hypot(R - cx, R - cy) - R) < 1.3 * s);
      if (edge) blend(x, y, GOLD_HI[0], GOLD_HI[1], GOLD_HI[2], 70);
    }
  }

  // ── nucleus glow (radial falloff, warm)
  const coreR = 20 * s;
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - cx0, y - cy0);
      if (d > coreR * 2.6) continue;
      if (d <= coreR) {
        const t = d / coreR;
        blend(x, y,
          Math.round(GOLD_HI[0] + (255 - GOLD_HI[0]) * (1 - t)),
          Math.round(GOLD_HI[1] + (250 - GOLD_HI[1]) * (1 - t)),
          Math.round(GOLD_HI[2] + (225 - GOLD_HI[2]) * (1 - t)), 255);
      } else {
        const t = (d - coreR) / (coreR * 1.6);
        blend(x, y, GOLD[0], GOLD[1], GOLD[2], Math.round(46 * (1 - t)));
      }
    }
  }

  // ── three orbits: ellipse rings at 0°, 60°, 120°
  const A = 82 * s, B = 30 * s, ring = 2.5 * s;
  for (let k = 0; k < 3; k++) {
    const th = (k * Math.PI) / 3;
    const cos = Math.cos(-th), sin = Math.sin(-th);
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const dx = x - cx0, dy = y - cy0;
        if (dx * dx + dy * dy > (A + ring * 3) ** 2) continue;
        const rx = dx * cos - dy * sin;
        const ry = dx * sin + dy * cos;
        const f = (rx / A) ** 2 + (ry / B) ** 2;
        const dist = Math.abs(f - 1) * Math.min(A, B) * 0.55; // approximate px distance
        if (dist > ring * 2.2) continue;
        const a = Math.max(0, 1 - dist / (ring * 2.2));
        const hi = Math.max(0, Math.min(1, (rx + A) / (2 * A))); // brightness along the orbit
        const r = Math.round(GOLD_LO[0] + (GOLD_HI[0] - GOLD_LO[0]) * hi);
        const g = Math.round(GOLD_LO[1] + (GOLD_HI[1] - GOLD_LO[1]) * hi);
        const b = Math.round(GOLD_LO[2] + (GOLD_HI[2] - GOLD_LO[2]) * hi);
        blend(x, y, r, g, b, Math.round(255 * a));
      }
    }
  }

  return px;
}

function encodePng(px, W) {
  const raw = Buffer.alloc((W * 4 + 1) * W);
  for (let y = 0; y < W; y++) {
    raw[y * (W * 4 + 1)] = 0;
    px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  })();
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
  ]);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1a1918"/><stop offset="1" stop-color="#0e0d0c"/>
    </linearGradient>
    <linearGradient id="gold" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#F6D084"/><stop offset=".55" stop-color="#E5B25C"/><stop offset="1" stop-color="#B07E2D"/>
    </linearGradient>
    <radialGradient id="core" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#FFF3D6"/><stop offset=".55" stop-color="#F6D084"/><stop offset="1" stop-color="#E5B25C"/>
    </radialGradient>
  </defs>
  <rect x="0" y="0" width="256" height="256" rx="46" fill="url(#plate)" stroke="#F6D084" stroke-opacity=".28"/>
  <g fill="none" stroke="url(#gold)" stroke-width="2.5">
    <ellipse cx="128" cy="128" rx="82" ry="30"/>
    <ellipse cx="128" cy="128" rx="82" ry="30" transform="rotate(60 128 128)"/>
    <ellipse cx="128" cy="128" rx="82" ry="30" transform="rotate(120 128 128)"/>
  </g>
  <circle cx="128" cy="128" r="20" fill="url(#core)"/>
</svg>
`;

const atomTransparentSvg = svg
  .split('\n')
  .filter(line => !line.includes('<rect x="0" y="0"'))
  .join('\n');

const dir = path.dirname(OUT);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(OUT, encodePng(render(SIZE), SIZE));
// The plated app icon and the transparent mark are different assets: a
// transparent run must never overwrite the icon the shell actually ships.
if (TRANSPARENT) {
  fs.writeFileSync(path.join(dir, 'atom-transparent.svg'), atomTransparentSvg);
} else {
  fs.writeFileSync(path.join(dir, 'appIcon.svg'), svg);
  fs.writeFileSync(path.join(dir, 'appIcon@512.png'), encodePng(render(512), 512));
}
console.log(JSON.stringify({ png: path.resolve(OUT), size: SIZE, transparent: TRANSPARENT, bytes: fs.statSync(OUT).size }));
