#!/usr/bin/env node
/**
 * Render tap ripples + a walking-cursor finger overlay onto a recording.
 *
 *   node add_highlights.js <raw.mp4> <timeline.json> <out.mp4> [editor.json] [flags]
 *
 * Coordinates in the timeline are in source pixels of the recording. The
 * captions sidecar is emitted at <out>.captions.json (raw-recording time);
 * downstream stages remap it. Ripples and finger sprites are procedural
 * (one-off geq pass, cached in $TMPDIR) so most ffmpeg builds work without
 * drawtext/libfreetype.
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { probeFps } = require("./lib/editor");

const argv = process.argv.slice(2);
if (argv.length < 3) {
  console.error(
    "usage: node add_highlights.js <raw.mp4> <timeline.json> <out.mp4> [editor.json] [flags]\n" +
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

// Optional 4th positional: editor.json. When provided, captions come from
// editor.captions[] (preferred - supports startDelayMs / endDelayMs /
// durationMs) and fall through to .mob `# Caption:` comments only when the
// array is absent. Without it, the script falls back to the legacy
// derive-from-.mob-comments path.
const EDITOR = argv[3] && !argv[3].startsWith("--") ? argv[3] : null;

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

// ripple sized as a fraction of the *short* edge - about 11% on mobile
const rippleDiameter = Math.max(8, Math.round(Math.min(srcW, srcH) * RIPPLE_SIZE_FRAC));
const rippleMs       = RIPPLE_MS;


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

// One swipe-trail PNG per (start, end, color, width); alpha grows from
// start to endpoint so the trail leads into the finger's final position.
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

const stopMs = (events.find((e) => e.type === "record_stop") || {}).timeMs
            ?? events[events.length - 1].timeMs;

// Per-tap anchor shift from editor.highlights[]. Lets the author push a
// specific tap's ripple + finger arrival into a long iOS view-transition
// where the visual response lands well after touch-down, without
// re-recording or affecting any other tap.
const highlightDelaysByLine = new Map();
if (EDITOR && fs.existsSync(EDITOR)) {
  const editorRaw = JSON.parse(fs.readFileSync(EDITOR, "utf8"));
  const rules = Array.isArray(editorRaw.highlights) ? editorRaw.highlights : [];
  for (const r of rules) {
    if (r.line == null) continue;
    const ms = Number(r.startDelayMs ?? 0);
    if (Number.isFinite(ms) && ms !== 0) highlightDelaysByLine.set(Number(r.line), ms);
  }
}
function highlightAnchorOffsetMs(e) {
  if (e.line == null) return 0;
  return highlightDelaysByLine.get(e.line) || 0;
}

// ripple events: fire at action start + any per-line override.
const overlayEvents = [];
if (RIPPLE_ON) {
  for (const e of events) {
    if ((e.type === "tap" || e.type === "click") && e.x != null && e.y != null) {
      const anchorMs = e.timeMs + highlightAnchorOffsetMs(e);
      overlayEvents.push({
        cx: e.x,
        cy: e.y,
        tin:  (anchorMs + recordStartOffsetMs) / 1000,
        tout: (anchorMs + recordStartOffsetMs + rippleMs) / 1000,
      });
    }
    // swipe trails are now expressed by the moving finger itself - no per-step
    // dots needed.
  }
}

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

// Walking-cursor model: one overlay per action. Finger fades in at the
// previous action's target, slides over APPROACH to the new target
// arriving at touch-down, holds through the ripple, fades out. First
// action has no previous target so it just pulses in. Swipes continue
// from (x,y) to (x2,y2) over the swipe's own duration after arrival.
// Between actions the finger is invisible - clustered actions clamp the
// next approach to start no earlier than the previous overlay's enable
// end so two finger sprites never appear at once.
const actionable = FINGER_ON ? events.filter((e) =>
  ((e.type === "tap" || e.type === "click") && e.x != null && e.y != null) ||
  ((e.type === "swipe" || e.type === "scroll") && e.x2 != null && e.y2 != null)
) : [];

const PULSE_PRE   = 0.12;   // fade-in duration when there is NO prior target (first action)
const PULSE_HOLD  = 0.30;   // visible after action ends, covers the ripple
const PULSE_FADE  = 0.25;   // fade-out duration
const APPROACH    = 0.45;   // slide-in time from prev target → new target
const APPROACH_FADE_IN = 0.18; // fade-in for the slide-in phase (shorter than the slide)

// Rest position for the slide-in into the NEXT action: swipe ends at (x2, y2).
function targetOf(e) {
  if (e.type === "swipe" || e.type === "scroll") return { x: e.x2, y: e.y2 };
  return { x: e.x, y: e.y };
}

// Sidecar emitted in raw-recording time so it matches the highlights mp4;
// export_video.js writes a separate trimmed-video-time sidecar later.
// Source preference (via lib/editor.js resolveCaptions): editor.captions[]
// when EDITOR was passed, else legacy `# Caption:` comments.
let captionsJson;
if (EDITOR && fs.existsSync(EDITOR)) {
  const { loadEditorContext } = require("./lib/editor");
  const ctx = loadEditorContext({ editorPath: EDITOR, timelinePath: TIMELINE });
  captionsJson = ctx.resolveCaptions().map((c) => ({
    startMs: c.startMs + recordStartOffsetMs,
    endMs:   c.endMs   + recordStartOffsetMs,
    text:    c.text,
  }));
} else {
  const captionEvents = events.filter((e) => e.caption);
  captionsJson = captionEvents.map((e, idx) => ({
    startMs: e.timeMs + recordStartOffsetMs,
    endMs:   (captionEvents[idx + 1]?.timeMs ?? stopMs) + recordStartOffsetMs,
    text:    e.caption,
  }));
}
const captionsPath = OUT.replace(/\.[^.]+$/, "") + ".captions.json";
fs.writeFileSync(captionsPath, JSON.stringify(captionsJson, null, 2) + "\n");
console.log(`Captions sidecar → ${captionsPath}`);

// Input slots: [0:v] recording, then ripple sprite (if any), finger
// sprite (if any), then one trail sprite per swipe (one slot per swipe
// because each has its own enable window + fade timing).
const useRipple = RIPPLE_ON && overlayEvents.length > 0 && ripplePath;
const useFinger = FINGER_ON && actionable.length > 0 && fingerPath;
const useTrails = SWIPE_TRAIL_ON && trailEvents.length > 0;
let nextIdx = 1;
const rippleIdx = useRipple ? nextIdx++ : null;
const fingerIdx = useFinger ? nextIdx++ : null;
trailEvents.forEach((te) => { te.idx = nextIdx++; });

const chain = [];
let lastLabel = "[0:v]";

// Trail overlays go first so the ripple + finger render on top of them.
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
  // Split the single sprite into M streams - each overlay consumes one,
  // because ffmpeg can't reuse the same input across multiple overlays.
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

if (useFinger) {
  // One sprite stream per action so each gets its own independent fade
  // window. Without split, fade filters compound across overlays and the
  // sprite ends up mostly invisible.
  if (actionable.length === 1) {
    chain.push(`[${fingerIdx}:v] null [fs0]`);
  } else {
    chain.push(`[${fingerIdx}:v] split=${actionable.length} ${actionable.map((_, i) => `[fs${i}]`).join("")}`);
  }

  let prevEnableEnd = -Infinity;
  actionable.forEach((e, i) => {
    const isSwipe = (e.type === "swipe" || e.type === "scroll");
    // editor.highlights[].startDelayMs shifts the visual anchor; defaults to
    // the action's startedAtMs.
    const anchorMs = e.timeMs + highlightAnchorOffsetMs(e);
    const startT  = (anchorMs + recordStartOffsetMs) / 1000;
    const endT    = (e.timeMs + (e.durationMs || 0) + recordStartOffsetMs) / 1000;

    const prev    = i > 0 ? targetOf(actionable[i - 1]) : null;

    let approachStart, fadeInDur;
    if (prev) {
      approachStart = startT - APPROACH;
      fadeInDur     = APPROACH_FADE_IN;
    } else {
      approachStart = startT - PULSE_PRE;
      fadeInDur     = PULSE_PRE;
    }
    // Clamp so two finger sprites can't be visible at once when actions
    // fire so close together that fade windows would otherwise overlap.
    if (approachStart < prevEnableEnd) {
      approachStart = prevEnableEnd;
      fadeInDur     = Math.min(fadeInDur, Math.max(0.04, startT - approachStart));
    }
    if (approachStart < 0) approachStart = 0;

    const fadeOutSt = (isSwipe ? endT : startT) + PULSE_HOLD;
    const enableEnd = fadeOutSt + PULSE_FADE;

    // `alpha=1` makes fade modulate the alpha channel rather than luma.
    const fadeLabel = `[ff${i}]`;
    chain.push(
      `[fs${i}] ` +
      `fade=t=in:st=${approachStart.toFixed(3)}:d=${fadeInDur.toFixed(3)}:alpha=1,` +
      `fade=t=out:st=${fadeOutSt.toFixed(3)}:d=${PULSE_FADE.toFixed(3)}:alpha=1 ` +
      `${fadeLabel}`
    );

    let xExpr, yExpr;
    if (prev && approachStart < startT) {
      // clip(u,0,1) keeps the sprite at the endpoints during the fade-out
      // tail rather than drifting past them.
      const slideX = `${prev.x}+(${e.x}-${prev.x})*clip((t-${approachStart.toFixed(3)})/${(startT - approachStart).toFixed(3)},0,1)`;
      const slideY = `${prev.y}+(${e.y}-${prev.y})*clip((t-${approachStart.toFixed(3)})/${(startT - approachStart).toFixed(3)},0,1)`;
      if (isSwipe) {
        const dt = Math.max(0.001, endT - startT);
        const swipeX = `${e.x}+(${e.x2}-${e.x})*clip((t-${startT.toFixed(3)})/${dt.toFixed(3)},0,1)`;
        const swipeY = `${e.y}+(${e.y2}-${e.y})*clip((t-${startT.toFixed(3)})/${dt.toFixed(3)},0,1)`;
        xExpr = `if(lt(t,${startT.toFixed(3)}),${slideX},${swipeX})`;
        yExpr = `if(lt(t,${startT.toFixed(3)}),${slideY},${swipeY})`;
      } else {
        xExpr = slideX;
        yExpr = slideY;
      }
    } else if (isSwipe) {
      const dt = Math.max(0.001, endT - startT);
      xExpr = `${e.x}+(${e.x2}-${e.x})*clip((t-${startT.toFixed(3)})/${dt.toFixed(3)},0,1)`;
      yExpr = `${e.y}+(${e.y2}-${e.y})*clip((t-${startT.toFixed(3)})/${dt.toFixed(3)},0,1)`;
    } else {
      xExpr = `${e.x}`;
      yExpr = `${e.y}`;
    }

    // eval=frame is required when position varies in time (slide / swipe).
    const needsEval = (prev != null) || isSwipe;
    const nextLabel = `[vf${i}]`;
    chain.push(
      `${lastLabel}${fadeLabel} overlay=` +
      `x='(${xExpr})-overlay_w/2':` +
      `y='(${yExpr})-overlay_h/2':` +
      (needsEval ? `eval=frame:` : ``) +
      `shortest=1:` +
      `enable='between(t,${approachStart.toFixed(3)},${enableEnd.toFixed(3)})' ${nextLabel}`
    );
    lastLabel = nextLabel;
    prevEnableEnd = enableEnd;
  });
}

chain.push(`${lastLabel} null [vout]`);

const filtergraph = chain.join(";\n");

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
