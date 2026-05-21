#!/usr/bin/env node
/**
 * Variable-speed playback for mobile recordings.
 *
 *   node add_speedups.js <input.mp4> <timeline.json> <editor.json> <output.mp4> [flags]
 *
 * All speed segments come from editor.json `{kind:"speed", line, side, factor}`
 * directives:
 *   - "before"  → span from previous action's end to this action's start
 *   - "during"  → this action's own span (natural target for `wait` lines)
 *   - "after"   → span from this action's end to next action's start
 *
 * Pipeline order: highlights → zoom → speedups → export. Speedups run after
 * the geometry passes so any burned-in pixels (ripples, finger overlay, zoom)
 * get re-timed for free. The output ships with two sidecars:
 *
 *   <output>.timewarp.json    src↔dst segments; consumed by export_video.js
 *   <output>.captions.json    captions remapped through the warp
 *
 * Flags:
 *   --debug   print the ffmpeg filtergraph on stderr.
 */

const fs = require("fs");
const { spawnSync } = require("child_process");
const { loadEditorContext, propagateSidecars, srcSecondsToDst, probeFps } = require("./lib/editor");

const argv = process.argv.slice(2);
if (argv.length < 4) {
  console.error("usage: add_speedups.js <input.mp4> <timeline.json> <editor.json> <output.mp4> [flags]");
  process.exit(2);
}
const [INPUT, TIMELINE, EDITOR, OUTPUT] = argv.slice(0, 4);

const DEBUG = argv.includes("--debug");

if (!fs.existsSync(INPUT)) { console.error(`not found: ${INPUT}`); process.exit(3); }

const ctx = loadEditorContext({ editorPath: EDITOR, timelinePath: TIMELINE });

const probe = spawnSync("ffprobe", [
  "-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=duration",
  "-of", "csv=p=0", INPUT,
]);
if (probe.status !== 0) { console.error("ffprobe failed:", probe.stderr.toString()); process.exit(4); }
const srcDuration = Number(probe.stdout.toString().trim());
if (!(srcDuration > 0)) {
  console.error(`could not determine source duration for ${INPUT}`);
  process.exit(4);
}

// Span timestamps in the editor lib are choreography-ms (relative to the
// record_start checkpoint). The input mp4 is in raw-recording time, so add
// recordStartOffsetMs and convert to seconds.
function spanToSrcSeconds(span) {
  return {
    srcStart: (span.tStart + ctx.recordStartOffsetMs) / 1000,
    srcEnd:   (span.tEnd   + ctx.recordStartOffsetMs) / 1000,
  };
}

const specs = [];
for (const d of ctx.editor.directives) {
  if (d.kind !== "speed") continue;
  if (!(d.factor > 0) || d.factor === 1) {
    console.error(`speed directive (line ${d.line}, side ${d.side}): factor must be > 0 and != 1 (got ${d.factor})`);
    process.exit(2);
  }
  const span = ctx.resolveSpan({ line: d.line, side: d.side });
  const { srcStart, srcEnd } = spanToSrcSeconds(span);
  if (srcEnd <= srcStart) {
    console.warn(`speed directive on line ${d.line} (${d.side}) has zero duration; skipping`);
    continue;
  }
  specs.push({ srcStart, srcEnd, factor: d.factor, label: `line ${d.line} ${d.side}` });
}

specs.sort((a, b) => a.srcStart - b.srcStart);

for (let i = 1; i < specs.length; i++) {
  if (specs[i].srcStart < specs[i - 1].srcEnd) {
    console.error(`overlapping speed segments: "${specs[i - 1].label}" and "${specs[i].label}"`);
    process.exit(2);
  }
}

if (specs.length === 0) {
  console.log("No speed segments; copying through and emitting identity timewarp.");
  const identity = {
    segments: [{ srcStart: 0, srcEnd: srcDuration, dstStart: 0, dstEnd: srcDuration, factor: 1 }],
  };
  fs.writeFileSync(OUTPUT + ".timewarp.json", JSON.stringify(identity, null, 2) + "\n");
  remapCaptionsIfPresent(identity);
  const r = spawnSync("ffmpeg", ["-y", "-i", INPUT, "-c", "copy", OUTPUT], { stdio: "inherit" });
  propagateSidecars(INPUT, OUTPUT, { skipCaptions: true, skipWarp: true });
  process.exit(r.status ?? 0);
}

// Fill the gaps with identity segments so the warp covers [0, srcDuration].
const segments = [];
let cursor = 0;
for (const s of specs) {
  if (s.srcStart >= srcDuration) {
    console.warn(`speed segment "${s.label}" starts past the recording end; skipping`);
    continue;
  }
  if (s.srcStart > cursor) segments.push({ srcStart: cursor, srcEnd: s.srcStart, factor: 1 });
  const segEnd = Math.min(s.srcEnd, srcDuration);
  if (segEnd <= s.srcStart) continue;
  segments.push({ srcStart: s.srcStart, srcEnd: segEnd, factor: s.factor });
  cursor = segEnd;
}
if (cursor < srcDuration) segments.push({ srcStart: cursor, srcEnd: srcDuration, factor: 1 });

let dstCursor = 0;
for (const seg of segments) {
  const dur = (seg.srcEnd - seg.srcStart) / seg.factor;
  seg.dstStart = dstCursor;
  seg.dstEnd   = dstCursor + dur;
  dstCursor += dur;
}

console.log(`Speed segments: ${segments.length}  (src ${srcDuration.toFixed(2)}s → dst ${dstCursor.toFixed(2)}s)`);
for (const s of segments) {
  const tag = s.factor === 1 ? "" : `  (${s.factor.toFixed(2)}x)`;
  console.log(`  [${s.srcStart.toFixed(2)}..${s.srcEnd.toFixed(2)}]s src → [${s.dstStart.toFixed(2)}..${s.dstEnd.toFixed(2)}]s dst${tag}`);
}

const timewarp = {
  segments: segments.map((s) => ({
    srcStart: round(s.srcStart),
    srcEnd:   round(s.srcEnd),
    dstStart: round(s.dstStart),
    dstEnd:   round(s.dstEnd),
    factor:   s.factor,
  })),
};
const warpPath = OUTPUT + ".timewarp.json";
fs.writeFileSync(warpPath, JSON.stringify(timewarp, null, 2) + "\n");
console.log(`Timewarp → ${warpPath}`);

remapCaptionsIfPresent(timewarp);

const chain = [];
segments.forEach((s, i) => {
  chain.push(
    `[0:v]trim=start=${s.srcStart.toFixed(6)}:end=${s.srcEnd.toFixed(6)},` +
    `setpts=(PTS-STARTPTS)/${s.factor}[s${i}]`,
  );
});
chain.push(`${segments.map((_, i) => `[s${i}]`).join("")}concat=n=${segments.length}:v=1:a=0[vout]`);

const filtergraph = chain.join(";\n");
if (DEBUG) {
  console.error("=== filtergraph ===");
  console.error(filtergraph);
}

const SRC_FPS = probeFps(INPUT);
console.log(`Source fps: ${SRC_FPS} (preserved through this stage)`);

const r = spawnSync("ffmpeg", [
  "-y",
  "-i", INPUT,
  "-filter_complex", filtergraph,
  "-map", "[vout]",
  "-r", String(SRC_FPS), "-vsync", "cfr",
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  "-an",
  OUTPUT,
], { stdio: ["ignore", "ignore", "pipe"] });

if (r.status !== 0) {
  console.error("ffmpeg failed:");
  console.error(r.stderr.toString().split("\n").slice(-30).join("\n"));
  process.exit(r.status ?? 6);
}
propagateSidecars(INPUT, OUTPUT, { skipCaptions: true, skipWarp: true });
console.log(`Speedups → ${OUTPUT}`);

function round(n) { return Math.round(n * 1000) / 1000; }

function remapCaptionsIfPresent(warp) {
  const inCap = INPUT.replace(/\.[^.]+$/, "") + ".captions.json";
  if (!fs.existsSync(inCap)) return;
  const captions = JSON.parse(fs.readFileSync(inCap, "utf8"));
  const remapped = captions.map((c) => ({
    startMs: Math.round(srcSecondsToDst(c.startMs / 1000, warp) * 1000),
    endMs:   Math.round(srcSecondsToDst(c.endMs   / 1000, warp) * 1000),
    text:    c.text,
  }));
  const outCap = OUTPUT.replace(/\.[^.]+$/, "") + ".captions.json";
  fs.writeFileSync(outCap, JSON.stringify(remapped, null, 2) + "\n");
  console.log(`Captions remapped → ${outCap}`);
}
