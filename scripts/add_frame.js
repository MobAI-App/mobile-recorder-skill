#!/usr/bin/env node
/**
 * Composite the (highlighted) recording inside a phone-bezel + background
 * canvas. The next pipeline stage (add_zoom) operates on this composite —
 * "zoom" then means "camera moves closer to the framed phone," not "crop
 * deeper into the screen content."
 *
 *   node add_frame.js <input.mp4> <output.mp4> [flags]
 *
 * Default behavior:
 *   - 1620×2880 canvas — vertical 9:16, 1.5× the 1080×1920 export so zoom-in
 *     stays sharp. The aspect matches the skill's default vertical_9_16
 *     exporter so the exporter scales 1:1 instead of letterboxing a small
 *     scene inside black bars. Override with --canvas for other aspects,
 *     e.g. 2880x1620 for horizontal_16_9 or 1620x1620 for square_1_1.
 *   - dark grey background
 *   - the recording is letterbox-fit into a centered rectangle, leaving
 *     visible background around it
 *   - a bezel band wraps the recording; the bezel's rounded inner cut-out
 *     is what the viewer sees as the screen's rounded corners
 *   - <output>.frame.json sidecar carries the geometry downstream
 *
 * Performance: per frame we only do (scale, overlay, overlay). No per-frame
 * alphamerge, no per-pixel geq — those run once during template generation
 * and the result is cached in $TMPDIR.
 *
 * For the bezel to cleanly cover the rectangular recording's corners, the
 * bezel thickness must be at least ~0.42 × screen-radius (geometry of a
 * rounded rect vs. its bounding box at the corners). When --bezel-thickness
 * is below that, the script raises it to a safe minimum and logs a notice.
 *
 * Flags:
 *   --canvas WxH              Composite canvas. Default 1620x2880 — vertical
 *                             9:16 at 1.5× the 1080x1920 export, so zoom-in
 *                             stays sharp. Rule: canvas ≥ peak_zoom ×
 *                             export_size, AND canvas aspect should match
 *                             the export aspect (otherwise the exporter
 *                             pads or crops to fit). For a 1920x1080
 *                             horizontal export with 1.5× zoom, pass
 *                             2880x1620.
 *   --bg-color RRGGBB         Background color. Default 2c2c2e.
 *   --bg-image PATH           Background image (overrides --bg-color and
 *                             --bg-gradient). Scaled to fill the canvas,
 *                             center-cropped. Use this for branded photos
 *                             or pre-designed art.
 *   --bg-gradient TOP:BOTTOM  Procedural vertical gradient between two hex
 *                             colors (no '#', e.g. "1f2937:6b21a8" for
 *                             slate→purple). Cached as a PNG in $TMPDIR.
 *   --screen-margin PX        Min distance from canvas edge to bezel
 *                             exterior. Default 240. Bigger = more visible
 *                             background, smaller phone.
 *   --bezel-thickness PX      Bezel band thickness. Default 28; raised to
 *                             cover corner cutouts when --screen-radius
 *                             is large.
 *   --bezel-color RRGGBB      Bezel color. Default 0a0a0a.
 *   --screen-radius PX        Inner screen corner radius. Default 56.
 *   --dynamic-island on|off   Render the iPhone Dynamic Island pill at the
 *                             top of the screen. Default on. Disable for
 *                             Android / older iPhones / generic mockups.
 *   --island-width-frac F     Island width as a fraction of screen width.
 *                             Default 0.28 (matches iPhone 14/15/16/17 Pro).
 *   --island-height-frac F    Island height as a fraction of screen height.
 *                             Default 0.042.
 *   --island-top-frac F       Island top offset as a fraction of screen
 *                             height. Default 0.013.
 *   --bezel-png PATH          Pre-rendered bezel art (transparent screen
 *                             area). Overrides all procedural --bezel-*
 *                             flags. Requires --screen-rect. Use for
 *                             photo-realistic / branded device mockups —
 *                             see references/editor.md for sources.
 *   --screen-rect X,Y,W,H     Where the screen sits inside --bezel-png.
 *                             Required with --bezel-png; ignored otherwise.
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { probeFps } = require("./lib/editor");

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error("usage: add_frame.js <input.mp4> <output.mp4> [flags]");
  process.exit(2);
}
const [INPUT, OUTPUT] = argv.slice(0, 2);

function readFlag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
}
function parseWH(s, fallback) {
  if (!s) return fallback;
  const m = s.match(/^(\d+)x(\d+)$/);
  if (!m) { console.error(`invalid WxH "${s}"`); process.exit(2); }
  return { w: Number(m[1]), h: Number(m[2]) };
}
function parseRect(s) {
  if (!s) return null;
  const parts = s.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    console.error(`invalid --screen-rect "${s}"; expected X,Y,W,H`);
    process.exit(2);
  }
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

// Default canvas is 1.5× the 1080×1920 vertical export so zoom-in stays
// sharp: the static layers (bezel, gradient bg) and the recording have
// extra resolution to show when zoompan crops in. The aspect matches the
// skill's default vertical_9_16 exporter — if you change to a horizontal
// or square export, change this default to match (otherwise the exporter
// will pad/crop). Rule of thumb:
//   canvas ≥ peak_zoom_scale × export_resolution  AND  same aspect ratio
const canvas         = parseWH(readFlag("--canvas", "1620x2880"));
const BG_COLOR       = readFlag("--bg-color", "2c2c2e");
const BG_IMAGE       = readFlag("--bg-image", null);
// Procedural vertical gradient. Format: "TOP_HEX:BOTTOM_HEX" (no #), e.g.
// "1f2937:6b21a8" for slate→purple. --bg-image wins if both are set.
const BG_GRADIENT    = readFlag("--bg-gradient", null);
// 240 px default margin → phone fills ~50% width, ~62% height of the canvas,
// leaving roughly a quarter of the frame as visible background on each side
// and ~20% strips top + bottom. Tune larger for an even smaller phone, or
// down to ~100 for an edge-to-edge mockup.
const SCREEN_MARGIN  = Number(readFlag("--screen-margin", "240"));
// Defaults for radius/bezel scale with the phone size so a small phone on
// a landscape canvas doesn't end up with comically thick bezels. Real
// iPhone bezel is ~3% of width; screen radius is ~12% of width. We mirror
// that. Use "auto" sentinel to keep the proportional default after a
// later override; pass explicit pixels to pin a value.
const SCREEN_RADIUS_IN = readFlag("--screen-radius", "auto");
const BEZEL_COLOR    = readFlag("--bezel-color", "0a0a0a");
const BEZEL_PNG_IN   = readFlag("--bezel-png", null);
const SCREEN_RECT_IN = parseRect(readFlag("--screen-rect", null));
// Dynamic Island — the pill cutout near the top of modern iPhones. Sized
// as a fraction of the screen so it scales with the recording. Set to
// "off"/"0"/"none" to suppress (e.g. for Android / older iPhones).
const ISLAND_MODE    = readFlag("--dynamic-island", "on").toLowerCase();
const ISLAND_ON      = !["off", "none", "0", "false", "no"].includes(ISLAND_MODE);
// Geometry as fractions of screen-rect (matches iPhone 14/15/16/17 Pro):
const ISLAND_W_FRAC  = Number(readFlag("--island-width-frac", "0.28"));
const ISLAND_H_FRAC  = Number(readFlag("--island-height-frac", "0.042"));
const ISLAND_TOP_FRAC = Number(readFlag("--island-top-frac", "0.013"));

// Defer SCREEN_RADIUS + BEZEL_T resolution until after screen-rect is
// known, so proportional defaults can scale with phone size.
const BEZEL_T_IN = readFlag("--bezel-thickness", "auto");

if (!fs.existsSync(INPUT)) { console.error(`not found: ${INPUT}`); process.exit(3); }
if (BG_IMAGE && !fs.existsSync(BG_IMAGE)) { console.error(`--bg-image not found: ${BG_IMAGE}`); process.exit(3); }
if (BEZEL_PNG_IN && !fs.existsSync(BEZEL_PNG_IN)) { console.error(`--bezel-png not found: ${BEZEL_PNG_IN}`); process.exit(3); }
if (BEZEL_PNG_IN && !SCREEN_RECT_IN) {
  console.error("--bezel-png requires --screen-rect X,Y,W,H");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// probe input dimensions to compute the screen rect from the recording aspect

const probe = spawnSync("ffprobe", [
  "-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=width,height",
  "-of", "default=noprint_wrappers=1", INPUT,
]);
if (probe.status !== 0) { console.error("ffprobe failed:", probe.stderr.toString()); process.exit(4); }
const probeFields = Object.fromEntries(
  probe.stdout.toString().trim().split("\n").map((line) => {
    const eq = line.indexOf("=");
    return [line.slice(0, eq), line.slice(eq + 1)];
  }),
);
const inputW = Number(probeFields.width);
const inputH = Number(probeFields.height);
const inputAspect = inputW / inputH;

// ---------------------------------------------------------------------------
// resolve screen rect (where the recording sits inside the canvas)
//
// Phone proportions (real iPhone): bezel ~3% of screen width, screen
// corner radius ~12% of screen width. We default to those so a phone
// scaled into a small region of the canvas doesn't end up looking like a
// chunky brick. The dependency is circular (final screen.w depends on
// bezel_t which depends on screen.w), so we estimate phone width with
// bezel=0 first, derive proportional defaults, then compute the real
// screen-rect.

function fitScreen(bezelT) {
  const maxW = canvas.w - 2 * (SCREEN_MARGIN + bezelT);
  const maxH = canvas.h - 2 * (SCREEN_MARGIN + bezelT);
  let sw, sh;
  if (maxW / maxH > inputAspect) {
    sh = maxH;
    sw = Math.round(sh * inputAspect);
  } else {
    sw = maxW;
    sh = Math.round(sw / inputAspect);
  }
  return {
    x: Math.round((canvas.w - sw) / 2),
    y: Math.round((canvas.h - sh) / 2),
    w: sw,
    h: sh,
  };
}

// Real iPhone proportions: screen corner radius ~12% of width, bezel
// thickness ~2-3% of width. The recording itself is alpha-masked to the
// rounded screen shape (via a static mask PNG below), so we don't need
// the bezel to cover rectangular corners — bezel can be as thin as we
// like.
let screen, SCREEN_RADIUS, BEZEL_T;
if (SCREEN_RECT_IN) {
  screen = SCREEN_RECT_IN;
} else {
  screen = fitScreen(BEZEL_T_IN === "auto" ? 8 : Number(BEZEL_T_IN));
}
const phoneW = screen.w;
SCREEN_RADIUS = SCREEN_RADIUS_IN === "auto"
  ? Math.max(20, Math.round(phoneW * 0.10))
  : Number(SCREEN_RADIUS_IN);
BEZEL_T = BEZEL_T_IN === "auto"
  ? Math.max(4, Math.round(phoneW * 0.022))
  : Number(BEZEL_T_IN);
if (!SCREEN_RECT_IN) {
  // Refit with the final bezel so margins are exact.
  screen = fitScreen(BEZEL_T);
}

console.log(`Canvas ${canvas.w}×${canvas.h}  screen=(${screen.x},${screen.y},${screen.w}×${screen.h})  radius=${SCREEN_RADIUS}px  bezel=${BEZEL_T}px`);

// ---------------------------------------------------------------------------
// geq helpers — geq's expression evaluator does NOT recognize and()/or()/not()
// as functions. Encode boolean ops via arithmetic:
//   AND  →  product (each term is 0 or 1)
//   OR   →  sum > 0
//   NOT  →  1 - x

function gAnd(...terms) { return terms.map((t) => `(${t})`).join("*"); }
function gOr(...terms)  { return `gt(${terms.map((t) => `(${t})`).join("+")},0)`; }
function gNot(term)     { return `(1-(${term}))`; }

function insideRoundedRect(rx, ry, rw, rh, r) {
  const r2 = r * r;
  const cx1 = rx + r,        cy1 = ry + r;
  const cx2 = rx + rw - r,   cy2 = ry + r;
  const cx3 = rx + r,        cy3 = ry + rh - r;
  const cx4 = rx + rw - r,   cy4 = ry + rh - r;
  const cornerExpr =
    `lte(min(min(pow(X-${cx1},2)+pow(Y-${cy1},2),pow(X-${cx2},2)+pow(Y-${cy2},2)),` +
    `min(pow(X-${cx3},2)+pow(Y-${cy3},2),pow(X-${cx4},2)+pow(Y-${cy4},2))),${r2})`;
  const horizBand = gAnd(
    `gte(X,${rx + r})`,
    `lte(X,${rx + rw - r})`,
    `gte(Y,${ry})`,
    `lte(Y,${ry + rh})`,
  );
  const vertBand = gAnd(
    `gte(X,${rx})`,
    `lte(X,${rx + rw})`,
    `gte(Y,${ry + r})`,
    `lte(Y,${ry + rh - r})`,
  );
  return `if(${gOr(horizBand, vertBand, cornerExpr)},1,0)`;
}

// ---------------------------------------------------------------------------
// generate (or reuse) the procedural bezel PNG. The bezel is:
//   - opaque (BEZEL_COLOR) in the band between two concentric rounded rects
//   - transparent inside the inner rounded rect (where the recording shows)
//   - transparent outside the outer rounded rect (where the background shows)
//
// The corner regions of the rectangular screen-rect (just outside the inner
// rounded corner, just inside the outer rounded corner) are opaque bezel —
// they cover the recording's rectangular corners. That's why BEZEL_T must
// be at least ~0.42 × R; otherwise the outer rounded corner can't reach
// pixels at (screen.x, screen.y) and the recording's corner leaks.

// Static rounded-corner mask for the scaled recording. Generated once per
// (screen.w, screen.h, SCREEN_RADIUS) combo and cached.
const maskKey = crypto.createHash("md5").update(`mask|${screen.w}|${screen.h}|${SCREEN_RADIUS}`).digest("hex").slice(0, 12);
const maskPath = path.join(os.tmpdir(), `demo-frame-mask-${maskKey}.png`);
if (!fs.existsSync(maskPath)) {
  // White inside the rounded rect, black outside. alphamerge reads
  // brightness as alpha, so this gives the recording a rounded shape.
  const alphaExpr = `${insideRoundedRect(0, 0, screen.w, screen.h, SCREEN_RADIUS)}*255`;
  const r = spawnSync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", `color=c=black:s=${screen.w}x${screen.h}:d=0.04`,
    "-vf", `geq=r='${alphaExpr}':g='${alphaExpr}':b='${alphaExpr}'`,
    "-frames:v", "1", "-update", "1",
    maskPath,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  if (r.status !== 0) {
    console.error("failed to render rounded-corner mask:");
    console.error(r.stderr.toString().split("\n").slice(-15).join("\n"));
    process.exit(5);
  }
  console.log(`Rounded mask → ${maskPath} (${screen.w}×${screen.h}, radius=${SCREEN_RADIUS}px)`);
}

let bezelPath = BEZEL_PNG_IN;
if (!bezelPath) {
  const bezelKey = crypto
    .createHash("md5")
    .update(`bezel|${canvas.w}|${canvas.h}|${screen.x}|${screen.y}|${screen.w}|${screen.h}|${SCREEN_RADIUS}|${BEZEL_T}|${BEZEL_COLOR}|${ISLAND_ON}|${ISLAND_W_FRAC}|${ISLAND_H_FRAC}|${ISLAND_TOP_FRAC}`)
    .digest("hex").slice(0, 12);
  bezelPath = path.join(os.tmpdir(), `demo-frame-bezel-${bezelKey}.png`);

  if (!fs.existsSync(bezelPath)) {
    const inOuter = insideRoundedRect(
      screen.x - BEZEL_T, screen.y - BEZEL_T,
      screen.w + 2 * BEZEL_T, screen.h + 2 * BEZEL_T,
      SCREEN_RADIUS + BEZEL_T,
    );
    const inInner = insideRoundedRect(screen.x, screen.y, screen.w, screen.h, SCREEN_RADIUS);
    // Bezel band = inside outer rounded rect AND outside inner rounded rect.
    const bandExpr = gAnd(inOuter, gNot(inInner));
    // Dynamic Island: a pill at the top of the screen interior, opaque black
    // (same as the bezel band so it looks like part of the chrome).
    let islandExpr = "0";
    if (ISLAND_ON) {
      const islandW   = screen.w * ISLAND_W_FRAC;
      const islandH   = screen.h * ISLAND_H_FRAC;
      const islandTop = screen.y + screen.h * ISLAND_TOP_FRAC;
      const islandLeft = screen.x + (screen.w - islandW) / 2;
      // pill shape → radius = half the island's height
      islandExpr = insideRoundedRect(islandLeft, islandTop, islandW, islandH, islandH / 2);
      console.log(`Dynamic Island: ${Math.round(islandW)}×${Math.round(islandH)} at (${Math.round(islandLeft)}, ${Math.round(islandTop)})`);
    }
    const alphaExpr = `if(${gOr(bandExpr, islandExpr)},255,0)`;
    const r = spawnSync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", `color=c=${BEZEL_COLOR}:s=${canvas.w}x${canvas.h}:d=0.04`,
      "-vf", `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alphaExpr}'`,
      "-frames:v", "1", "-update", "1",
      bezelPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    if (r.status !== 0) {
      console.error("failed to render procedural bezel:");
      console.error(r.stderr.toString().split("\n").slice(-15).join("\n"));
      process.exit(5);
    }
    console.log(`Bezel sprite → ${bezelPath} (${canvas.w}×${canvas.h}, thickness ${BEZEL_T}px)`);
  }
}

// ---------------------------------------------------------------------------
// Two-pass composite:
//   Pass 1: pre-bake (bg + bezel) into a single canvas-sized PNG. Cached
//           per (canvas, bg, bezel) combo. ~1s one-off cost.
//   Pass 2: scale recording → alphamerge with rounded mask → overlay onto
//           the pre-baked template. One filter chain, two inputs to
//           encode, one alphamerge on a small image (379×824).
//
// We split because a single chain with three looped PNG inputs + alphamerge
// triggered pathological slowness on macOS (8+ minutes for a 30s clip,
// erratic). The split runs reliably in seconds.

const SRC_FPS = probeFps(INPUT);
console.log(`Source fps: ${SRC_FPS} (preserved through this stage)`);

// Resolve bg layer: explicit image > procedural gradient > flat color.
function generateGradientPng() {
  const m = BG_GRADIENT.match(/^([0-9a-fA-F]{6}):([0-9a-fA-F]{6})$/);
  if (!m) {
    console.error(`invalid --bg-gradient "${BG_GRADIENT}"; expected TOP_HEX:BOTTOM_HEX (no '#')`);
    process.exit(2);
  }
  const [, topHex, bottomHex] = m;
  const key = crypto.createHash("md5").update(`gradient|${canvas.w}|${canvas.h}|${topHex}|${bottomHex}`).digest("hex").slice(0, 12);
  const out = path.join(os.tmpdir(), `demo-frame-gradient-${key}.png`);
  if (fs.existsSync(out)) return out;
  const tr = parseInt(topHex.slice(0, 2), 16), tg = parseInt(topHex.slice(2, 4), 16), tb = parseInt(topHex.slice(4, 6), 16);
  const br = parseInt(bottomHex.slice(0, 2), 16), bg = parseInt(bottomHex.slice(2, 4), 16), bb = parseInt(bottomHex.slice(4, 6), 16);
  const rExpr = `${tr}+(${br}-${tr})*Y/${canvas.h}`;
  const gExpr = `${tg}+(${bg}-${tg})*Y/${canvas.h}`;
  const bExpr = `${tb}+(${bb}-${tb})*Y/${canvas.h}`;
  const r = spawnSync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", `color=c=black:s=${canvas.w}x${canvas.h}:d=0.04`,
    "-vf", `geq=r='${rExpr}':g='${gExpr}':b='${bExpr}'`,
    "-frames:v", "1", "-update", "1",
    out,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  if (r.status !== 0) {
    console.error("failed to render gradient bg:");
    console.error(r.stderr.toString().split("\n").slice(-15).join("\n"));
    process.exit(5);
  }
  console.log(`Gradient bg → ${out} (${canvas.w}×${canvas.h}, ${topHex}→${bottomHex})`);
  return out;
}
const bgImagePath = BG_IMAGE || (BG_GRADIENT ? generateGradientPng() : null);

// ----- Pre-bake (bg + bezel) into a single canvas-sized template PNG.
// Cached per (canvas, bg, bezel) combo — generated once per geometry.

const templateKey = crypto.createHash("md5").update(
  `tmpl|${canvas.w}|${canvas.h}|${bgImagePath || BG_COLOR}|${bezelPath}|${fs.statSync(bezelPath).mtimeMs}`,
).digest("hex").slice(0, 12);
const templatePath = path.join(os.tmpdir(), `demo-frame-template-${templateKey}.png`);

if (!fs.existsSync(templatePath)) {
  const tArgs = ["-y"];
  let bgPrep;
  if (bgImagePath) {
    tArgs.push("-loop", "1", "-i", bgImagePath);
    bgPrep = `[0:v] scale=${canvas.w}:${canvas.h}:force_original_aspect_ratio=increase,crop=${canvas.w}:${canvas.h} [bg]`;
  } else {
    tArgs.push("-f", "lavfi", "-i", `color=c=${BG_COLOR}:s=${canvas.w}x${canvas.h}:d=0.04`);
    bgPrep = `[0:v] null [bg]`;
  }
  tArgs.push("-i", bezelPath);
  tArgs.push(
    "-filter_complex", `${bgPrep};[bg][1:v] overlay=0:0 [out]`,
    "-map", "[out]",
    "-frames:v", "1", "-update", "1",
    templatePath,
  );
  const tr = spawnSync("ffmpeg", tArgs, { stdio: ["ignore", "ignore", "pipe"] });
  if (tr.status !== 0) {
    console.error("failed to render frame template:");
    console.error(tr.stderr.toString().split("\n").slice(-15).join("\n"));
    process.exit(5);
  }
  console.log(`Frame template → ${templatePath} (${canvas.w}×${canvas.h})`);
}

// ----- Main encode: scale + alpha-mask recording, overlay on template.
//
// Inputs: [0]=recording  [1]=template (bg + bezel pre-baked)  [2]=mask
//
// alphamerge runs on the small scaled recording (379×824), one overlay onto
// the canvas-sized template. Compared to the previous 4-input chain, this
// removes the framesync between multiple looped PNG streams that was
// triggering pathological slowness on macOS.

const args = [
  "-y",
  "-i", INPUT,
  "-loop", "1", "-i", templatePath,
  "-loop", "1", "-i", maskPath,
  "-filter_complex",
    // alphamerge defaults to shortest=0 — without an explicit shortest=1
    // it emits frames forever because the looped mask PNG is an infinite
    // stream. Same for the overlay step with the looped template.
    `[0:v] scale=${screen.w}:${screen.h}:flags=lanczos,setsar=1,format=rgba [recScaled];\n` +
    `[recScaled][2:v] alphamerge=shortest=1 [rec];\n` +
    `[1:v][rec] overlay=${screen.x}:${screen.y}:shortest=1 [out]`,
  "-map", "[out]",
  "-r", String(SRC_FPS), "-vsync", "cfr",
  "-shortest",
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  "-an",
  OUTPUT,
];

const r = spawnSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
if (r.status !== 0) {
  console.error("ffmpeg failed:");
  console.error(r.stderr.toString().split("\n").slice(-30).join("\n"));
  process.exit(r.status ?? 5);
}

// ---------------------------------------------------------------------------
// propagate sidecars + emit frame metadata sidecar

const capIn  = INPUT.replace(/\.[^.]+$/, "")  + ".captions.json";
const capOut = OUTPUT.replace(/\.[^.]+$/, "") + ".captions.json";
if (fs.existsSync(capIn) && capIn !== capOut) fs.copyFileSync(capIn, capOut);

const frameMeta = {
  canvas:        { w: canvas.w, h: canvas.h },
  screen:        screen,
  screenRadius:  SCREEN_RADIUS,
  bezel:         BEZEL_PNG_IN
    ? { kind: "external", path: BEZEL_PNG_IN }
    : { kind: "procedural", thickness: BEZEL_T, color: BEZEL_COLOR },
  background:    BG_IMAGE
    ? { kind: "image", path: BG_IMAGE }
    : BG_GRADIENT
      ? { kind: "gradient", spec: BG_GRADIENT }
      : { kind: "color", color: BG_COLOR },
  inputDimensions: { w: inputW, h: inputH },
};
fs.writeFileSync(OUTPUT + ".frame.json", JSON.stringify(frameMeta, null, 2) + "\n");
console.log(`Frame metadata → ${OUTPUT}.frame.json`);
console.log(`Framed → ${OUTPUT}`);
