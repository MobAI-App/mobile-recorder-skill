#!/usr/bin/env node
/**
 * Burn captions onto a video using pure-JS text rendering + ffmpeg overlay.
 *
 *   node burn_captions.js <input.mp4> <captions.json|-> <output.mp4> [flags]
 *
 * If <captions.json> is omitted or "-", looks for a sidecar at
 * <input>.captions.json (the convention produced by add_highlights.js /
 * add_speedups.js / export_video.js). Each entry's startMs/endMs must
 * already be in the input mp4's timeline.
 *
 * Implementation: each unique caption text is rendered to a PNG via
 * `lib/text-png.js` (pure JS - opentype.js for the TTF/OTF, scanline
 * polygon fill + 2x supersample for AA, hand-rolled PNG encoder). The
 * PNGs are then overlay'd onto the video with one ffmpeg pass and an
 * `enable='between(t, ...)' window per caption. No libass, no
 * libfreetype, no native deps - works on any ffmpeg build that has the
 * `overlay` filter (i.e. every ffmpeg build).
 *
 * Flags:
 *   --font PATH             TTF/OTF font. Default: assets/fonts/Inter-Bold.ttf
 *                           (Inter Bold, SIL OFL 1.1) bundled with the skill.
 *   --font-size N           Pixel size of the rendered text. Default 56.
 *   --x N                   Caption CENTER x in input-mp4 pixels.
 *                           Default: half the video width (horizontal center).
 *   --y N                   Caption CENTER y in input-mp4 pixels.
 *                           Default: 88% of the video height (bottom strip).
 *   --color RRGGBB          Text color. Default FFFFFF.
 *   --bg RRGGBBAA           Background fill (8 hex chars; last 2 = alpha).
 *                           Default 00000099 (~60% black). Use 00000000 for
 *                           transparent (text-only, no chrome).
 *   --padding HxV           Inner padding around the text. Default 40x20.
 *   --radius N              Background corner radius. Default 16.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { renderTextPng } = require("./lib/text-png");

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error("usage: burn_captions.js <input.mp4> <captions.json|-> <output.mp4> [flags]");
  process.exit(2);
}
const [INPUT, CAPTIONS_ARG, OUTPUT] = argv.slice(0, 3);

function readFlag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
}

const DEFAULT_FONT = path.join(__dirname, "..", "assets", "fonts", "Inter-Bold.ttf");
const FONT_PATH = readFlag("--font", DEFAULT_FONT);
const FONT_SIZE = Number(readFlag("--font-size", "56"));
const COLOR_HEX = readFlag("--color", "FFFFFF");
const BG_HEX    = readFlag("--bg", "00000099");
const PAD_RAW   = readFlag("--padding", "40x20");
const RADIUS    = Number(readFlag("--radius", "16"));
const X_OVERRIDE = readFlag("--x", null);
const Y_OVERRIDE = readFlag("--y", null);

if (!fs.existsSync(INPUT))     { console.error(`not found: ${INPUT}`); process.exit(3); }
if (!fs.existsSync(FONT_PATH)) { console.error(`font not found: ${FONT_PATH}`); process.exit(3); }
if (!OUTPUT)                   { console.error("missing <output.mp4>"); process.exit(2); }

const captionsPath = !CAPTIONS_ARG || CAPTIONS_ARG === "-"
  ? INPUT.replace(/\.[^.]+$/, "") + ".captions.json"
  : CAPTIONS_ARG;
if (!fs.existsSync(captionsPath)) {
  console.error(`captions sidecar not found: ${captionsPath}`);
  process.exit(3);
}
const captions = JSON.parse(fs.readFileSync(captionsPath, "utf8"))
  .filter((c) => c.text && c.endMs > c.startMs);
if (captions.length === 0) {
  console.log("No captions to burn; copying input → output.");
  const r = spawnSync("ffmpeg", ["-y", "-i", INPUT, "-c", "copy", OUTPUT], { stdio: "inherit" });
  process.exit(r.status ?? 0);
}

const probe = spawnSync("ffprobe", [
  "-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=width,height",
  "-of", "csv=p=0", INPUT,
]);
if (probe.status !== 0) { console.error("ffprobe failed:", probe.stderr.toString()); process.exit(4); }
const [videoW, videoH] = probe.stdout.toString().trim().split(",").map(Number);

const padMatch = PAD_RAW.match(/^(\d+)x(\d+)$/);
if (!padMatch) { console.error(`invalid --padding "${PAD_RAW}"; expected HxV (e.g. 40x20)`); process.exit(2); }
const padding = [Number(padMatch[1]), Number(padMatch[2])];

function hexToRgba(hex, fallbackAlpha) {
  const s = String(hex).replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s)) {
    console.error(`invalid hex color "${hex}"`); process.exit(2);
  }
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  const a = s.length === 8 ? parseInt(s.slice(6, 8), 16) : fallbackAlpha;
  return [r, g, b, a];
}
const color = hexToRgba(COLOR_HEX, 255);
const bg    = hexToRgba(BG_HEX, 153);

const cx = X_OVERRIDE != null ? Number(X_OVERRIDE) : Math.round(videoW / 2);
const cy = Y_OVERRIDE != null ? Number(Y_OVERRIDE) : Math.round(videoH * 0.88);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-captions-"));
process.on("exit", () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

const fontBuf = fs.readFileSync(FONT_PATH);

// Render one PNG per unique caption text (so two captions with the same text
// share a sprite). Each `entries[i]` carries the PNG path + dims + the
// timing window we'll use in ffmpeg overlay's enable=between(t,...).
const pngByText = new Map();
const entries = captions.map((c, i) => {
  let png = pngByText.get(c.text);
  if (!png) {
    const buf = renderTextPng({
      text:     c.text,
      font:     fontBuf,
      fontSize: FONT_SIZE,
      color,
      bgColor:  bg,
      padding,
      radius:   RADIUS,
    });
    const outPath = path.join(tmpDir, `cap-${pngByText.size}.png`);
    fs.writeFileSync(outPath, buf);
    // Read width/height back from the PNG header (IHDR is at byte 16).
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    png = { path: outPath, w, h };
    pngByText.set(c.text, png);
  }
  return {
    png,
    startSec: c.startMs / 1000,
    endSec:   c.endMs   / 1000,
  };
});

console.log(`Rendered ${pngByText.size} caption sprite(s) in ${tmpDir}`);

// Build the ffmpeg filtergraph: chain N overlays, one per caption, each
// gated by enable='between(t, start, end)'. Same pattern as add_highlights'
// ripple overlays - no libass, just `overlay`.
const inputs = ["-y", "-i", INPUT];
// Map each PNG to its ffmpeg input index. Distinct PNGs reuse via `split`
// if a caption fires more than once.
const pngArr = [...pngByText.values()];
for (const p of pngArr) inputs.push("-loop", "1", "-i", p.path);

const splitNeeds = new Map();
for (const e of entries) {
  splitNeeds.set(e.png, (splitNeeds.get(e.png) || 0) + 1);
}

const chain = [];
const splitOut = new Map(); // png → array of stream labels
pngArr.forEach((p, idx) => {
  const n = splitNeeds.get(p);
  const inIdx = idx + 1; // [0:v] is the video
  if (n === 1) {
    chain.push(`[${inIdx}:v] null [cap_${idx}_0]`);
    splitOut.set(p, [`cap_${idx}_0`]);
  } else {
    const labels = [];
    for (let k = 0; k < n; k++) labels.push(`cap_${idx}_${k}`);
    chain.push(`[${inIdx}:v] split=${n} ${labels.map((l) => `[${l}]`).join("")}`);
    splitOut.set(p, labels);
  }
});

const consumed = new Map(); // png → how many of its split outputs we've used so far
let lastLabel = "[0:v]";
entries.forEach((e, i) => {
  const used = consumed.get(e.png) || 0;
  consumed.set(e.png, used + 1);
  const overlay = splitOut.get(e.png)[used];
  const nextLabel = `[v${i}]`;
  // Position: caption center (cx, cy) → overlay top-left = cx - W/2, cy - H/2.
  const x = cx - Math.floor(e.png.w / 2);
  const y = cy - Math.floor(e.png.h / 2);
  chain.push(
    `${lastLabel}[${overlay}] overlay=` +
    `x=${x}:y=${y}:shortest=1:` +
    `enable='between(t,${e.startSec.toFixed(3)},${e.endSec.toFixed(3)})' ${nextLabel}`
  );
  lastLabel = nextLabel;
});
chain.push(`${lastLabel} null [vout]`);

const filtergraph = chain.join(";\n");
const args = inputs.concat([
  "-filter_complex", filtergraph,
  "-map", "[vout]",
  // Preserve audio if there's any (no-op for our pipeline; harmless).
  "-map", "0:a?", "-c:a", "copy",
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  OUTPUT,
]);

const r = spawnSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
if (r.status !== 0) {
  console.error("ffmpeg failed:");
  console.error(r.stderr.toString().split("\n").slice(-30).join("\n"));
  process.exit(r.status ?? 5);
}
console.log(`Captions burned → ${OUTPUT}`);
