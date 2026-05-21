#!/usr/bin/env node
/**
 * Build or validate demo timeline metadata.
 *
 * Usage:
 *   node build_timeline.js <demo.mob> <test_run.json> <timeline.json> [options]
 *   node build_timeline.js --validate <timeline.json>
 *
 * Options:
 *   --scale n                  device scale factor (default 1)
 *   --recording-duration-ms n  override the record_stop timeMs
 *   --warmup-ms n              raw-video ms elapsed before the .mob starts
 *                              (recorder wrapper warm-up); folded into
 *                              recordStartOffsetMs
 *   --recording <path>         path to the raw mp4. The builder auto-reads
 *                              <path>.warmup_ms (written by the recorder
 *                              wrappers) and uses its contents as --warmup-ms
 *
 * The builder is intentionally conservative. It reads the .mob source as the
 * source of truth for action order and metadata comments, and uses test_run
 * step durations when the runner output exposes them.
 */

const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);

function usage() {
  console.error("usage: node build_timeline.js <demo.mob> <test_run.json> <timeline.json>");
  console.error("         [--scale n] [--recording-duration-ms n] [--warmup-ms n] [--recording <path>]");
  console.error("       node build_timeline.js --validate <timeline.json>");
  process.exit(2);
}

function readFlag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}

function parseNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`invalid ${name}: ${value}`);
  }
  return n;
}

// Recognize MobAI per-step records. We require `lineText` (the raw .mob
// source text for the action) — that field only appears on leaf step
// records, never on aggregate parent objects that might also carry total
// `durationMs` / `elapsedMs` fields. Without this stricter check a parent
// object's aggregate duration could be pushed into the sequential fallback
// and shift the whole timeline.
//
// Once an object matches the step shape we treat it as a leaf and do NOT
// recurse into its children. The recursion is only there to find the
// step-array inside whatever wrapper MobAI may return.
function isStepRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.lineText !== "string" || value.lineText.length === 0) return false;
  return (
    value.lineNumber != null ||
    value.line != null ||
    value.sourceLine != null ||
    value.durationMs != null ||
    value.duration_ms != null ||
    value.elapsedMs != null ||
    value.elapsed_ms != null ||
    value.startedAtMs != null ||
    value.startedAt != null ||
    value.startMs != null ||
    value.start_ms != null
  );
}

function collectStepObjects(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value) collectStepObjects(item, out);
    return out;
  }
  if (isStepRecord(value)) {
    out.push(value);
    return out; // step records are leaves — don't recurse into their children
  }
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === "object") collectStepObjects(nested, out);
  }
  return out;
}

function durationFromStep(step) {
  const raw = step.durationMs ?? step.duration_ms ?? step.elapsedMs ?? step.elapsed_ms ?? step.duration;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

function lineFromStep(step) {
  const raw = step.lineNumber ?? step.line ?? step.sourceLine;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Wall-clock unix timestamp (ms) at which the step started. Optional — MobAI
// may or may not emit it. When present on every step (including the
// `record_start` checkpoint), the builder anchors timeMs directly off that
// checkpoint's timestamp via subtraction, instead of accumulating durations.
// The subtraction makes choreography time wall-clock-independent: only the
// SHARED clock between record_start and each action matters, not the epoch.
function startFromStep(step) {
  const raw = step.startedAtMs ?? step.startedAt ?? step.startMs ?? step.start_ms;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function buildStepTiming(testRunPath) {
  if (!testRunPath || testRunPath === "-") {
    return { byLine: new Map(), sequential: [] };
  }

  const parsed = JSON.parse(fs.readFileSync(testRunPath, "utf8"));
  const steps = collectStepObjects(parsed)
    .map((step) => ({
      line: lineFromStep(step),
      durationMs: durationFromStep(step),
      startedAtMs: startFromStep(step),
    }))
    .filter((step) => step.durationMs != null || step.startedAtMs != null);

  const byLine = new Map();
  for (const step of steps) {
    if (step.line != null && !byLine.has(step.line)) {
      byLine.set(step.line, { durationMs: step.durationMs, startedAtMs: step.startedAtMs });
    }
  }

  return {
    byLine,
    sequential: steps.map((step) => step.durationMs).filter((d) => d != null),
  };
}

function parseReason(comment) {
  const match = comment.match(/^#\s*Reason:\s*(technical|viewer_readability)\b/i);
  return match ? match[1].toLowerCase() : null;
}

function metadataWithoutReason(metadata) {
  // wait events get `reason` explicitly; strip it from the spread so it doesn't double-emit.
  const { reason, ...rest } = metadata;
  return rest;
}

function parseMob(mobPath) {
  const lines = fs.readFileSync(mobPath, "utf8").split(/\r?\n/);
  const actions = [];
  let pending = {};

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const raw = lines[i];
    const trimmed = raw.trim();

    if (!trimmed) continue;

    if (trimmed.startsWith("#")) {
      const intent = trimmed.match(/^#\s*Intent:\s*(.+)$/i);
      const caption = trimmed.match(/^#\s*Caption:\s*(.+)$/i);
      const reason = parseReason(trimmed);
      if (intent) pending.intent = intent[1].trim();
      if (caption) pending.caption = caption[1].trim();
      if (reason) pending.reason = reason;
      continue;
    }

    const actionText = trimmed.replace(/\s+#.*$/, "").trim();
    const action = parseAction(actionText, lineNumber, pending);
    pending = {};
    if (action) actions.push(action);
  }

  return actions;
}

function parseAction(text, lineNumber, metadata) {
  let m = text.match(/^checkpoint\s+"([^"]+)"$/i);
  if (m) return { kind: "checkpoint", name: m[1], lineNumber, text };

  m = text.match(/^tap\s+(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/i);
  if (m) {
    return {
      kind: "tap",
      lineNumber,
      text,
      x: Number(m[1]),
      y: Number(m[2]),
      metadata: { ...metadata },
    };
  }

  m = text.match(/^swipe\s+(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\s+to\s+(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/i);
  if (m) {
    return {
      kind: "swipe",
      lineNumber,
      text,
      x: Number(m[1]),
      y: Number(m[2]),
      x2: Number(m[3]),
      y2: Number(m[4]),
      metadata: { ...metadata },
    };
  }

  m = text.match(/^delay\s+(\d+)$/i);
  if (m) {
    return {
      kind: "wait",
      lineNumber,
      text,
      durationMs: Number(m[1]),
      metadata: { ...metadata },
    };
  }

  m = text.match(/^screenshot\s+"([^"]+)"$/i);
  if (m) return { kind: "screenshot", lineNumber, text, path: m[1], metadata: { ...metadata } };

  m = text.match(/^press_key\s+(\w+)$/i);
  if (m) return { kind: "press_key", lineNumber, text, key: m[1].toLowerCase(), metadata: { ...metadata } };

  m = text.match(/^navigate\s+(\w+)$/i);
  if (m) return { kind: "navigate", lineNumber, text, target: m[1].toLowerCase(), metadata: { ...metadata } };

  m = text.match(/^(app|kill_app)\b/i);
  if (m) return { kind: "setup", lineNumber, text };

  return { kind: "unsupported", lineNumber, text, metadata: { ...metadata } };
}

function buildTimeline(mobPath, testRunPath, outPath, options) {
  const actions = parseMob(mobPath);
  const timing = buildStepTiming(testRunPath);
  const useSequentialTiming = timing.byLine.size === 0;
  let seqIndex = 0;
  let inRecording = false;
  let currentMs = 0;
  const events = [];
  const warnings = [];

  // If test_run includes wall-clock `startedAtMs` per step, anchor
  // choreography time off the record_start checkpoint's timestamp. Otherwise
  // fall back to cumulative duration math.
  const recordStartLine = actions.find(
    (a) => a.kind === "checkpoint" && a.name === "record_start",
  )?.lineNumber;
  const recordStartStep = recordStartLine != null ? timing.byLine.get(recordStartLine) : null;
  const recordStartTs = recordStartStep?.startedAtMs ?? null;

  // Time elapsed in the recording before checkpoint "record_start" fires.
  //
  // Preferred (and most reliable) source: the recorder's `.start_ts` file
  // — a wall-clock epoch captured the moment ffmpeg started — combined
  // with `record_start.startedAtMs` from MobAI. The difference is the
  // exact recording-time of the checkpoint, independent of any idle gap
  // between recorder start and test_run kickoff.
  //
  // Fallback (legacy): sum of warmupMs + pre-recording step durations.
  // Only accurate when test_run starts immediately after the recorder
  // returns — historically true for simctl, less so once we added live
  // MobAI MJPEG with manual orchestration.
  let recordStartOffsetMs = options.warmupMs || 0;
  if (options.recorderStartTs != null && recordStartTs != null) {
    recordStartOffsetMs = Math.max(0, Math.round(recordStartTs - options.recorderStartTs * 1000));
  }

  function actionDuration(action, fallback) {
    const step = timing.byLine.get(action.lineNumber);
    if (step && Number.isFinite(step.durationMs)) return step.durationMs;
    if (useSequentialTiming && seqIndex < timing.sequential.length) return timing.sequential[seqIndex++];
    return fallback;
  }

  function actionTimeMs(action) {
    if (recordStartTs == null) return null;
    const step = timing.byLine.get(action.lineNumber);
    if (!step || step.startedAtMs == null) return null;
    return Math.max(0, step.startedAtMs - recordStartTs);
  }

  for (const action of actions) {
    const defaultDuration =
      action.kind === "wait" ? action.durationMs :
      action.kind === "swipe" ? 320 :
      action.kind === "setup" ? 1500 :
      0;
    const stepDuration = actionDuration(action, defaultDuration);

    if (action.kind === "checkpoint" && action.name === "record_start") {
      if (inRecording) {
        throw new Error(`line ${action.lineNumber}: duplicate checkpoint "record_start"`);
      }
      inRecording = true;
      // When recorder-start timestamp + test_run anchors are available,
      // recordStartOffsetMs was already computed up top. Only fall back to
      // the legacy "warmup + setup durations" sum if we couldn't.
      if (options.recorderStartTs == null || recordStartTs == null) {
        recordStartOffsetMs = (options.warmupMs || 0) + currentMs;
      }
      currentMs = 0;
      events.push({ timeMs: 0, type: "record_start", line: action.lineNumber, recordStartOffsetMs });
      continue;
    }

    if (action.kind === "checkpoint" && action.name === "record_stop") {
      events.push({ timeMs: currentMs, type: "record_stop", line: action.lineNumber });
      inRecording = false;
      continue;
    }

    if (!inRecording) {
      // Accumulate pre-recording duration so recordStartOffsetMs is accurate.
      currentMs += stepDuration;
      continue;
    }

    const metadata = action.metadata || {};
    const anchoredMs = actionTimeMs(action);
    const timeMs = anchoredMs != null ? anchoredMs : currentMs;

    if (action.kind === "tap") {
      // durationMs reflects MobAI's full action time (touch-down → touch-up
      // + any post-tap settle). The downstream highlight pass fires the
      // ripple at timeMs + durationMs — when the iOS visual response lands
      // — rather than at startedAtMs which is just when MobAI initiated
      // the gesture.
      events.push({
        timeMs,
        type: "tap",
        line: action.lineNumber,
        x: Math.round(action.x * options.scale),
        y: Math.round(action.y * options.scale),
        durationMs: stepDuration,
        ...metadata,
      });
    } else if (action.kind === "swipe") {
      events.push({
        timeMs,
        type: "swipe",
        line: action.lineNumber,
        x: Math.round(action.x * options.scale),
        y: Math.round(action.y * options.scale),
        x2: Math.round(action.x2 * options.scale),
        y2: Math.round(action.y2 * options.scale),
        durationMs: stepDuration || 320,
        ...metadata,
      });
    } else if (action.kind === "wait") {
      if (!metadata.reason && action.durationMs > 100) {
        warnings.push(`line ${action.lineNumber}: delay has no # Reason; defaulting to technical`);
      }
      events.push({
        timeMs,
        type: "wait",
        line: action.lineNumber,
        durationMs: action.durationMs,
        reason: metadata.reason || "technical",
        ...metadataWithoutReason(metadata),
      });
    } else if (action.kind === "screenshot") {
      events.push({
        timeMs,
        type: "screenshot",
        line: action.lineNumber,
        path: action.path,
        ...metadata,
      });
    } else if (action.kind === "press_key") {
      events.push({
        timeMs,
        type: "press_key",
        line: action.lineNumber,
        key: action.key,
        ...metadata,
      });
    } else if (action.kind === "navigate") {
      events.push({
        timeMs,
        type: "navigate",
        line: action.lineNumber,
        target: action.target,
        ...metadata,
      });
    } else if (action.kind === "unsupported") {
      throw new Error(`unsupported action inside recording at line ${action.lineNumber}: ${action.text}`);
    }

    if (anchoredMs != null) {
      // Anchored: keep currentMs in sync with the last observed timestamp so
      // any subsequent un-anchored steps (or the synthetic record_stop)
      // fall in the right place.
      currentMs = anchoredMs + stepDuration;
    } else {
      currentMs += stepDuration;
    }
  }

  if (events.length === 0 || events[0].type !== "record_start") {
    events.unshift({ timeMs: 0, type: "record_start", recordStartOffsetMs: 0 });
  }

  if (events[events.length - 1].type !== "record_stop") {
    const stopMs = options.recordingDurationMs ?? maxEventEnd(events);
    events.push({ timeMs: stopMs, type: "record_stop" });
  }

  const validation = validateTimeline(events);
  if (validation.errors.length > 0) {
    throw new Error(`invalid timeline:\n${validation.errors.map((e) => `  - ${e}`).join("\n")}`);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(events, null, 2) + "\n");

  for (const warning of warnings.concat(validation.warnings)) {
    console.warn(`warning: ${warning}`);
  }
  console.log(`Timeline -> ${outPath} (${events.length} events, scale ${options.scale})`);
}

function maxEventEnd(events) {
  return events.reduce((max, event) => {
    const duration = event.type === "wait" || event.type === "swipe" || event.type === "scroll"
      ? event.durationMs || 0
      : 0;
    return Math.max(max, event.timeMs + duration);
  }, 0);
}

function validateTimeline(events) {
  const errors = [];
  const warnings = [];

  if (!Array.isArray(events)) {
    return { errors: ["timeline root must be an array"], warnings };
  }

  const starts = events.filter((e) => e.type === "record_start");
  const stops = events.filter((e) => e.type === "record_stop");
  if (starts.length !== 1) errors.push(`expected exactly one record_start, found ${starts.length}`);
  if (stops.length !== 1) errors.push(`expected exactly one record_stop, found ${stops.length}`);

  let previous = -Infinity;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const label = `event ${i}`;

    if (!Number.isFinite(event.timeMs)) errors.push(`${label}: timeMs must be a finite number`);
    if (event.timeMs < previous) errors.push(`${label}: timeMs must be non-decreasing`);
    previous = event.timeMs;

    if ((event.type === "tap" || event.type === "click") && (!Number.isFinite(event.x) || !Number.isFinite(event.y))) {
      errors.push(`${label}: ${event.type} requires x and y`);
    }
    if (event.type === "swipe" && (!Number.isFinite(event.x) || !Number.isFinite(event.y) || !Number.isFinite(event.x2) || !Number.isFinite(event.y2))) {
      errors.push(`${label}: swipe requires x, y, x2, and y2`);
    }
    if (event.type === "swipe" && !Number.isFinite(event.durationMs)) {
      errors.push(`${label}: swipe requires durationMs`);
    }
    if (event.type === "wait") {
      if (!Number.isFinite(event.durationMs)) errors.push(`${label}: wait requires durationMs`);
      if (event.reason !== "technical" && event.reason !== "viewer_readability") {
        errors.push(`${label}: wait reason must be technical or viewer_readability`);
      }
    }
  }

  if (events[0]?.type !== "record_start" || events[0]?.timeMs !== 0) {
    errors.push("first event must be { timeMs: 0, type: \"record_start\" }");
  }

  if (events[0]?.type === "record_start" && events[0].recordStartOffsetMs != null && !Number.isFinite(events[0].recordStartOffsetMs)) {
    errors.push("event 0: recordStartOffsetMs must be a finite number when present");
  }

  const stop = stops[0];
  if (stop && stop.timeMs < maxEventEnd(events.filter((e) => e.type !== "record_stop"))) {
    warnings.push("record_stop is earlier than the latest event end; exporters will preserve the latest event end");
  }

  return { errors, warnings };
}

try {
  if (argv[0] === "--validate") {
    if (argv.length < 2) usage();
    const timeline = JSON.parse(fs.readFileSync(argv[1], "utf8"));
    const result = validateTimeline(timeline);
    for (const warning of result.warnings) console.warn(`warning: ${warning}`);
    if (result.errors.length > 0) {
      console.error(result.errors.map((e) => `error: ${e}`).join("\n"));
      process.exit(1);
    }
    console.log(`Timeline valid -> ${argv[1]}`);
    process.exit(0);
  }

  if (argv.length < 3) usage();

  let warmupMs = 0;
  let recorderStartTs = null;
  if (argv.includes("--warmup-ms")) {
    warmupMs = parseNumber(readFlag("--warmup-ms"), "--warmup-ms");
  } else if (argv.includes("--recording")) {
    const recordingPath = readFlag("--recording");
    const warmupSidecar = `${recordingPath}.warmup_ms`;
    if (fs.existsSync(warmupSidecar)) {
      warmupMs = parseNumber(fs.readFileSync(warmupSidecar, "utf8").trim(), "--recording sidecar");
    } else {
      console.warn(`warning: no warmup sidecar at ${warmupSidecar}; assuming 0 ms`);
    }
    // Newer recorder also writes .start_ts (wall-clock epoch in seconds).
    // Combined with MobAI's record_start.startedAtMs it gives the exact
    // recording-time of the checkpoint — robust against the idle gap
    // between recorder start and test_run kickoff.
    const startTsSidecar = `${recordingPath}.start_ts`;
    if (fs.existsSync(startTsSidecar)) {
      recorderStartTs = parseNumber(fs.readFileSync(startTsSidecar, "utf8").trim(), "--recording start_ts");
    }
  }

  buildTimeline(argv[0], argv[1], argv[2], {
    scale: parseNumber(readFlag("--scale", "1"), "--scale"),
    recordingDurationMs: argv.includes("--recording-duration-ms")
      ? parseNumber(readFlag("--recording-duration-ms"), "--recording-duration-ms")
      : null,
    warmupMs,
    recorderStartTs,
  });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
