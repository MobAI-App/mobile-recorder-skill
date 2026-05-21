#!/usr/bin/env node
/**
 * Render tap ripples + a moving "finger" overlay onto a recording, using
 * ffmpeg.
 *
 * Usage:
 *   node add_highlights.js <raw.mp4> <timeline.json> <out.mp4> [--ripple-color rgba]
 *
 * What it does:
 *   - reads timeline.json
 *   - generates a soft circular ripple sprite (alpha gradient from centre)
 *     via ffmpeg `geq`, cached at /tmp/demo-ripple-<...>.png
 *   - generates a smaller solid-white "finger" sprite, cached likewise
 *   - overlays one ripple per tap/click at the moment of the tap
 *   - overlays a single persistent finger across the whole take whose x/y
 *     interpolates between action positions (holds at the previous tap,
 *     slides into the next tap in the last ~300 ms, follows the path of a
 *     swipe over its duration)
 *   - emits a sidecar `<out>.captions.json` track so captions can be burned
 *     in later (we don't burn them here because many ffmpeg builds lack
 *     drawtext / libfreetype)
 *
 * Coordinates in the timeline are in *source pixels* of the recording.
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { probeFps } = require("./lib/editor");

const argv = process.argv.slice(2);
if (argv.length < 3) {
  console.error(
    "usage: node add_highlights.js <raw.mp4> <timeline.json> <out.mp4> [flags]\n" +
    "\n" +
    "Ripple flags:\n" +
    "  --ripple-color R:G:B:A     0–255 each. Default 255:255:255:180.\n" +
    "  --ripple-size-frac F       Diameter as a fraction of the recording's\n" +
    "                             short edge. Default 0.11.\n" +
    "  --ripple-duration-ms N     How long each ripple stays on. Default 520.\n" +
    "  --ripple-sprite PATH       Use this PNG/MOV with alpha instead of the\n" +
    "                             procedural soft circle.\n" +
    "  --no-ripple                Skip tap ripples entirely.\n" +
    "\n" +
    "Finger overlay flags:\n" +
    "  --finger-color R:G:B:A     0–255 each. Default 255:255:255:230.\n" +
    "  --finger-size-frac F       Diameter relative to ripple diameter.\n" +
    "                             Default 0.55.\n" +
    "  --finger-sprite PATH       Use this PNG with alpha instead of the\n" +
    "                             procedural soft dot.\n" +
    "  --no-finger                Skip the moving finger overlay entirely.\n" +
    "\n" +
    "Swipe trail flags:\n" +
    "  --swipe-trail-color R:G:B:A   0–255 each. Defaults to --finger-color.\n" +
    "  --swipe-trail-width-frac F    Trail width relative to finger diameter.\n" +
    "                                Default 0.8.\n" +
    "  --no-swipe-trail              Skip the comet trail behind swipes.",
  );
  process.exit(2);
}
const [RAW, TIMELINE, OUT] = argv.slice(0, 3);

function readFlag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
}
const RIPPLE_COLOR        = readFlag("--ripple-color", "255:255:255:180");
const RIPPLE_SIZE_FRAC    = Number(readFlag("--ripple-size-frac", "0.11"));
const RIPPLE_MS           = Number(readFlag("--ripple-duration-ms", "520"));
const RIPPLE_SPRITE_IN    = readFlag("--ripple-sprite", null);
const RIPPLE_ON           = !argv.includes("--no-ripple");
const FINGER_COLOR        = readFlag("--finger-color", "255:255:255:230");
const FINGER_SIZE_FRAC    = Number(readFlag("--finger-size-frac", "0.55"));
const FINGER_SPRITE_IN    = readFlag("--finger-sprite", null);
const FINGER_ON           = !argv.includes("--no-finger");
const SWIPE_TRAIL_COLOR   = readFlag("--swipe-trail-color", FINGER_COLOR);
const SWIPE_TRAIL_WIDTH_FRAC = Number(readFlag("--swipe-trail-width-frac", "0.8"));
const SWIPE_TRAIL_ON      = !argv.includes("--no-swipe-trail");

if (RIPPLE_SPRITE_IN && !fs.existsSync(RIPPLE_SPRITE_IN)) {
  console.error(`--ripple-sprite not found: ${RIPPLE_SPRITE_IN}`);
  process.exit(3);
}
if (FINGER_SPRITE_IN && !fs.existsSync(FINGER_SPRITE_IN)) {
  console.error(`--finger-sprite not found: ${FINGER_SPRITE_IN}`);
  process.exit(3);
}

if (!fs.existsSync(RAW))      { console.error(`not found: ${RAW}`); process.exit(3); }
if (!fs.existsSync(TIMELINE)) { console.error(`not found: ${TIMELINE}`); process.exit(3); }

// ---------------------------------------------------------------------------
// probe source

const probe = spawnSync("ffprobe", [
  "-v", "error", "-select_streams", "v:0",
  "-show_entries", "stream=width,height",
  "-of", "csv=p=0", RAW,
]);
if (probe.status !== 0) {
  console.error("ffprobe failed:", probe.stderr.toString());
  process.exit(4);
}
const [srcW, srcH] = probe.stdout.toString().trim().split(",").map(Number);
const isPortrait   = srcH > srcW;

// ripple sized as a fraction of the *short* edge — about 11% on mobile
const rippleDiameter = Math.max(8, Math.round(Math.min(srcW, srcH) * RIPPLE_SIZE_FRAC));
const rippleMs       = RIPPLE_MS;

// ---------------------------------------------------------------------------
// generate (or reuse) the soft ripple sprite

const events = JSON.parse(fs.readFileSync(TIMELINE, "utf8"));

// The recorder is started before the .mob runs, so the choreography's t=0 is
// not the recording's t=0. recordStartOffsetMs is the wall-clock gap, captured
// on the record_start event by build_timeline.js.
const recordStart = events.find((e) => e.type === "record_start") || {};
const recordStartOffsetMs = Number.isFinite(recordStart.recordStartOffsetMs) ? recordStart.recordStartOffsetMs : 0;

let ripplePath = RIPPLE_SPRITE_IN;
if (RIPPLE_ON && !ripplePath) {
  ripplePath = path.join(os.tmpdir(), `demo-ripple-${rippleDiameter}-${RIPPLE_COLOR.replace(/[^0-9]/g, "_")}.png`);
  if (!fs.existsSync(ripplePath)) {
    const [r, g, b, aPeak] = RIPPLE_COLOR.split(":").map(Number);
    const D = rippleDiameter;
    const C = D / 2;
    // Soft circle: alpha falls off quadratically from the center to the edge.
    // Outer 6% is fully transparent (anti-aliased seam).
    const expr = `r=${r}:g=${g}:b=${b}:a='if(lt(hypot(X-${C},Y-${C}),${C * 0.94}), ${aPeak}*pow(max(0,1-hypot(X-${C},Y-${C})/${C * 0.94}),1.6), 0)'`;
    const gen = spawnSync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", `color=c=black@0:s=${D}x${D}:d=0.04`,
      "-vf", `format=rgba,geq=${expr}`,
      "-frames:v", "1",
      ripplePath,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    if (gen.status !== 0) {
      console.error("failed to render ripple sprite:", gen.stderr.toString());
      process.exit(5);
    }
    console.log(`Ripple sprite → ${ripplePath} (${D}×${D})`);
  }
}

// ---------------------------------------------------------------------------
// generate (or reuse) the persistent "finger" sprite — small solid dot that
// travels along the path between actions

const fingerDiameter = Math.max(6, Math.round(rippleDiameter * FINGER_SIZE_FRAC));
let fingerPath = FINGER_SPRITE_IN;
if (FINGER_ON && !fingerPath) {
  fingerPath = path.join(os.tmpdir(), `demo-finger-${fingerDiameter}-${FINGER_COLOR.replace(/[^0-9]/g, "_")}.png`);
  if (!fs.existsSync(fingerPath)) {
    const [r, g, b, aPeak] = FINGER_COLOR.split(":").map(Number);
    const D = fingerDiameter;
    const C = D / 2;
    // Inner 70% of radius is fully opaque at the requested color; outer 30%
    // is a soft anti-aliased halo down to 0.
    const expr = `r=${r}:g=${g}:b=${b}:a='if(lt(hypot(X-${C},Y-${C}),${C * 0.7}), ${aPeak}, if(lt(hypot(X-${C},Y-${C}),${C * 0.95}), ${aPeak}*(1-(hypot(X-${C},Y-${C})-${C * 0.7})/${C * 0.25}), 0))'`;
    const gen = spawnSync("ffmpeg", [
      "-y",
      "-f", "lavfi", "-i", `color=c=black@0:s=${D}x${D}:d=0.04`,
      "-vf", `format=rgba,geq=${expr}`,
      "-frames:v", "1",
      fingerPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    if (gen.status !== 0) {
      console.error("failed to render finger sprite:", gen.stderr.toString());
      process.exit(7);
    }
    console.log(`Finger sprite → ${fingerPath} (${D}×${D})`);
  }
}

// ---------------------------------------------------------------------------
// generate (or reuse) a swipe-trail PNG per swipe — a comet line drawn
// across the recording canvas, fading from low alpha at the start to peak
// alpha at the swipe's endpoint (so the trail visually "leads into" the
// finger sprite's final position).
//
// One PNG per (start, end, color, width) combination, cached in $TMPDIR.

const trailRadius = Math.max(3, Math.round(fingerDiameter * SWIPE_TRAIL_WIDTH_FRAC / 2));
const trailSprites = new Map(); // swipeKey → { path, x1, y1, x2, y2, tin, tout }

function makeTrailSprite(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length2 = dx * dx + dy * dy;
  if (length2 < 4) return null;  // degenerate (same start/end), skip
  const length = Math.sqrt(length2);

  const key = `${x1}_${y1}_${x2}_${y2}_${SWIPE_TRAIL_COLOR.replace(/[^0-9]/g, "_")}_${trailRadius}`;
  if (trailSprites.has(key)) return trailSprites.get(key).path;
  const out = path.join(os.tmpdir(), `demo-swipe-${srcW}x${srcH}-${key}.png`);
  if (fs.existsSync(out)) { trailSprites.set(key, { path: out }); return out; }

  const [r, g, b, aPeak] = SWIPE_TRAIL_COLOR.split(":").map(Number);
  // For pixel (X, Y):
  //   projT = ((X-x1)*dx + (Y-y1)*dy) / length²    ∈ [0, 1] inside the segment
  //   distPerp = |(X-x1)*dy - (Y-y1)*dx| / length
  //   on-line if 0 ≤ projT ≤ 1 AND distPerp ≤ trailRadius
  //   alpha = aPeak * projT * smoothFalloff(distPerp)
  const projT = `(((X-${x1})*${dx})+((Y-${y1})*${dy}))/${length2}`;
  const distPerp = `abs(((X-${x1})*${dy})-((Y-${y1})*${dx}))/${length}`;
  const inRange = `gte(${projT},0)*lte(${projT},1)`;
  const soft = `max(0,1-(${distPerp})/${trailRadius})`;
  const alphaExpr =
    `${aPeak}*pow(${projT},1.2)*(${inRange})*(${soft})`;

  const gen = spawnSync("ffmpeg", [
    "-y",
    "-f", "lavfi", "-i", `color=c=black@0:s=${srcW}x${srcH}:d=0.04`,
    "-vf", `format=rgba,geq=r=${r}:g=${g}:b=${b}:a='${alphaExpr}'`,
    "-frames:v", "1", "-update", "1",
    out,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  if (gen.status !== 0) {
    console.error("failed to render swipe trail sprite:");
    console.error(gen.stderr.toString().split("\n").slice(-10).join("\n"));
    process.exit(8);
  }
  console.log(`Swipe trail → ${out} (${x1},${y1} → ${x2},${y2}, radius ${trailRadius}px)`);
  trailSprites.set(key, { path: out });
  return out;
}

// ---------------------------------------------------------------------------
// build overlay events
//
// Two visual layers:
//   1. RIPPLES — one short overlay per tap, radiant white circle, plays at
//      the moment of the tap.
//   2. FINGER — one persistent overlay covering the whole take, a small
//      solid white dot whose x/y is a piecewise expression over time.
//
// Between actions, the finger holds at the previous action's position. In
// the last ~300 ms before the next tap, it slides to the new position. For
// swipes, the finger animates from start to end over the swipe duration.

const stopMs = (events.find((e) => e.type === "record_stop") || {}).timeMs
            ?? events[events.length - 1].timeMs;

const MOVE_DUR = 0.30;   // seconds spent sliding into the next tap
const FINGER_TAIL = 0.5; // hold the finger at the last spot for this long after the final action

// ripple events.
//
// Fire at timeMs (action start = when MobAI initiated the touch). iOS's
// visual tap response triggers off touch-DOWN, which is what startedAtMs
// captures — so firing at action_end pushes the ripple noticeably late.
// MobAI's reported durationMs includes touch-up + any post-tap settle,
// so it isn't the right offset.
const overlayEvents = [];
if (RIPPLE_ON) {
  for (const e of events) {
    if ((e.type === "tap" || e.type === "click") && e.x != null && e.y != null) {
      overlayEvents.push({
        cx: e.x,
        cy: e.y,
        tin:  (e.timeMs + recordStartOffsetMs) / 1000,
        tout: (e.timeMs + recordStartOffsetMs + rippleMs) / 1000,
      });
    }
    // swipe trails are now expressed by the moving finger itself — no per-step
    // dots needed.
  }
}

// swipe trail events — one per swipe action
const trailEvents = [];
if (SWIPE_TRAIL_ON) {
  for (const e of events) {
    if (!(e.type === "swipe" || e.type === "scroll")) continue;
    if (e.x2 == null || e.y2 == null) continue;
    const trailPath = makeTrailSprite(e.x, e.y, e.x2, e.y2);
    if (!trailPath) continue;
    const tStart = (e.timeMs + recordStartOffsetMs) / 1000;
    const dur = (e.durationMs || 320) / 1000;
    trailEvents.push({
      path: trailPath,
      tin:  tStart,
      tout: tStart + dur + 0.6,   // 600 ms after swipe end → trail lingers briefly
      fadeIn:  Math.min(0.25, dur * 0.6),
      fadeOut: 0.4,
    });
  }
}

// finger keypoints
const actionable = FINGER_ON ? events.filter((e) =>
  ((e.type === "tap" || e.type === "click") && e.x != null && e.y != null) ||
  ((e.type === "swipe" || e.type === "scroll") && e.x2 != null && e.y2 != null)
) : [];

const fingerKeypoints = [];
for (const e of actionable) {
  const isSwipe = (e.type === "swipe" || e.type === "scroll");
  const startT = (e.timeMs + recordStartOffsetMs) / 1000;
  const endT   = (e.timeMs + (e.durationMs || 0) + recordStartOffsetMs) / 1000;
  // Arrive at the action's START position when the action fires — that
  // matches when iOS visually reacts to touch-down. For swipes the
  // finger then travels to (x2, y2) over the swipe's duration.
  const arriveT = startT;

  if (fingerKeypoints.length === 0) {
    fingerKeypoints.push({ t: arriveT, x: e.x, y: e.y });
  } else {
    const prev = fingerKeypoints[fingerKeypoints.length - 1];
    const holdT = Math.max(prev.t, arriveT - MOVE_DUR);
    // 10 ms threshold: if actions fire closer than that, skip the hold
    // segment entirely and let the finger jump. Anything tighter (e.g.
    // the previous 1 µs threshold) can silently drop legitimate hold
    // points when timeline arithmetic produces a sub-millisecond gap.
    if (holdT > prev.t + 1e-2) {
      fingerKeypoints.push({ t: holdT, x: prev.x, y: prev.y });
    }
    fingerKeypoints.push({ t: arriveT, x: e.x, y: e.y });
  }

  if (isSwipe) {
    fingerKeypoints.push({ t: endT, x: e.x2, y: e.y2 });
  }
}

// ---------------------------------------------------------------------------
// captions sidecar (we don't burn them in — ffmpeg drawtext / libfreetype is
// not always available)

// Captions sidecar — emit in RAW-RECORDING time so it matches the highlights
// mp4 (which is the untrimmed source plus overlays). export_video.sh emits a
// separate, trimmed-video-time sidecar next to the final export.
const captionEvents = events.filter((e) => e.caption);
const captionsJson = captionEvents.map((e, idx) => ({
  startMs: e.timeMs + recordStartOffsetMs,
  endMs:   (captionEvents[idx + 1]?.timeMs ?? stopMs) + recordStartOffsetMs,
  text:    e.caption,
}));
const captionsPath = OUT.replace(/\.[^.]+$/, "") + ".captions.json";
fs.writeFileSync(captionsPath, JSON.stringify(captionsJson, null, 2) + "\n");
console.log(`Captions sidecar → ${captionsPath}`);

// ---------------------------------------------------------------------------
// build filtergraph

// inputs: [0:v] = the recording, [1:v] = the ripple sprite (looped)
// chain pattern (for N overlay events):
//   [0:v][1:v] overlay=...:enable='between(t,tin0,tout0)' [v0]
//   [v0][1:v]  overlay=...:enable='between(t,tin1,tout1)' [v1]
//   ...
//
// For ripple growth (width interpolation across enable window) we use
// the `scale2ref` filter inside a per-overlay branch — too expensive.
// Cheaper: ffmpeg's overlay supports per-event w/h via the `scale` filter
// in a sub-chain. We instead approximate "growth" by emitting multiple
// short enable windows at increasing scale (3 steps inside the growth
// phase, 4 inside the hold phase).

// One overlay per event. Sprite carries its own alpha; no per-event scaling
// or color-mixer branches.

// Compute input indices dynamically — [0:v] is the recording. Subsequent
// slots are: ripple sprite (if any), finger sprite (if any), then one
// unique trail sprite input per distinct trail PNG (multiple swipes can
// share a sprite if they have identical coords).
const useRipple = RIPPLE_ON && overlayEvents.length > 0 && ripplePath;
const useFinger = FINGER_ON && fingerKeypoints.length > 0 && fingerPath;
const useTrails = SWIPE_TRAIL_ON && trailEvents.length > 0;
let nextIdx = 1;
const rippleIdx = useRipple ? nextIdx++ : null;
const fingerIdx = useFinger ? nextIdx++ : null;
// Each trail event gets its own input slot (we don't dedupe across events
// because each has a distinct enable-window and fade timing).
trailEvents.forEach((te) => { te.idx = nextIdx++; });

const chain = [];
let lastLabel = "[0:v]";

// Trail overlays go FIRST (under the ripples and finger). Each trail has
// its own fade-in/fade-out via the `fade` filter on its input.
trailEvents.forEach((te, i) => {
  const fadeStream = `[t${i}p]`;
  const outLabel   = `[t${i}]`;
  chain.push(
    `[${te.idx}:v] ` +
    `fade=t=in:st=${te.tin.toFixed(3)}:d=${te.fadeIn.toFixed(3)}:alpha=1,` +
    `fade=t=out:st=${(te.tout - te.fadeOut).toFixed(3)}:d=${te.fadeOut.toFixed(3)}:alpha=1 ` +
    `${fadeStream}`,
  );
  chain.push(
    `${lastLabel}${fadeStream} overlay=x=0:y=0:shortest=1:enable='between(t,${te.tin.toFixed(3)},${te.tout.toFixed(3)})' ${outLabel}`,
  );
  lastLabel = outLabel;
});

if (useRipple) {
  // The single ripple sprite is reused by reference: we split [N:v] into M
  // outputs, each consumed by its own overlay enable window.
  if (overlayEvents.length === 1) {
    chain.push(`[${rippleIdx}:v] null [s0]`);
  } else {
    chain.push(`[${rippleIdx}:v] split=${overlayEvents.length} ${overlayEvents.map((_, i) => `[s${i}]`).join("")}`);
  }

  overlayEvents.forEach((o, i) => {
    const nextLabel = `[v${i}]`;
    const x = `${o.cx} - overlay_w/2`;
    const y = `${o.cy} - overlay_h/2`;
    // `shortest=1` keeps ffmpeg from waiting on the looped sprite input.
    chain.push(`${lastLabel}[s${i}] overlay=x=${x}:y=${y}:shortest=1:enable='between(t,${o.tin.toFixed(3)},${o.tout.toFixed(3)})' ${nextLabel}`);
    lastLabel = nextLabel;
  });
}

// finger overlay (on top of all ripples)
if (useFinger) {
  // Build piecewise x(t) and y(t) expressions by walking the keypoints in
  // reverse and wrapping each segment in an `if(lt(t, t_b), …, …)`.
  function buildExpr(key) {
    const last = fingerKeypoints[fingerKeypoints.length - 1];
    let expr = `${last[key]}`;
    for (let i = fingerKeypoints.length - 2; i >= 0; i--) {
      const a = fingerKeypoints[i];
      const b = fingerKeypoints[i + 1];
      const dt = b.t - a.t;
      if (dt < 1e-3) continue;
      if (a[key] === b[key]) {
        // hold segment
        expr = `if(lt(t,${b.t.toFixed(3)}),${a[key]},${expr})`;
      } else {
        // linear interpolation across [a.t, b.t]
        const seg = `${a[key]}+(${b[key]}-${a[key]})*(t-${a.t.toFixed(3)})/${dt.toFixed(3)}`;
        expr = `if(lt(t,${b.t.toFixed(3)}),${seg},${expr})`;
      }
    }
    return expr;
  }

  const xExpr = buildExpr("x");
  const yExpr = buildExpr("y");
  const tStart = fingerKeypoints[0].t;
  const tEnd   = fingerKeypoints[fingerKeypoints.length - 1].t + FINGER_TAIL;

  const nextLabel = `[vf]`;
  chain.push(
    `${lastLabel}[${fingerIdx}:v] overlay=` +
    `x='(${xExpr})-overlay_w/2':` +
    `y='(${yExpr})-overlay_h/2':` +
    `eval=frame:shortest=1:` +
    `enable='between(t,${tStart.toFixed(3)},${tEnd.toFixed(3)})' ${nextLabel}`
  );
  lastLabel = nextLabel;
}

// Input layout:
//   [0:v] = raw recording
//   [1:v] = ripple sprite (looped)
//   [2:v] = finger sprite (looped)

// final label
chain.push(`${lastLabel} null [vout]`);

const filtergraph = chain.join(";\n");

// ---------------------------------------------------------------------------
// invoke ffmpeg

if (!useRipple && !useFinger && !useTrails) {
  console.log("No overlays; copying raw → out.");
  const r = spawnSync("ffmpeg", ["-y", "-i", RAW, "-c", "copy", OUT], { stdio: "inherit" });
  process.exit(r.status ?? 0);
}

// Force the output rate to match the source. The overlay+loop filtergraph
// would otherwise collapse to ~4 fps because the looped sprite inputs are
// infinite-rate sources and ffmpeg picks the lowest common rate. Matching
// source avoids needless frame duplication.
const SRC_FPS = probeFps(RAW);
console.log(`Source fps: ${SRC_FPS} (preserved through this stage)`);
const args = ["-y", "-i", RAW];
if (useRipple) args.push("-loop", "1", "-i", ripplePath);
if (useFinger) args.push("-loop", "1", "-i", fingerPath);
if (useTrails) {
  for (const te of trailEvents) args.push("-loop", "1", "-i", te.path);
}
args.push(
  "-filter_complex", filtergraph,
  "-map", "[vout]",
  "-r", String(SRC_FPS), "-vsync", "cfr",
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
  "-movflags", "+faststart",
  "-an",
  OUT,
);

const r = spawnSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
if (r.status !== 0) {
  console.error("ffmpeg highlight pass failed:");
  console.error(r.stderr.toString().split("\n").slice(-30).join("\n"));
  process.exit(r.status ?? 5);
}
console.log(`Highlights → ${OUT}`);
