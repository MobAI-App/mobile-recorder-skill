#!/usr/bin/env node
/**
 * Animated zoom for mobile recordings - directives from editor.json.
 *
 *   node add_zoom.js <input.mp4> <timeline.json> <editor.json> <output.mp4> [flags]
 *
 * Two directive shapes:
 *
 *   { "kind": "zoom", "line": 14, "side": "during", "scale": 2.0 }
 *   { "kind": "zoom", "fromLine": 26, "toLine": 50, "scale": 1.6,
 *     "startDelayMs": -100, "endDelayMs": 200,
 *     "x": 1440, "y": 800,
 *     "pan": [
 *       { "afterMs": 1500, "x": 1440, "y": 600, "ease": "in_out" },
 *       { "afterMs": 4200, "x": 1440, "y": 1100 }
 *     ]
 *   }
 *
 * All directives accept signed `startDelayMs` / `endDelayMs` (ms offsets on
 * the resolved span - positive shifts later, negative shifts earlier). Use
 * them to fine-tune zoom timing without re-recording.
 *
 * Multi-action ranges (`fromLine/toLine`) hold at peak for the full range
 * and ramp in/out OUTSIDE the peak window, so a single zoom can cover many
 * actions without dipping between them. To fly the camera within a zoom
 * range, add `pan: [{afterMs, x, y, ease?}]` waypoints (afterMs is
 * absolute, not cumulative; relative to the post-delay span start).
 *
 * Default center: horizontal canvas center (the phone is centered by
 * add_frame.js), and the vertical position is clamped so the top of the
 * crop window NEVER lands above the phone's screen - the status bar stays
 * visible. Override with explicit `x` / `y` in canvas-pixel coords.
 *
 * Pipeline order: highlights → frame → zoom → speedups → export. After
 * `add_frame`, the input is a phone-bezel + background composite - zoom
 * means "the camera moves closer to the framed phone," scaling the whole
 * composite.
 *
 * If a `<input>.frame.json` sidecar is present (written by add_frame), the
 * default center uses the composite canvas. Without the sidecar, the script
 * falls back to recording-pixel defaults.
 *
 * Flags:
 *   --ramp-ms N   global default ramp duration. Default 200.
 *                 Overridden per-directive via `rampMs`.
 *   --debug       print the ffmpeg filtergraph on stderr.
 */

const fs = require("fs");
const { spawnSync } = require("child_process");
const {
  loadEditorContext, propagateSidecars, probeFps,
  defaultMobileZoomCenter, validatePan, panPathExpressions,
} = require("./lib/editor");

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

// If a <input>.frame.json sidecar exists, the input is a framed composite -
// switch default center to the phone-screen midpoint in composite coords.
const frameMetaPath = INPUT + ".frame.json";
const frameMeta = fs.existsSync(frameMetaPath)
  ? JSON.parse(fs.readFileSync(frameMetaPath, "utf8"))
  : null;
if (frameMeta) {
  console.log(`Frame metadata → ${frameMetaPath}  (canvas ${frameMeta.canvas.w}×${frameMeta.canvas.h}, screen at ${frameMeta.screen.x},${frameMeta.screen.y})`);
}

// Preserve the source's frame rate end-to-end. zoompan's `fps=` controls
// its output PTS rate, so it must match what the file actually has - any
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

// Segment ramp boundaries:
//   t0 ramp-in start (1x) → t1 peak start (scale) → t2 peak end (scale)
//   → t3 ramp-out end (1x).
const segments = [];
for (const d of ctx.editor.directives) {
  if (d.kind !== "zoom") continue;
  const scale = Number(d.scale);
  if (!(scale > 1)) {
    console.error(`zoom directive: scale must be > 1 (got ${d.scale})`);
    process.exit(2);
  }
  const rampMs = Math.max(0, Number.isFinite(d.rampMs) ? d.rampMs : DEFAULT_RAMP_MS);

  let t0Ms, t1Ms, t2Ms, t3Ms, anchorEvent, anchorLabel, spanMs;
  if (d.fromLine != null && d.toLine != null) {
    const range = ctx.resolveLineRange(d); // includes startDelayMs/endDelayMs
    // peak held from range.tStart..range.tEnd; ramps lie OUTSIDE the peak
    // window so the zoom is already at peak the moment fromLine fires.
    t1Ms = range.tStart;
    t2Ms = range.tEnd - rampMs;
    t0Ms = range.tStart - rampMs;
    t3Ms = range.tEnd;
    if (t2Ms < t1Ms) t2Ms = t1Ms;
    anchorEvent = range.fromEvent;
    anchorLabel = `fromLine ${d.fromLine} → toLine ${d.toLine}`;
    spanMs = { tStart: range.tStart, tEnd: range.tEnd };
  } else {
    if (d.line == null || d.side == null) {
      console.error(`zoom directive missing either {line,side} or {fromLine,toLine}: ${JSON.stringify(d)}`);
      process.exit(2);
    }
    const span = ctx.resolveSpan(d); // includes startDelayMs/endDelayMs
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
    spanMs = { tStart: tStartMs, tEnd: tEndMs };
  }

  // Custom x/y override the mobile-safe default. Interpreted in composite
  // pixel space when frame.json is present, recording pixels otherwise.
  let center;
  if (Number.isFinite(d.x) && Number.isFinite(d.y)) {
    center = { x: Number(d.x), y: Number(d.y) };
  } else if (d.center && Number.isFinite(d.center.x) && Number.isFinite(d.center.y)) {
    center = { x: d.center.x, y: d.center.y };
  } else {
    center = defaultMobileZoomCenter(scale, frameMeta, srcW, srcH);
  }

  const panLabel = `zoom(${anchorLabel})`;
  const panMs = validatePan(d.pan, spanMs, panLabel);

  const off = ctx.recordStartOffsetMs;
  // Pan waypoints in absolute raw-recording seconds for the piecewise
  // x(t)/y(t) expressions later.
  const panSec = panMs.map((w) => ({ t: (w.tMs + off) / 1000, x: w.x, y: w.y, ease: w.ease }));

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
    pan: panSec,
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
  const panSuffix = s.pan.length > 0
    ? `  pan=${s.pan.length}wp (${s.pan.map((w) => `${(w.t - s.tStart).toFixed(1)}s→${w.x.toFixed(0)},${w.y.toFixed(0)}`).join(" → ")})`
    : "";
  console.log(`  [${s.t0.toFixed(2)}→${s.t1.toFixed(2)}..${s.t2.toFixed(2)}→${s.t3.toFixed(2)}]s  scale=${s.scale}  at=(${s.cx.toFixed(0)},${s.cy.toFixed(0)})  ${s.label}${panSuffix}`);
}

function fmt(n) { return Number(n).toFixed(3); }

function amountSubExpr(seg) {
  // Cascading `lt` checks keep the four time regions mutually exclusive.
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

// Outside any segment the expression evaluates to canvas center; ffmpeg
// still parses it but zoom is 1× there so the value doesn't matter.
function staticCenterExpr(coord) {
  let expr = coord === "x" ? "iw/2" : "ih/2";
  for (const s of segments) {
    const staticC = coord === "x" ? s.cx : s.cy;
    let segExpr;
    if (s.pan.length === 0) {
      segExpr = fmt(staticC);
    } else {
      const waypoints = s.pan.map((w) => ({ t: w.t, x: w.x, y: w.y, ease: w.ease }));
      const initialX = coord === "x" ? s.cx : s.cy;
      const { xExpr, yExpr } = panPathExpressions("t", s.tStart, s.cx, s.cy, waypoints);
      segExpr = coord === "x" ? xExpr : yExpr;
    }
    expr = `if(between(t,${fmt(s.tStart)},${fmt(s.tEnd)}), ${segExpr}, ${expr})`;
  }
  return expr;
}

// scale=eval=frame + bounded crop instead of zoompan: zoompan rounds x/y
// to integers per output frame, so at slow pan velocities (≤2 px/frame)
// the camera judders visibly. Floating-point per-frame eval keeps
// sub-pixel motion smooth.
const S  = `(${scaleExpr})`;
const CX = `(${staticCenterExpr("x")})`;
const CY = `(${staticCenterExpr("y")})`;
// crop top-left clamped to [0, scaledDim - cropDim] so the camera never
// reveals canvas edges. Input is already canvas-sized; output keeps the
// same dims to preserve the framed scene's aspect.
const cropX = `min(max(${CX}*${S}-${srcW}/2,0),iw*${S}-${srcW})`;
const cropY = `min(max(${CY}*${S}-${srcH}/2,0),ih*${S}-${srcH})`;

const vf =
  `scale=w='iw*${S}':h='ih*${S}':eval=frame,` +
  `crop=${srcW}:${srcH}:x='${cropX}':y='${cropY}':exact=1`;

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
