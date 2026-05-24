/**
 * Pure-JS text-to-PNG renderer. Uses vendored opentype.js for TTF/OTF
 * parsing, scanline polygon fill with 2x supersample for anti-aliasing,
 * and a hand-rolled PNG encoder (only node's `zlib` for deflate).
 *
 * No npm deps. Single TTF/OTF file in, RGBA PNG buffer out.
 *
 *   const { renderTextPng } = require("./lib/text-png");
 *   const png = renderTextPng({
 *     text:     "Hello",
 *     font:     fs.readFileSync("Inter-Bold.ttf"),
 *     fontSize: 56,
 *     color:    [255, 255, 255, 255],
 *     bgColor:  [0, 0, 0, 115],
 *     padding:  [40, 20],
 *     radius:   16,
 *   });
 *   fs.writeFileSync("out.png", png);
 */

const zlib = require("zlib");
const opentype = require("./vendor/opentype.min.js");

const SUPERSAMPLE = 2;

// ----- PATH FLATTENING -------------------------------------------------------
// Convert opentype path commands (M/L/Q/C/Z) to a flat list of polygon edges.
// Quadratic and cubic curves are subdivided until each segment is short enough
// to render as a straight line without visible kinks.

function flatten(commands) {
  const edges = [];
  let x0 = 0, y0 = 0;
  let startX = 0, startY = 0;
  for (const c of commands) {
    if (c.type === "M") {
      x0 = startX = c.x; y0 = startY = c.y;
    } else if (c.type === "L") {
      edges.push([x0, y0, c.x, c.y]);
      x0 = c.x; y0 = c.y;
    } else if (c.type === "Q") {
      subdivQuad(x0, y0, c.x1, c.y1, c.x, c.y, edges, 0);
      x0 = c.x; y0 = c.y;
    } else if (c.type === "C") {
      subdivCubic(x0, y0, c.x1, c.y1, c.x2, c.y2, c.x, c.y, edges, 0);
      x0 = c.x; y0 = c.y;
    } else if (c.type === "Z") {
      if (x0 !== startX || y0 !== startY) edges.push([x0, y0, startX, startY]);
      x0 = startX; y0 = startY;
    }
  }
  return edges;
}

function subdivQuad(x0, y0, cx, cy, x1, y1, out, depth) {
  // Flatness test: distance from control point to the line (p0, p1).
  // Below threshold or too deep → emit straight segment.
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const ux = cx - x0, uy = cy - y0;
  const cross = ux * dy - uy * dx;
  if (depth > 8 || (cross * cross) / Math.max(1e-9, len2) < 0.25) {
    out.push([x0, y0, x1, y1]);
    return;
  }
  const mx0 = (x0 + cx) / 2, my0 = (y0 + cy) / 2;
  const mx1 = (cx + x1) / 2, my1 = (cy + y1) / 2;
  const mx = (mx0 + mx1) / 2,  my = (my0 + my1) / 2;
  subdivQuad(x0, y0, mx0, my0, mx, my, out, depth + 1);
  subdivQuad(mx, my, mx1, my1, x1, y1, out, depth + 1);
}

function subdivCubic(x0, y0, c1x, c1y, c2x, c2y, x1, y1, out, depth) {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const u1 = c1x - x0, v1 = c1y - y0;
  const u2 = c2x - x0, v2 = c2y - y0;
  const cross1 = u1 * dy - v1 * dx;
  const cross2 = u2 * dy - v2 * dx;
  const flat = Math.max(cross1 * cross1, cross2 * cross2) / Math.max(1e-9, len2);
  if (depth > 9 || flat < 0.25) {
    out.push([x0, y0, x1, y1]);
    return;
  }
  // de Casteljau split at t=0.5
  const ax = (x0 + c1x) / 2, ay = (y0 + c1y) / 2;
  const bx = (c1x + c2x) / 2, by = (c1y + c2y) / 2;
  const cx = (c2x + x1) / 2, cy = (c2y + y1) / 2;
  const dxm = (ax + bx) / 2, dym = (ay + by) / 2;
  const ex = (bx + cx) / 2, ey = (by + cy) / 2;
  const fx = (dxm + ex) / 2, fy = (dym + ey) / 2;
  subdivCubic(x0, y0, ax, ay, dxm, dym, fx, fy, out, depth + 1);
  subdivCubic(fx, fy, ex, ey, cx, cy, x1, y1, out, depth + 1);
}

// ----- RASTERIZATION ---------------------------------------------------------
// Scanline even-odd fill into an 8-bit alpha buffer at `SUPERSAMPLE`x the
// target dims; downsample by averaging sub-pixels for AA.

function rasterize(edges, width, height) {
  const W = width * SUPERSAMPLE;
  const H = height * SUPERSAMPLE;
  const buf = new Uint8Array(W * H);

  // Pre-scale edge coordinates once.
  const scaled = edges.map(([x1, y1, x2, y2]) =>
    [x1 * SUPERSAMPLE, y1 * SUPERSAMPLE, x2 * SUPERSAMPLE, y2 * SUPERSAMPLE]
  );

  // Bucket edges by their y-min so each scanline only checks active edges.
  const yMinBuckets = Array.from({ length: H }, () => []);
  const yMaxOf = [];
  for (const e of scaled) {
    const yMin = Math.min(e[1], e[3]);
    const yMax = Math.max(e[1], e[3]);
    yMaxOf.push(yMax);
    const yStart = Math.max(0, Math.ceil(yMin - 0.5));
    if (yStart < H) yMinBuckets[yStart].push(e);
  }

  const active = [];
  for (let y = 0; y < H; y++) {
    // Add newly-active edges, drop edges that ended at this y.
    const yc = y + 0.5;
    for (const e of yMinBuckets[y]) active.push(e);
    for (let i = active.length - 1; i >= 0; i--) {
      const e = active[i];
      const yMin = Math.min(e[1], e[3]);
      const yMax = Math.max(e[1], e[3]);
      if (yc < yMin - 1e-9 || yc >= yMax) active.splice(i, 1);
    }

    // Intersections at this scanline.
    const xs = [];
    for (const e of active) {
      const dy = e[3] - e[1];
      if (Math.abs(dy) < 1e-9) continue;
      const t = (yc - e[1]) / dy;
      xs.push(e[0] + t * (e[2] - e[0]));
    }
    xs.sort((a, b) => a - b);

    // Even-odd fill.
    const row = y * W;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const xStart = Math.max(0, Math.ceil(xs[i] - 0.5));
      const xEnd   = Math.min(W, Math.ceil(xs[i + 1] - 0.5));
      for (let x = xStart; x < xEnd; x++) buf[row + x] = 255;
    }
  }

  // Downsample SUPERSAMPLE x SUPERSAMPLE → 1 by averaging.
  const out = new Uint8Array(width * height);
  const N = SUPERSAMPLE * SUPERSAMPLE;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let s = 0;
      const yBase = y * SUPERSAMPLE;
      const xBase = x * SUPERSAMPLE;
      for (let dy = 0; dy < SUPERSAMPLE; dy++) {
        for (let dx = 0; dx < SUPERSAMPLE; dx++) {
          s += buf[(yBase + dy) * W + (xBase + dx)];
        }
      }
      out[y * width + x] = (s / N) | 0;
    }
  }
  return out;
}

// ----- PNG ENCODING ----------------------------------------------------------
// Minimal RGBA PNG. PNG = 8-byte signature + chunks (IHDR, IDAT, IEND).
// Each chunk = length(4) + type(4) + data + CRC32(4). IDAT data is the
// raw image pre-pended with a filter byte (0 = None) per row, zlib-deflated.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(rgba, width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;            // bit depth
  ihdr[9] = 6;            // color type RGBA
  ihdr[10] = 0;           // compression
  ihdr[11] = 0;           // filter
  ihdr[12] = 0;           // interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter = None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idatData = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idatData),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ----- PUBLIC API ------------------------------------------------------------

/**
 * Render a single line of text to a PNG buffer.
 *
 * @param {object} opts
 * @param {string} opts.text       single-line caption text
 * @param {Buffer} opts.font       TTF/OTF font buffer
 * @param {number} opts.fontSize   pixel size of the text
 * @param {number[]} [opts.color]  text color [r,g,b,a] 0-255 (default white)
 * @param {number[]} [opts.bgColor] background [r,g,b,a] (default transparent)
 * @param {number[]} [opts.padding] [horizontal, vertical] inset around the
 *                                  text inside the background fill. Default
 *                                  [40, 20].
 * @param {number} [opts.radius]   background corner radius. Default 16.
 * @returns {Buffer} PNG bytes
 */
function renderTextPng(opts) {
  const text     = String(opts.text);
  const fontSize = Number(opts.fontSize || 56);
  const color    = opts.color   || [255, 255, 255, 255];
  const bgColor  = opts.bgColor || [0, 0, 0, 0];
  const pad      = opts.padding || [40, 20];
  const radius   = Math.max(0, Number(opts.radius ?? 16));

  if (!opts.font) throw new Error("renderTextPng: `font` (TTF/OTF buffer) is required");
  const fontBuf = opts.font;
  const ab = fontBuf.buffer.slice(fontBuf.byteOffset, fontBuf.byteOffset + fontBuf.byteLength);
  const font = opentype.parse(ab);

  // Place the baseline at y=fontSize so descenders stay inside the box.
  // getPath returns coords in the same units the text is laid out (we asked
  // for fontSize, so coords are already in pixels).
  const baselineY = fontSize;
  const path = font.getPath(text, 0, baselineY, fontSize);
  const bb = path.getBoundingBox();
  // Width is the advance, not just the bbox. Use the bbox right edge as the
  // safest "ink extent" - this trims trailing italic flares to the right.
  const textW = Math.ceil(bb.x2);
  const lineH = Math.ceil((font.ascender - font.descender) * (fontSize / font.unitsPerEm));

  const width  = textW + pad[0] * 2;
  const height = lineH + pad[1] * 2;

  // Translate path so that x=pad[0], baseline=pad[1] + ascent.
  const ascent = font.ascender * (fontSize / font.unitsPerEm);
  const offX = pad[0];
  const offY = pad[1] + ascent - baselineY;
  const shiftedCmds = path.commands.map((c) => {
    const out = { ...c };
    if (c.x !== undefined) out.x = c.x + offX;
    if (c.y !== undefined) out.y = c.y + offY;
    if (c.x1 !== undefined) out.x1 = c.x1 + offX;
    if (c.y1 !== undefined) out.y1 = c.y1 + offY;
    if (c.x2 !== undefined) out.x2 = c.x2 + offX;
    if (c.y2 !== undefined) out.y2 = c.y2 + offY;
    return out;
  });

  const alpha = rasterize(flatten(shiftedCmds), width, height);
  const rgba = Buffer.alloc(width * height * 4);

  // 1. Fill background (rounded rect).
  if (bgColor[3] > 0) {
    fillRoundedRect(rgba, width, height, bgColor, radius);
  }

  // 2. Composite text on top using the alpha mask.
  for (let i = 0; i < width * height; i++) {
    const a = alpha[i];
    if (a === 0) continue;
    // a is text coverage 0..255. Premultiply by color alpha.
    const ta = (a * color[3]) / 255;
    const inv = 1 - ta / 255;
    const o = i * 4;
    rgba[o    ] = Math.round(color[0] * (ta / 255) + rgba[o    ] * inv);
    rgba[o + 1] = Math.round(color[1] * (ta / 255) + rgba[o + 1] * inv);
    rgba[o + 2] = Math.round(color[2] * (ta / 255) + rgba[o + 2] * inv);
    rgba[o + 3] = Math.min(255, Math.round(ta + rgba[o + 3] * inv));
  }

  return encodePng(rgba, width, height);
}

function fillRoundedRect(rgba, w, h, [r, g, b, a], radius) {
  const R = Math.min(radius, Math.min(w, h) / 2);
  const R2 = R * R;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let inside = true;
      if (x < R && y < R) inside = (R - x) * (R - x) + (R - y) * (R - y) <= R2;
      else if (x >= w - R && y < R) inside = (x - (w - R - 1)) ** 2 + (R - y) ** 2 <= R2;
      else if (x < R && y >= h - R) inside = (R - x) ** 2 + (y - (h - R - 1)) ** 2 <= R2;
      else if (x >= w - R && y >= h - R) inside = (x - (w - R - 1)) ** 2 + (y - (h - R - 1)) ** 2 <= R2;
      if (!inside) continue;
      const o = (y * w + x) * 4;
      rgba[o    ] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = a;
    }
  }
}

module.exports = { renderTextPng };
