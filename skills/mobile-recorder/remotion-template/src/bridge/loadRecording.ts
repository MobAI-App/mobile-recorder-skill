// The bridge: turn the mobile-recorder contract (timeline.json + optional
// editor.json) into Remotion-ready, frame-indexed props. Runs in
// `calculateMetadata` (Node at render, browser in Studio), so it reads via
// fetch(staticFile(...)) - put timeline.json + editor.json in public/.
//
// Coordinate space: tap/swipe x/y are recording source-pixel coords (e.g.
// 1206x2622 for iPhone 17 Pro at 3x). The same space the rec.mp4 lives in,
// so <Cursor>/<TapRipple>/<SwipePath> placed inside <RecordingStage> line
// up with the footage regardless of how the creative composition scales
// or positions the stage.

import {staticFile} from 'remotion';

export type RecTap = {kind: 'tap'; frame: number; x: number; y: number; durationFrames: number; line?: number};
export type RecSwipe = {
  kind: 'swipe';
  frame: number;
  x: number; y: number; x2: number; y2: number;
  durationFrames: number; line?: number;
};
export type RecEvent = RecTap | RecSwipe;
export type RecCaption = {
  text: string;
  startFrame: number;
  endFrame: number;
  x?: number;          // optional CENTER override in output-canvas px (per-caption)
  y?: number;
  anchorX?: number;    // stage source-pixel x of the captioned tap/swipe, if any
  anchorY?: number;    // stage source-pixel y - lets the Caption animate from
                       // the action point down to the bottom strip
};

export type Recording = {
  fps: number;
  durationInFrames: number;
  speed: number;            // playback speedup; events + duration are already scaled
  stageWidth: number;       // recording source-pixel width (e.g. 1206)
  stageHeight: number;      // (e.g. 2622)
  videoSrc: string;
  events: RecEvent[];
  captions: RecCaption[];
  recordStartOffsetMs: number;
};

type TimelineEvent = {
  timeMs: number;
  line?: number;
  type: 'record_start' | 'record_stop' | 'tap' | 'swipe' | 'wait' | 'screenshot' | 'press_key' | 'navigate';
  x?: number; y?: number;
  x2?: number; y2?: number;
  durationMs?: number;
  intent?: string;
  caption?: string;
  reason?: 'technical' | 'viewer_readability';
  recordStartOffsetMs?: number;
};

async function getJSON<T = any>(file: string): Promise<T | null> {
  try {
    const res = await fetch(staticFile(file));
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function loadRecording(
  fps = 30,
  opts: {speed?: number; videoFile?: string; recordingSize?: [number, number]} = {},
): Promise<Recording> {
  const speed = opts.speed ?? 1;
  const videoFile = opts.videoFile ?? 'rec.mp4';
  const timeline = (await getJSON<TimelineEvent[]>('timeline.json')) ?? [];
  const editor = (await getJSON<any>('editor.json')) ?? null;

  if (timeline.length === 0) {
    throw new Error('public/timeline.json missing or empty');
  }

  const recordStart = timeline.find((e) => e.type === 'record_start');
  const recordStop = timeline.find((e) => e.type === 'record_stop');
  const recordStartOffsetMs = recordStart?.recordStartOffsetMs ?? 0;
  const recordEndMs = recordStop?.timeMs ?? timeline[timeline.length - 1]?.timeMs ?? 0;

  // Trim window: editor.trim.fromLine/toLine if present, else full recording.
  // Choreography-ms space. startDelayMs / endDelayMs honored.
  let trimStartMs = 0;
  let trimEndMs = recordEndMs;
  const lineToTimeMs = new Map<number, number>();
  const lineToEndMs = new Map<number, number>();
  const lineToAnchorXY = new Map<number, {x: number; y: number}>();
  for (const e of timeline) {
    if (e.line != null) {
      lineToTimeMs.set(e.line, e.timeMs);
      const dur = (e.type === 'wait' || e.type === 'swipe') ? (e.durationMs ?? 0) : 0;
      lineToEndMs.set(e.line, e.timeMs + dur);
      // Tap and swipe events carry a point. For swipes, the anchor is the
      // start point (where the gesture begins) - that's where the caption
      // visually "fires from" before the finger animates to the endpoint.
      if ((e.type === 'tap' || e.type === 'swipe') && Number.isFinite(e.x) && Number.isFinite(e.y)) {
        lineToAnchorXY.set(e.line, {x: e.x!, y: e.y!});
      }
    }
  }
  if (editor?.trim) {
    const t = editor.trim;
    if (t.fromLine != null && lineToTimeMs.has(t.fromLine)) {
      trimStartMs = lineToTimeMs.get(t.fromLine)! + (t.startDelayMs ?? 0);
    }
    if (t.toLine != null && lineToEndMs.has(t.toLine)) {
      trimEndMs = lineToEndMs.get(t.toLine)! + (t.endDelayMs ?? 0);
    }
  }

  // Compose two scale factors:
  //   1. ms-after-trim-head → frames (choreography time, post-trim).
  //   2. apply `speed` to compress/expand.
  // The video itself (rec.mp4) is the raw recording aligned to choreography
  // via recordStartOffsetMs; if the user pre-trimmed rec.mp4 to match
  // editor.trim, the head trim is already gone.
  const toFrame = (msAfterTrimHead: number) =>
    Math.max(0, Math.round((msAfterTrimHead / 1000) * fps / speed));

  const durationInFrames = Math.max(1, toFrame(trimEndMs - trimStartMs));

  // Action events → tap / swipe with frame offsets relative to the trim head.
  const events: RecEvent[] = [];
  const actionStartFrame = new Map<number, number>();
  for (const e of timeline) {
    if (e.timeMs < trimStartMs || e.timeMs > trimEndMs) continue;
    const startFrame = toFrame(e.timeMs - trimStartMs);
    const durFrames = Math.max(1, toFrame(e.durationMs ?? 0) || 1);
    if (e.line != null) actionStartFrame.set(e.line, startFrame);
    if (e.type === 'tap' && Number.isFinite(e.x) && Number.isFinite(e.y)) {
      events.push({kind: 'tap', frame: startFrame, x: e.x!, y: e.y!, durationFrames: durFrames, line: e.line});
    } else if (e.type === 'swipe' && Number.isFinite(e.x2) && Number.isFinite(e.y2)) {
      events.push({
        kind: 'swipe', frame: startFrame,
        x: e.x!, y: e.y!, x2: e.x2!, y2: e.y2!,
        durationFrames: durFrames, line: e.line,
      });
    }
  }
  events.sort((a, b) => a.frame - b.frame);

  // Captions. Preferred source: editor.captions[]. Each entry takes either
  // `toLine` (+ optional endDelayMs) OR `durationMs`. Falls back to .mob
  // # Caption: comments on timeline events when the array is absent.
  const captions: RecCaption[] = [];
  if (editor && Array.isArray(editor.captions) && editor.captions.length > 0) {
    for (const c of editor.captions) {
      const fromLine = c.fromLine ?? c.line;
      if (fromLine == null) continue;
      const startMsChoreo = (lineToTimeMs.get(fromLine) ?? 0) + (c.startDelayMs ?? 0);
      let endMsChoreo: number | null = null;
      if (c.toLine != null && lineToTimeMs.has(c.toLine)) {
        endMsChoreo = lineToTimeMs.get(c.toLine)! + (c.endDelayMs ?? 0);
      } else if (Number.isFinite(c.durationMs)) {
        endMsChoreo = startMsChoreo + Number(c.durationMs);
      }
      if (endMsChoreo == null || endMsChoreo <= startMsChoreo) continue;
      const startFrame = toFrame(startMsChoreo - trimStartMs);
      const endFrame = toFrame(endMsChoreo - trimStartMs);
      const anchor = lineToAnchorXY.get(fromLine);
      captions.push({
        text: c.text, startFrame, endFrame,
        x: Number.isFinite(c.x) ? Number(c.x) : undefined,
        y: Number.isFinite(c.y) ? Number(c.y) : undefined,
        anchorX: anchor?.x,
        anchorY: anchor?.y,
      });
    }
  } else {
    // Legacy: .mob `# Caption:` comments on action lines. Each captioned
    // action shows from its frame until the next captioned action.
    const captioned = timeline.filter((e) => e.caption);
    captioned.forEach((e, i) => {
      const startMs = e.timeMs;
      const endMs = captioned[i + 1]?.timeMs ?? recordEndMs;
      if (startMs < trimStartMs || startMs > trimEndMs) return;
      const anchor = (e.type === 'tap' || e.type === 'swipe') && Number.isFinite(e.x) && Number.isFinite(e.y)
        ? {x: e.x!, y: e.y!}
        : null;
      captions.push({
        text: e.caption!,
        startFrame: toFrame(startMs - trimStartMs),
        endFrame: toFrame(Math.min(endMs, trimEndMs) - trimStartMs),
        anchorX: anchor?.x,
        anchorY: anchor?.y,
      });
    });
  }

  // Stage dims: prefer caller-supplied recordingSize. Otherwise use the
  // common iPhone 17 Pro source-pixel default - the Demo can override.
  const [stageWidth, stageHeight] = opts.recordingSize ?? [1206, 2622];

  return {
    fps,
    durationInFrames,
    speed,
    stageWidth,
    stageHeight,
    videoSrc: staticFile(videoFile),
    events,
    captions,
    recordStartOffsetMs,
  };
}

// Walking-cursor position at a frame. Mirrors add_highlights.js's slide-in
// model: for tap N, the cursor fades in at tap N-1's target, slides over
// APPROACH frames into tap N, holds, fades out. First tap is a pulse-style
// fade-in at the target. Swipes follow (x,y)→(x2,y2) linearly across their
// durationFrames; the next slide-in starts from (x2,y2).
//
// Returns null when the cursor is invisible at this frame.
export type CursorPose = {x: number; y: number; alpha: number};

const DEFAULT_PRE_PULSE = 4;     // first-tap fade-in in frames
const DEFAULT_APPROACH  = 14;    // slide-in from prev target
const DEFAULT_HOLD      = 9;     // visible past touch-down
const DEFAULT_FADE_OUT  = 8;     // fade-out

export function cursorAt(
  events: RecEvent[],
  frame: number,
  opts: {prePulseFrames?: number; approachFrames?: number; holdFrames?: number; fadeOutFrames?: number} = {},
): CursorPose | null {
  const PRE = opts.prePulseFrames ?? DEFAULT_PRE_PULSE;
  const APPROACH = opts.approachFrames ?? DEFAULT_APPROACH;
  const HOLD = opts.holdFrames ?? DEFAULT_HOLD;
  const FADE = opts.fadeOutFrames ?? DEFAULT_FADE_OUT;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const prev = i > 0 ? events[i - 1] : null;
    const prevRest = prev
      ? (prev.kind === 'swipe' ? {x: prev.x2, y: prev.y2} : {x: prev.x, y: prev.y})
      : null;
    const approachStart = prevRest ? e.frame - APPROACH : e.frame - PRE;
    const fadeInDur = prevRest ? Math.max(2, Math.round(APPROACH * 0.4)) : PRE;
    const restEnd = e.kind === 'swipe' ? e.frame + e.durationFrames : e.frame;
    const fadeOutSt = restEnd + HOLD;
    const enableEnd = fadeOutSt + FADE;

    if (frame < approachStart) continue;
    if (frame >= enableEnd) continue;

    // Position
    let x: number, y: number;
    if (prevRest && frame < e.frame) {
      const u = clip01((frame - approachStart) / Math.max(1, e.frame - approachStart));
      x = prevRest.x + (e.x - prevRest.x) * u;
      y = prevRest.y + (e.y - prevRest.y) * u;
    } else if (e.kind === 'swipe' && frame >= e.frame && frame < e.frame + e.durationFrames) {
      const u = clip01((frame - e.frame) / Math.max(1, e.durationFrames));
      x = e.x + (e.x2 - e.x) * u;
      y = e.y + (e.y2 - e.y) * u;
    } else {
      const rest = e.kind === 'swipe' ? {x: e.x2, y: e.y2} : {x: e.x, y: e.y};
      x = rest.x; y = rest.y;
    }

    // Alpha
    let alpha = 1;
    if (frame < approachStart + fadeInDur) {
      alpha = (frame - approachStart) / fadeInDur;
    } else if (frame >= fadeOutSt) {
      alpha = 1 - (frame - fadeOutSt) / FADE;
    }
    return {x, y, alpha: clip01(alpha)};
  }
  return null;
}

function clip01(u: number): number {
  return Math.max(0, Math.min(1, u));
}
