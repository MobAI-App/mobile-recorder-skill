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

  // Choreography-time events in order, excluding the boundary markers.
  const actions = timeline.filter(
    (e) => e.type !== "record_start" && e.type !== "record_stop",
  );

  const eventByLine = new Map();
  for (const e of actions) {
    if (!Number.isInteger(e.line)) continue;
    if (eventByLine.has(e.line)) {
      // Two events on the same source line — should never happen given the
      // .mob parser emits one event per action line, but if it does the
      // last-write-wins behavior would silently shadow the first one.
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
   * toLine fires" — i.e. tStart = fromLine.timeMs, tEnd = toLine.timeMs.
   * Used by zoom directives that hold a peak across multiple actions.
   */
  function resolveLineRange({ fromLine, toLine }) {
    if (fromLine == null || toLine == null) {
      fatal(`resolveLineRange: both fromLine and toLine are required`);
    }
    const fromEvent = findEvent(fromLine);
    const toEvent   = findEvent(toLine);
    if (toEvent.timeMs <= fromEvent.timeMs) {
      fatal(`resolveLineRange: toLine ${toLine} (t=${toEvent.timeMs}) must come after fromLine ${fromLine} (t=${fromEvent.timeMs})`);
    }
    return {
      tStart: fromEvent.timeMs,
      tEnd:   toEvent.timeMs,
      fromEvent,
      toEvent,
    };
  }

  function resolveSpan({ line, side }) {
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
    return { tStart, tEnd, event: e };
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

    // Auto-extend the trim head to include any zoom ramp-in that begins
    // BEFORE the first kept action. Without this, a `fromLine/toLine` zoom
    // whose ramp-in lands in the trimmed-off region would be invisible —
    // the viewer would just see the final video start already-zoomed.
    // Negative choreography ms is fine: the raw mp4 has frames during the
    // setup section (before the record_start checkpoint), so the trim can
    // reach into that region. Real lower bound is -recordStartOffsetMs.
    const minTStart = -recordStartOffsetMs;
    for (const d of editor.directives) {
      if (d.kind !== "zoom" || d.fromLine == null) continue;
      const rampMs = Math.max(0, Number.isFinite(d.rampMs) ? d.rampMs : 200);
      const fromEvent = findEvent(d.fromLine);
      const rampInStart = fromEvent.timeMs - rampMs;
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
 * the output rate matches the input rate — no silent upsample/duplication.
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
};
