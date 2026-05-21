#!/usr/bin/env node
/**
 * Trim, fit to format, and export the final demo video.
 *
 *   node export_video.js <input.mp4> <timeline.json> <editor.json> <output.mp4> <format>
 *
 * format ∈ { vertical_9_16, horizontal_16_9, square_1_1 }
 *
 * Trim window:
 *   editor.json trim.fromLine / trim.toLine   (.mob line numbers)
 *   defaults: first action → last action end + 600 ms
 *
 * Both are choreography-ms; the script adds recordStartOffsetMs to get the
 * raw-recording time the input mp4 lives in. If <input>.timewarp.json exists
 * (emitted by add_speedups.js), the raw-recording trim points are mapped
 * through the warp first so we cut the correct frames in the sped-up output.
 *
 * Also writes <output>.captions.json with timings relative to the trimmed
 * file — both head trim and (if present) time-warp folded in.
 */

const fs = require("fs");
const { spawnSync } = require("child_process");
const { loadEditorContext, srcSecondsToDst, probeFps } = require("./lib/editor");

const argv = process.argv.slice(2);
if (argv.length < 5) {
  console.error("usage: export_video.js <input.mp4> <timeline.json> <editor.json> <output.mp4> <format>");
  process.exit(2);
}
const [INPUT, TIMELINE, EDITOR, OUTPUT, FORMAT] = argv.slice(0, 5);

const FORMATS = {
  vertical_9_16:   { w: 1080, h: 1920 },
  horizontal_16_9: { w: 1920, h: 1080 },
  square_1_1:      { w: 1080, h: 1080 },
};
if (!FORMATS[FORMAT]) {
  console.error(`unknown format "${FORMAT}". Valid: ${Object.keys(FORMATS).join(", ")}`);
  process.exit(2);
}
const { w: TW, h: TH } = FORMATS[FORMAT];

if (!fs.existsSync(INPUT)) { console.error(`not found: ${INPUT}`); process.exit(3); }

const ctx = loadEditorContext({ editorPath: EDITOR, timelinePath: TIMELINE });
const trim = ctx.trimSpan(); // choreography ms

const srcStart = (trim.tStart + ctx.recordStartOffsetMs) / 1000;
const srcEnd   = (trim.tEnd   + ctx.recordStartOffsetMs) / 1000;

const warpPath = INPUT + ".timewarp.json";
let dstStart = srcStart, dstEnd = srcEnd, warp = null;
if (fs.existsSync(warpPath)) {
  warp = JSON.parse(fs.readFileSync(warpPath, "utf8"));
  dstStart = srcSecondsToDst(srcStart, warp);
  dstEnd   = srcSecondsToDst(srcEnd,   warp);
  console.log(`Trim (src ${srcStart.toFixed(2)}s..${srcEnd.toFixed(2)}s) → (dst ${dstStart.toFixed(2)}s..${dstEnd.toFixed(2)}s) via ${warpPath}`);
} else {
  console.log(`Trim (${srcStart.toFixed(2)}s..${srcEnd.toFixed(2)}s)  format=${FORMAT}  ${TW}x${TH}`);
}

const vf =
  `scale=w='if(gt(a,${TW}/${TH}),${TW},-2)':h='if(gt(a,${TW}/${TH}),-2,${TH})',` +
  `pad=${TW}:${TH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;

const SRC_FPS = probeFps(INPUT);
console.log(`Source fps: ${SRC_FPS} (preserved through this stage)`);

const r = spawnSync("ffmpeg", [
  "-y",
  "-ss", dstStart.toFixed(3),
  "-to", dstEnd.toFixed(3),
  "-i", INPUT,
  "-vf", vf,
  "-r", String(SRC_FPS), "-vsync", "cfr",
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  "-an",
  OUTPUT,
], { stdio: ["ignore", "ignore", "pipe"] });

if (r.status !== 0) {
  console.error("ffmpeg failed:");
  console.error(r.stderr.toString().split("\n").slice(-30).join("\n"));
  process.exit(r.status ?? 5);
}

writeCaptionsSidecar({ srcStart, dstStart, warp });

console.log(`Exported → ${OUTPUT}  (${TW}x${TH})`);

function writeCaptionsSidecar({ srcStart, dstStart, warp }) {
  // Prefer the propagated captions sidecar (already remapped through any
  // speedup warp on its mp4). Subtract the post-warp trim head so timings are
  // relative to the trimmed output.
  const inCap = INPUT.replace(/\.[^.]+$/, "") + ".captions.json";
  const outCap = OUTPUT.replace(/\.[^.]+$/, "") + ".captions.json";

  if (fs.existsSync(inCap)) {
    const captions = JSON.parse(fs.readFileSync(inCap, "utf8"));
    const shift = Math.round(dstStart * 1000);
    const remapped = captions
      .map((c) => ({ startMs: c.startMs - shift, endMs: c.endMs - shift, text: c.text }))
      .filter((c) => c.endMs > 0);
    fs.writeFileSync(outCap, JSON.stringify(remapped, null, 2) + "\n");
    console.log(`Captions → ${outCap}`);
    return;
  }

  // Fallback: build directly from timeline. Captions live in choreography
  // ms, but the exported video is in trimmed post-warp seconds. The same
  // chain the propagated sidecar already went through must be replayed
  // here: choreography ms → raw-recording seconds (add recordStartOffsetMs)
  // → warp to post-speed seconds (if a warp is loaded) → subtract dstStart.
  // Without the warp step, captions in this branch drift relative to the
  // trim points (which DO go through the warp at line 56).
  const captioned = ctx.actions.filter((e) => e.caption);
  const stopMs = ctx.recordingDurationMs;
  function choreoMsToOutputMs(ms) {
    const srcSec = (ms + ctx.recordStartOffsetMs) / 1000;
    const dstSec = warp ? srcSecondsToDst(srcSec, warp) : srcSec;
    return Math.round((dstSec - dstStart) * 1000);
  }
  const captions = captioned.map((e, idx) => ({
    startMs: choreoMsToOutputMs(e.timeMs),
    endMs:   choreoMsToOutputMs(captioned[idx + 1]?.timeMs ?? stopMs),
    text:    e.caption,
  })).filter((c) => c.endMs > 0);
  fs.writeFileSync(outCap, JSON.stringify(captions, null, 2) + "\n");
  console.log(`Captions → ${outCap}`);
}
