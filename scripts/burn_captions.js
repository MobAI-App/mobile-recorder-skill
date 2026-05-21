#!/usr/bin/env node
/**
 * Burn captions onto a video using ffmpeg's `subtitles` filter (libass).
 *
 *   node burn_captions.js <input.mp4> <captions.json> <output.mp4> [flags]
 *
 * If <captions.json> is omitted or "-", looks for a sidecar at
 * <input>.captions.json (the convention produced by add_highlights.js /
 * add_speedups.js / export_video.js).
 *
 * The sidecar's startMs/endMs must already be in the input mp4's timeline.
 * In practice that means: burn after `export_video.js`, against the trimmed
 * mp4 + its trimmed-video-time captions sidecar.
 *
 * Flags:
 *   --font-size N           Default 56. Tuned for 1080×1920 vertical.
 *   --margin-v FRACTION     Bottom margin as a fraction of video height.
 *                           Default 0.08 (caption baseline sits ~8% above
 *                           the bottom edge).
 *   --font-name NAME        libass-resolvable font name. Default
 *                           "Helvetica-Bold".
 *   --primary RRGGBB        Caption text color (hex). Default FFFFFF.
 *   --outline N             Outline thickness in pixels. Default 3.
 *
 * Notes on portability:
 *   - libass is bundled with most ffmpeg builds on macOS / Linux. If your
 *     ffmpeg lacks it, `ffmpeg -filters | grep subtitles` returns nothing
 *     and this script will fail; install ffmpeg with `--enable-libass`
 *     (Homebrew's default does).
 *   - The font name is resolved via fontconfig. If the named font is
 *     missing, libass falls back to its default and logs a warning.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

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
const FONT_SIZE = Number(readFlag("--font-size", "56"));
const MARGIN_V  = Number(readFlag("--margin-v", "0.08"));
const FONT_NAME = readFlag("--font-name", "Helvetica-Bold");
const PRIMARY   = readFlag("--primary", "FFFFFF");
const OUTLINE   = Number(readFlag("--outline", "3"));

if (!fs.existsSync(INPUT)) { console.error(`not found: ${INPUT}`); process.exit(3); }
if (!OUTPUT) { console.error("missing <output.mp4>"); process.exit(2); }

const captionsPath = !CAPTIONS_ARG || CAPTIONS_ARG === "-"
  ? INPUT.replace(/\.[^.]+$/, "") + ".captions.json"
  : CAPTIONS_ARG;
if (!fs.existsSync(captionsPath)) {
  console.error(`captions sidecar not found: ${captionsPath}`);
  process.exit(3);
}
const captions = JSON.parse(fs.readFileSync(captionsPath, "utf8"));
if (!Array.isArray(captions) || captions.length === 0) {
  console.log("No captions to burn; copying input → output.");
  const r = spawnSync("ffmpeg", ["-y", "-i", INPUT, "-c", "copy", OUTPUT], { stdio: "inherit" });
  process.exit(r.status ?? 0);
}

// Probe height so we can compute the bottom margin in absolute pixels.
const probe = spawnSync("ffprobe", [
  "-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=height",
  "-of", "csv=p=0", INPUT,
]);
if (probe.status !== 0) { console.error("ffprobe failed:", probe.stderr.toString()); process.exit(4); }
const videoH = Number(probe.stdout.toString().trim());
const marginPx = Math.max(0, Math.round(videoH * MARGIN_V));

function msToTs(ms) {
  const sign = ms < 0 ? "-" : "";
  // ASS subtitle time is 1/100 s — quantize to centiseconds up-front so any
  // rounding carries correctly across the second/minute/hour boundary
  // instead of being applied independently per field.
  ms = Math.max(0, Math.round(Math.round(ms) / 10) * 10);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  return `${sign}${String(h).padStart(1, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function assEscape(s) {
  // Backslash-escape ASS metachars in caption text.
  return String(s).replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\n/g, "\\N");
}

function assColor(rrggbb) {
  // ASS PrimaryColour is &HAABBGGRR — alpha first, then BGR.
  const r = rrggbb.slice(0, 2);
  const g = rrggbb.slice(2, 4);
  const b = rrggbb.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

const assPath = path.join(os.tmpdir(), `demo-captions-${Date.now()}.ass`);
const header =
  `[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: ${videoH}\nScaledBorderAndShadow: yes\n\n` +
  `[V4+ Styles]\n` +
  `Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n` +
  `Style: Default,${FONT_NAME},${FONT_SIZE},${assColor(PRIMARY)},&H00000000,&H64000000,1,1,${OUTLINE},0,2,40,40,${marginPx},1\n\n` +
  `[Events]\n` +
  `Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

const events = captions
  .filter((c) => c.text && c.endMs > c.startMs)
  .map((c) => `Dialogue: 0,${msToTs(c.startMs)},${msToTs(c.endMs)},Default,,0,0,0,,${assEscape(c.text)}`)
  .join("\n");

fs.writeFileSync(assPath, header + events + "\n");
console.log(`ASS subtitles → ${assPath}`);

// libass needs a path that doesn't contain "[", "]", or ":" — escape for the
// filtergraph by single-quoting and backslash-escaping internal colons.
const escapedAssPath = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");

const r = spawnSync("ffmpeg", [
  "-y",
  "-i", INPUT,
  "-vf", `subtitles='${escapedAssPath}'`,
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  "-c:a", "copy",
  OUTPUT,
], { stdio: ["ignore", "ignore", "pipe"] });

if (r.status !== 0) {
  console.error("ffmpeg failed:");
  console.error(r.stderr.toString().split("\n").slice(-30).join("\n"));
  process.exit(r.status ?? 5);
}
console.log(`Captions burned → ${OUTPUT}`);
