/**
 * Shared loader/resolver for editor.json + timeline.json.
 *
 * The .mob script owns choreography. timeline.json records when each action
 * actually fired during the recording window. editor.json layers
 * post-production directives (zoom, speed, trim) on top, each anchored to a
 * .mob source line.
 *
 * Usage:
 *   const { loadEditorContext } = require("./lib/editor");
 *   const ctx = loadEditorContext({ editorPath, timelinePath });
 *   const span = ctx.resolveSpan({ line: 14, side: "during" });
 */

const fs = require("fs");

const SUPPORTED_SCHEMA_VERSION = 1;
const DEFAULT_TAIL_PAD_MS = 600;

// Signed ms offsets applied to a {tStart, tEnd} span. Negative shifts earlier,
// positive shifts later. Used by every directive (zoom / speed / caption /
// trim) so the agent can fine-tune timing without re-recording.
function applyDelays(span, d) {
  const startDelayMs = Number(d?.startDelayMs ?? 0);
  const endDelayMs   = Number(d?.endDelayMs   ?? 0);
  if (!Number.isFinite(startDelayMs) || !Number.isFinite(endDelayMs)) {
    fatal(`startDelayMs/endDelayMs must be finite numbers (got ${JSON.stringify({ startDelayMs: d.startDelayMs, endDelayMs: d.endDelayMs })})`);
  }
  return { ...span, tStart: span.tStart + startDelayMs, tEnd: span.tEnd + endDelayMs };
}

// ffmpeg expression for the four ease curves on u ∈ [0,1]. Matches the
// desktop sibling's pan-easing so authors get consistent feel.
function easeExpr(u, kind) {
  switch (kind) {
    case "linear": return u;
    case "in":     return `pow(${u},2)`;
    case "out":    return `(1-pow(1-${u},2))`;
    case "in_out": return `if(lt(${u},0.5),4*pow(${u},3),1-pow(-2*${u}+2,3)/2)`;
    default:       return u;
  }
}

// Validate + canonicalize pan waypoints relative to a segment in choreography
// ms. `spanMs.tStart/tEnd` define the segment; each waypoint's afterMs is
// added to spanMs.tStart. Returns sorted absolute-ms waypoints with eases.
function validatePan(rawPan, spanMs, label) {
  if (!Array.isArray(rawPan)) return [];
  const dur = spanMs.tEnd - spanMs.tStart;
  const validEases = new Set(["linear", "in", "out", "in_out"]);
  let prevAfter = -Infinity;
  const out = [];
  for (let j = 0; j < rawPan.length; j++) {
    const w = rawPan[j];
    if (typeof w.afterMs !== "number") fatal(`${label}.pan[${j}]: afterMs is required (number)`);
    if (w.afterMs < 0) fatal(`${label}.pan[${j}]: afterMs must be >= 0 (got ${w.afterMs})`);
    if (w.afterMs >= dur) fatal(`${label}.pan[${j}]: afterMs (${w.afterMs}ms) exceeds range duration (${dur.toFixed(0)}ms)`);
    if (w.afterMs <= prevAfter) fatal(`${label}.pan[${j}]: afterMs must be strictly increasing (${w.afterMs} <= ${prevAfter})`);
    prevAfter = w.afterMs;
    if (!Number.isFinite(w.x) || !Number.isFinite(w.y)) fatal(`${label}.pan[${j}]: x and y required (in canvas pixels)`);
    const ease = w.ease ?? "in_out";
    if (!validEases.has(ease)) fatal(`${label}.pan[${j}]: ease must be one of ${[...validEases].join(", ")}`);
    out.push({ tMs: spanMs.tStart + w.afterMs, x: Number(w.x), y: Number(w.y), ease });
  }
  return out;
}

// Piecewise x(t) / y(t) ffmpeg expressions easing through waypoints.
// Waypoints are absolute seconds. `t` is the variable name to embed - the
// caller picks "t" for the standard timeline variable (scale+crop use it)
// or "out_time" for filters that don't bind `t` (zoompan).
function panPathExpressions(t, startSec, startX, startY, waypointsSec) {
  if (!waypointsSec || waypointsSec.length === 0) {
    return { xExpr: String(startX), yExpr: String(startY) };
  }
  const all = [{ t: startSec, x: startX, y: startY }, ...waypointsSec];
  let xExpr = String(all[all.length - 1].x);
  let yExpr = String(all[all.length - 1].y);
  for (let i = all.length - 2; i >= 0; i--) {
    const a = all[i], b = all[i + 1];
    const dt = b.t - a.t;
    if (dt <= 1e-6) {
      xExpr = `if(lt(${t},${b.t.toFixed(3)}),${a.x},${xExpr})`;
      yExpr = `if(lt(${t},${b.t.toFixed(3)}),${a.y},${yExpr})`;
      continue;
    }
    const u = `((${t}-${a.t.toFixed(3)})/${dt.toFixed(3)})`;
    const eased = easeExpr(u, b.ease ?? "in_out");
    xExpr = `if(lt(${t},${b.t.toFixed(3)}),(${a.x}+(${b.x}-${a.x})*(${eased})),${xExpr})`;
    yExpr = `if(lt(${t},${b.t.toFixed(3)}),(${a.y}+(${b.y}-${a.y})*(${eased})),${yExpr})`;
  }
  return { xExpr, yExpr };
}

// Vertical clamp keeps the iOS status bar visible at any zoom by never
// letting the crop top go above the phone screen's top. Horizontal is
// canvas-center because add_frame.js always centers the phone there.
// Falls back to recording-pixel space when no framed canvas is given.
function defaultMobileZoomCenter(scale, frameMeta, recordingW, recordingH) {
  if (frameMeta && frameMeta.canvas && frameMeta.screen) {
    const { canvas, screen } = frameMeta;
    const cropH = canvas.h / Math.max(1, scale);
    let yCenter = screen.y + cropH / 2;
    yCenter = Math.max(cropH / 2, Math.min(canvas.h - cropH / 2, yCenter));
    return { x: canvas.w / 2, y: yCenter };
  }
  return { x: (recordingW || 1) / 2, y: (recordingH || 1) / 2 };
}

function fatal(msg) {
  console.error(`error: ${msg}`);
  process.exit(5);
}

function eventEnd(e) {
  if (e.type === "wait" || e.type === "swipe" || e.type === "scroll") {
    return e.timeMs + (e.durationMs || 0);
  }
  return e.timeMs;
}

function loadTimeline(timelinePath) {
  if (!timelinePath || !fs.existsSync(timelinePath)) fatal(`timeline not found: ${timelinePath}`);
  const timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
  if (!Array.isArray(timeline)) fatal(`timeline must be a JSON array`);
  return timeline;
}

function loadEditor(editorPath) {
  if (!editorPath || !fs.existsSync(editorPath)) {
    return { schema_version: SUPPORTED_SCHEMA_VERSION, directives: [], trim: null, _absent: true };
  }
  const editor = JSON.parse(fs.readFileSync(editorPath, "utf8"));
  const ver = editor.schema_version ?? SUPPORTED_SCHEMA_VERSION;
  if (ver !== SUPPORTED_SCHEMA_VERSION) {
    fatal(`editor.json schema_version ${ver} not supported (expected ${SUPPORTED_SCHEMA_VERSION})`);
  }
  if (!Array.isArray(editor.directives)) editor.directives = [];
  return editor;
}

function loadEditorContext({ editorPath, timelinePath }) {
  const timeline = loadTimeline(timelinePath);
  const editor = loadEditor(editorPath);

  const recordStart = timeline.find((e) => e.type === "record_start");
  const recordStop  = timeline.find((e) => e.type === "record_stop");
  if (!recordStart || !recordStop) fatal(`timeline missing record_start or record_stop`);

  const recordStartOffsetMs = recordStart.recordStartOffsetMs ?? 0;
  const recordingDurationMs = recordStop.timeMs;

  const actions = timeline.filter(
    (e) => e.type !== "record_start" && e.type !== "record_stop",
  );

  const eventByLine = new Map();
  for (const e of actions) {
    if (!Number.isInteger(e.line)) continue;
    if (eventByLine.has(e.line)) {
      // Map is last-write-wins; warn loudly so the silent shadow doesn't
      // surprise the author. Should be unreachable since .mob parsing
      // emits one event per action line.
      console.warn(`warning: timeline has multiple events on .mob line ${e.line}; editor.json directives will resolve to the last one`);
    }
    eventByLine.set(e.line, e);
  }

  function findEvent(line) {
    const e = eventByLine.get(line);
    if (!e) {
      const available = [...eventByLine.keys()].sort((a, b) => a - b).join(", ");
      fatal(`directive references .mob line ${line}; available action lines in timeline: ${available || "(none)"}`);
    }
    return e;
  }

  function neighbor(e, delta) {
    const idx = actions.indexOf(e);
    const j = idx + delta;
    return j >= 0 && j < actions.length ? actions[j] : null;
  }

  /**
   * Resolve a fromLine..toLine range to choreography-ms tStart/tEnd. The
   * range covers the inclusive span "from when fromLine fires to when
   * toLine fires" - i.e. tStart = fromLine.timeMs, tEnd = toLine.timeMs.
   * Used by zoom directives that hold a peak across multiple actions.
   *
   * Accepts startDelayMs/endDelayMs as signed offsets on each endpoint
   * (positive shifts later, negative shifts earlier).
   */
  function resolveLineRange(d) {
    const { fromLine, toLine } = d;
    if (fromLine == null || toLine == null) {
      fatal(`resolveLineRange: both fromLine and toLine are required`);
    }
    const fromEvent = findEvent(fromLine);
    const toEvent   = findEvent(toLine);
    if (toEvent.timeMs <= fromEvent.timeMs) {
      fatal(`resolveLineRange: toLine ${toLine} (t=${toEvent.timeMs}) must come after fromLine ${fromLine} (t=${fromEvent.timeMs})`);
    }
    const raw = { tStart: fromEvent.timeMs, tEnd: toEvent.timeMs };
    const span = applyDelays(raw, d);
    if (span.tEnd <= span.tStart) {
      fatal(`resolveLineRange: empty range after delays (tStart=${span.tStart}ms tEnd=${span.tEnd}ms)`);
    }
    return { ...span, fromEvent, toEvent };
  }

  function resolveSpan(d) {
    const { line, side } = d;
    const e = findEvent(line);
    const prev = neighbor(e, -1);
    const next = neighbor(e, +1);
    let tStart, tEnd;
    if (side === "before") {
      tStart = prev ? eventEnd(prev) : 0;
      tEnd   = e.timeMs;
    } else if (side === "during") {
      tStart = e.timeMs;
      tEnd   = eventEnd(e);
    } else if (side === "after") {
      tStart = eventEnd(e);
      tEnd   = next ? next.timeMs : recordingDurationMs;
    } else {
      fatal(`directive on line ${line}: side must be "before" | "during" | "after" (got "${side}")`);
    }
    const span = applyDelays({ tStart, tEnd }, d);
    return { ...span, event: e };
  }

  /**
   * Resolve a caption entry to {startMs, endMs, text} in choreography ms.
   *
   * Two anchor shapes (mirrors desktop-recorder-skill's captions[]):
   *   { fromLine, startDelayMs?, toLine, endDelayMs? }   // endpoints by line
   *   { fromLine | line, startDelayMs?, durationMs }     // fixed duration
   *
   * `line` is accepted as an alias for `fromLine` so authors can write
   * either form. Delays are signed ms.
   */
  function resolveCaption(c, idx) {
    const label = `captions[${idx}]`;
    if (typeof c.text !== "string" || !c.text.length) fatal(`${label}: text is required`);
    const fromLine = c.fromLine ?? c.line;
    if (fromLine == null) fatal(`${label}: fromLine (or line) is required`);
    if (c.toLine != null && Number.isFinite(c.durationMs)) {
      fatal(`${label}: toLine and durationMs are mutually exclusive`);
    }
    const fromEvent = findEvent(fromLine);
    const startMs = fromEvent.timeMs + Number(c.startDelayMs ?? 0);
    let endMs;
    if (c.toLine != null) {
      const toEvent = findEvent(c.toLine);
      endMs = toEvent.timeMs + Number(c.endDelayMs ?? 0);
    } else if (Number.isFinite(c.durationMs)) {
      endMs = startMs + Number(c.durationMs);
    } else {
      // implicit: until the next caption (caller resolves) or record_stop.
      endMs = null;
    }
    if (endMs != null && endMs <= startMs) {
      fatal(`${label}: empty time range after delays (startMs=${startMs} endMs=${endMs})`);
    }
    return { startMs, endMs, text: c.text };
  }

  /**
   * Resolve all captions for the demo. Preference order:
   *   1. editor.captions[] - explicit array, ported from desktop's model
   *   2. legacy: actions with `# Caption:` comments in the .mob
   *
   * Returns canonical [{startMs, endMs, text}] sorted by startMs. Captions
   * with `endMs == null` (no toLine, no durationMs) are extended to the
   * next caption's startMs, or to recordingDurationMs for the last one.
   * Overlap is treated like a hard error (single shared bottom strip).
   */
  function resolveCaptions() {
    let resolved;
    if (Array.isArray(editor.captions) && editor.captions.length > 0) {
      resolved = editor.captions.map((c, i) => resolveCaption(c, i));
    } else {
      // Legacy: derive from .mob # Caption: comments. Each captioned event
      // shows from its own timeMs to the next captioned event (or record_stop).
      const captioned = actions.filter((e) => e.caption);
      resolved = captioned.map((e) => ({ startMs: e.timeMs, endMs: null, text: e.caption }));
    }
    resolved.sort((a, b) => a.startMs - b.startMs);
    for (let i = 0; i < resolved.length; i++) {
      if (resolved[i].endMs == null) {
        resolved[i].endMs = i + 1 < resolved.length ? resolved[i + 1].startMs : recordingDurationMs;
      }
    }
    for (let i = 1; i < resolved.length; i++) {
      if (resolved[i].startMs < resolved[i - 1].endMs) {
        fatal(`overlapping captions: "${resolved[i - 1].text}" ends at ${resolved[i - 1].endMs}ms; "${resolved[i].text}" starts at ${resolved[i].startMs}ms. Adjust startDelayMs/endDelayMs/durationMs to separate them.`);
      }
    }
    return resolved;
  }

  function defaultZoomCenter(event, srcW, srcH) {
    if ((event.type === "tap" || event.type === "click") &&
        Number.isFinite(event.x) && Number.isFinite(event.y)) {
      return { x: event.x, y: event.y };
    }
    if ((event.type === "swipe" || event.type === "scroll") &&
        Number.isFinite(event.x2) && Number.isFinite(event.y2)) {
      return { x: (event.x + event.x2) / 2, y: (event.y + event.y2) / 2 };
    }
    return { x: srcW / 2, y: srcH / 2 };
  }

  function trimSpan() {
    const t = editor.trim || {};
    let tStart, tEnd;
    if (t.fromLine != null) {
      tStart = findEvent(t.fromLine).timeMs;
    } else {
      tStart = actions.length > 0 ? actions[0].timeMs : 0;
    }
    if (t.toLine != null) {
      tEnd = eventEnd(findEvent(t.toLine));
    } else {
      tEnd = actions.length > 0
        ? eventEnd(actions[actions.length - 1]) + DEFAULT_TAIL_PAD_MS
        : recordingDurationMs;
    }

    // Apply trim's own startDelayMs/endDelayMs (signed ms).
    const trimmed = applyDelays({ tStart, tEnd }, t);
    tStart = trimmed.tStart;
    tEnd   = trimmed.tEnd;

    // Auto-extend the trim head to include any zoom ramp-in that begins
    // BEFORE the first kept action. Without this, a `fromLine/toLine` zoom
    // whose ramp-in lands in the trimmed-off region would be invisible -
    // the viewer would just see the final video start already-zoomed.
    // Negative choreography ms is fine: the raw mp4 has frames during the
    // setup section (before the record_start checkpoint), so the trim can
    // reach into that region. Real lower bound is -recordStartOffsetMs.
    const minTStart = -recordStartOffsetMs;
    for (const d of editor.directives) {
      if (d.kind !== "zoom" || d.fromLine == null) continue;
      const rampMs = Math.max(0, Number.isFinite(d.rampMs) ? d.rampMs : 200);
      const fromEvent = findEvent(d.fromLine);
      const startDelayMs = Number(d.startDelayMs ?? 0);
      const rampInStart = fromEvent.timeMs + startDelayMs - rampMs;
      if (rampInStart < tStart) tStart = Math.max(minTStart, rampInStart);
    }

    if (Number.isFinite(t.headPadMs)) tStart = Math.max(0, tStart - t.headPadMs);
    if (Number.isFinite(t.tailPadMs)) tEnd += t.tailPadMs;

    return { tStart, tEnd };
  }

  return {
    editor,
    timeline,
    actions,
    recordStartOffsetMs,
    recordingDurationMs,
    findEvent,
    resolveSpan,
    resolveLineRange,
    resolveCaptions,
    defaultZoomCenter,
    trimSpan,
  };
}

function propagateSidecars(input, output, { skipCaptions = false, skipWarp = false } = {}) {
  if (!skipCaptions) {
    const inCap  = input.replace(/\.[^.]+$/, "")  + ".captions.json";
    const outCap = output.replace(/\.[^.]+$/, "") + ".captions.json";
    if (fs.existsSync(inCap) && inCap !== outCap) fs.copyFileSync(inCap, outCap);
  }
  if (!skipWarp) {
    const inWarp  = input  + ".timewarp.json";
    const outWarp = output + ".timewarp.json";
    if (fs.existsSync(inWarp) && inWarp !== outWarp) fs.copyFileSync(inWarp, outWarp);
  }
}

/**
 * Probe an mp4 for its actual frame rate. Used by every editing stage so
 * the output rate matches the input rate - no silent upsample/duplication.
 *
 * Prefers nb_frames/duration (computed average over the file) over the
 * container's r_frame_rate (often a codec placeholder like 600/1 from
 * simctl) or avg_frame_rate (sometimes lossy on VFR sources). Falls back
 * to avg_frame_rate, then to a 30 fps default.
 */
function probeFps(inputPath, { fallback = 30 } = {}) {
  const { spawnSync } = require("child_process");
  const r = spawnSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=avg_frame_rate,nb_frames,duration",
    "-of", "default=noprint_wrappers=1", inputPath,
  ]);
  if (r.status !== 0) return fallback;
  const fields = Object.fromEntries(
    r.stdout.toString().trim().split("\n").map((line) => {
      const eq = line.indexOf("=");
      return eq < 0 ? [line, ""] : [line.slice(0, eq), line.slice(eq + 1)];
    }),
  );
  const nbf = Number(fields.nb_frames);
  const dur = Number(fields.duration);
  if (nbf > 0 && dur > 0) return Math.round((nbf / dur) * 1000) / 1000;
  if (fields.avg_frame_rate) {
    const [n, d] = fields.avg_frame_rate.split("/").map(Number);
    if (Number.isFinite(n) && Number.isFinite(d) && d > 0) {
      const f = n / d;
      if (f > 0 && f < 240) return Math.round(f * 1000) / 1000;
    }
  }
  return fallback;
}

function srcSecondsToDst(srcSec, warp) {
  if (!warp || !Array.isArray(warp.segments) || warp.segments.length === 0) {
    return srcSec; // identity for malformed/empty warps
  }
  // 1 µs of slack absorbs float-rounding at segment boundaries so a value
  // exactly at the edge doesn't fall through to the default branch below.
  const EPS = 1e-6;
  for (const seg of warp.segments) {
    if (srcSec >= seg.srcStart - EPS && srcSec <= seg.srcEnd + EPS) {
      const dur = seg.srcEnd - seg.srcStart;
      const u = dur > 0 ? (srcSec - seg.srcStart) / dur : 0;
      return seg.dstStart + u * (seg.dstEnd - seg.dstStart);
    }
  }
  return warp.segments[warp.segments.length - 1].dstEnd;
}

module.exports = {
  SUPPORTED_SCHEMA_VERSION,
  DEFAULT_TAIL_PAD_MS,
  loadEditorContext,
  eventEnd,
  propagateSidecars,
  probeFps,
  srcSecondsToDst,
  applyDelays,
  defaultMobileZoomCenter,
  validatePan,
  panPathExpressions,
  easeExpr,
};
