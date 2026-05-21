#!/usr/bin/env node
/**
 * Animated zoom for mobile recordings — directives from editor.json.
 *
 *   node add_zoom.js <input.mp4> <timeline.json> <editor.json> <output.mp4> [flags]
 *
 * Opt-in: only lines with a zoom directive zoom. The segment covers the
 * directive's resolved span (see lib/editor.js → resolveSpan). Within the
 * span the camera holds steady at the resolved center; scale ramps from 1 →
 * peak over `rampMs` at the edges and holds at peak in between.
 *
 *   { "kind": "zoom", "line": 14, "side": "during", "scale": 2.0 }
 *   { "kind": "zoom", "line": 18, "side": "before", "scale": 2.5,
 *     "center": { "x": 500, "y": 1200 }, "rampMs": 300 }
 *
 * Center default: the tap's (x, y), or swipe midpoint, or screen center.
 *
 * Zero-width spans (e.g. `side: during` on a `tap`) hard-error so the agent
 * is forced to make the intent explicit. Pick one of:
 *   - anchor on a `wait` / `swipe` line that has duration
 *   - use `side: before` / `side: after` on an action that has a real gap
 *     around it
 *   - set `windowMs` to specify an explicit zoom window centered on the
 *     resolved span's midpoint
 *
 * Pipeline order: highlights → frame → zoom → speedups → export. After
 * `add_frame`, the input is a phone-bezel + background composite — zoom now
 * means "the camera moves closer to the framed phone," scaling the whole
 * composite (background, bezel, recording), not cropping into the screen.
 *
 * If a `<input>.frame.json` sidecar is present (written by add_frame), the
 * default zoom center is the phone-screen center in composite-pixel coords.
 * Without the sidecar, the script falls back to recording-pixel defaults
 * (tap coord / swipe midpoint / video center) — useful if the pipeline runs
 * without the framing stage.
 *
 * Center coords for `center: { x, y }` are interpreted in the COMPOSITE
 * pixel space when frame.json is present, and in recording-pixel space when
 * it isn't.
 *
 * Flags:
 *   --ramp-ms N   global default ramp duration. Default 200.
 *                 Overridden per-directive via `rampMs`.
 *   --debug       print the ffmpeg filtergraph on stderr.
 */

const fs = require("fs");
const { spawnSync } = require("child_process");
const { loadEditorContext, propagateSidecars, probeFps } = require("./lib/editor");

const argv = process.argv.slice(2);
if (argv.length < 4) {
  console.error("usage: add_zoom.js <input.mp4> <timeline.json> <editor.json> <output.mp4> [flags]");
  process.exit(2);
}
const [INPUT, TIMELINE, EDITOR, OUTPUT] = argv.slice(0, 4);

function readFlag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
}
const DEFAULT_RAMP_MS = Number(readFlag("--ramp-ms", "200"));
const DEBUG = argv.includes("--debug");

if (!fs.existsSync(INPUT)) { console.error(`not found: ${INPUT}`); process.exit(3); }

const ctx = loadEditorContext({ editorPath: EDITOR, timelinePath: TIMELINE });

// If a <input>.frame.json sidecar exists, the input is a framed composite —
// switch default center to the phone-screen midpoint in composite coords.
const frameMetaPath = INPUT + ".frame.json";
const frameMeta = fs.existsSync(frameMetaPath)
  ? JSON.parse(fs.readFileSync(frameMetaPath, "utf8"))
  : null;
if (frameMeta) {
  console.log(`Frame metadata → ${frameMetaPath}  (canvas ${frameMeta.canvas.w}×${frameMeta.canvas.h}, screen at ${frameMeta.screen.x},${frameMeta.screen.y})`);
}

// Preserve the source's frame rate end-to-end. zoompan's `fps=` controls
// its output PTS rate, so it must match what the file actually has — any
// mismatch silently retimes the stream (the bug we hit when this was
// hard-coded to 30 while the source was 60).
const probe = spawnSync("ffprobe", [
  "-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=width,height",
  "-of", "default=noprint_wrappers=1", INPUT,
]);
if (probe.status !== 0) { console.error("ffprobe failed:", probe.stderr.toString()); process.exit(4); }
const probeFields = Object.fromEntries(
  probe.stdout.toString().trim().split("\n").map((line) => {
    const eq = line.indexOf("=");
    return eq < 0 ? [line, ""] : [line.slice(0, eq), line.slice(eq + 1)];
  }),
);
const srcW = Number(probeFields.width);
const srcH = Number(probeFields.height);
const srcFps = probeFps(INPUT);
console.log(`Source fps: ${srcFps} (preserved through this stage)`);

// Each segment is stored with explicit ramp boundaries:
//   t0 = ramp-in start (zoom = 1x here)
//   t1 = peak start    (zoom reaches `scale`)
//   t2 = peak end      (zoom still at `scale`)
//   t3 = ramp-out end  (zoom = 1x here)
//
// Two directive shapes feed this:
//   { line, side, windowMs?, ... }       legacy single-action zoom
//   { fromLine, toLine, ... }            multi-action zoom (peak held)

const segments = [];
for (const d of ctx.editor.directives) {
  if (d.kind !== "zoom") continue;
  const scale = Number(d.scale);
  if (!(scale > 1)) {
    console.error(`zoom directive: scale must be > 1 (got ${d.scale})`);
    process.exit(2);
  }
  const rampMs = Math.max(0, Number.isFinite(d.rampMs) ? d.rampMs : DEFAULT_RAMP_MS);

  // ----- resolve t0..t3 in choreography ms -----
  let t0Ms, t1Ms, t2Ms, t3Ms, anchorEvent, anchorLabel;
  if (d.fromLine != null && d.toLine != null) {
    const range = ctx.resolveLineRange({ fromLine: d.fromLine, toLine: d.toLine });
    // peak held from fromLine.start..toLine.start; ramps lie OUTSIDE the
    // peak window so the zoom is already at peak the moment fromLine fires.
    t1Ms = range.tStart;
    t2Ms = range.tEnd - rampMs;     // ramp-out begins inside the toLine boundary
    t0Ms = range.tStart - rampMs;   // ramp-in starts before fromLine
    t3Ms = range.tEnd;              // ramp-out completes at toLine
    if (t2Ms < t1Ms) t2Ms = t1Ms;   // degenerate: very short range; fall back to no hold
    anchorEvent = range.fromEvent;
    anchorLabel = `fromLine ${d.fromLine} → toLine ${d.toLine}`;
  } else {
    if (d.line == null || d.side == null) {
      console.error(`zoom directive missing either {line,side} or {fromLine,toLine}: ${JSON.stringify(d)}`);
      process.exit(2);
    }
    const span = ctx.resolveSpan({ line: d.line, side: d.side });
    const rawDur = span.tEnd - span.tStart;
    let tStartMs, tEndMs;
    if (Number.isFinite(d.windowMs) && d.windowMs > 0) {
      const center = (span.tStart + span.tEnd) / 2;
      tStartMs = center - d.windowMs / 2;
      tEndMs   = center + d.windowMs / 2;
    } else if (rawDur > 0) {
      tStartMs = span.tStart;
      tEndMs   = span.tEnd;
    } else {
      console.error(
        `zoom directive on line ${d.line} (${d.side}) resolves to zero duration. ` +
        `Anchor on a wait/swipe line, use a different side, set windowMs, or switch to {fromLine,toLine}.`,
      );
      process.exit(2);
    }
    if (tStartMs < 0) tStartMs = 0;
    // legacy semantics: ramps live INSIDE the segment
    const ramp = Math.min(rampMs, (tEndMs - tStartMs) / 4);
    t0Ms = tStartMs;
    t1Ms = tStartMs + ramp;
    t2Ms = tEndMs - ramp;
    t3Ms = tEndMs;
    anchorEvent = span.event;
    anchorLabel = `line ${d.line} ${d.side}`;
  }

  // ----- resolve center -----
  let center;
  if (d.center && Number.isFinite(d.center.x) && Number.isFinite(d.center.y)) {
    center = { x: d.center.x, y: d.center.y };
  } else if (frameMeta) {
    center = {
      x: frameMeta.screen.x + frameMeta.screen.w / 2,
      y: frameMeta.screen.y + frameMeta.screen.h / 2,
    };
  } else {
    center = ctx.defaultZoomCenter(anchorEvent, srcW, srcH);
  }

  const off = ctx.recordStartOffsetMs;
  segments.push({
    label: anchorLabel,
    t0: (t0Ms + off) / 1000,
    t1: (t1Ms + off) / 1000,
    t2: (t2Ms + off) / 1000,
    t3: (t3Ms + off) / 1000,
    tStart: (t0Ms + off) / 1000,   // for overlap check
    tEnd:   (t3Ms + off) / 1000,
    cx: center.x,
    cy: center.y,
    scale,
  });
}

if (segments.length === 0) {
  console.log("No zoom directives; copying through.");
  const r = spawnSync("ffmpeg", ["-y", "-i", INPUT, "-c", "copy", OUTPUT], { stdio: "inherit" });
  propagateSidecars(INPUT, OUTPUT);
  process.exit(r.status ?? 0);
}

segments.sort((a, b) => a.tStart - b.tStart);
for (let i = 1; i < segments.length; i++) {
  if (segments[i].tStart < segments[i - 1].tEnd) {
    console.error(`overlapping zoom segments: "${segments[i - 1].label}" and "${segments[i].label}"`);
    process.exit(2);
  }
}

console.log(`Zoom segments: ${segments.length}`);
for (const s of segments) {
  console.log(`  [${s.t0.toFixed(2)}→${s.t1.toFixed(2)}..${s.t2.toFixed(2)}→${s.t3.toFixed(2)}]s  scale=${s.scale}  at=(${s.cx.toFixed(0)},${s.cy.toFixed(0)})  ${s.label}`);
}

function fmt(n) { return Number(n).toFixed(3); }

function amountSubExpr(seg) {
  // Cascade of `lt` checks so each time region is mutually exclusive — no
  // double-counting at boundaries.
  const t0 = fmt(seg.t0), t1 = fmt(seg.t1), t2 = fmt(seg.t2), t3 = fmt(seg.t3);
  const rampIn  = seg.t1 - seg.t0;
  const rampOut = seg.t3 - seg.t2;
  const inExpr  = rampIn  > 1e-3 ? `(t-${t0})/${fmt(rampIn)}`  : "1";
  const outExpr = rampOut > 1e-3 ? `1-(t-${t2})/${fmt(rampOut)}` : "1";
  return (
    `if(lt(t,${t0}),0,` +
    `if(lt(t,${t1}),${inExpr},` +
    `if(lt(t,${t2}),1,` +
    `if(lt(t,${t3}),${outExpr},0))))`
  );
}

function maxNested(parts) {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `max(${parts[0]},${parts[1]})`;
  return `max(${parts[0]},${maxNested(parts.slice(1))})`;
}

const scaleExpr = `1+${maxNested(segments.map((s) => `${fmt(s.scale - 1)}*(${amountSubExpr(s)})`))}`;

function staticCenterExpr(coord) {
  let expr = coord === "x" ? "iw/2" : "ih/2";
  for (const s of segments) {
    const c = coord === "x" ? s.cx : s.cy;
    expr = `if(between(t,${fmt(s.tStart)},${fmt(s.tEnd)}), ${fmt(c)}, ${expr})`;
  }
  return expr;
}

const subT = (s) => s.replace(/\bt\b/g, "out_time");
const zExpr  = subT(scaleExpr);
const cxZP   = subT(staticCenterExpr("x"));
const cyZP   = subT(staticCenterExpr("y"));
const xZP = `max(0, min(iw - iw/zoom, (${cxZP}) - iw/zoom/2))`;
const yZP = `max(0, min(ih - ih/zoom, (${cyZP}) - ih/zoom/2))`;

const vf = `zoompan=z='${zExpr}':x='${xZP}':y='${yZP}':d=1:s=${srcW}x${srcH}:fps=${srcFps}`;

if (DEBUG) {
  console.error("=== filtergraph ===");
  console.error(vf);
}

const r = spawnSync("ffmpeg", [
  "-y",
  "-i", INPUT,
  "-vf", vf,
  "-r", String(srcFps), "-vsync", "cfr",
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
propagateSidecars(INPUT, OUTPUT);
console.log(`Zoom → ${OUTPUT}`);
