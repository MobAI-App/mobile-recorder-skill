# Timeline metadata (mobile)

Every action the `.mob` runs during `checkpoint "record_start" → checkpoint "record_stop"` becomes one `DemoTimelineEvent` in the timeline. The export pipeline reads these events to drive captions, highlights, and (eventually) speed-up of technical waits.

## Schema

```ts
type DemoTimelineEvent = {
  timeMs: number                  // ms since record_start checkpoint
  line: number                    // .mob source line of the action that
                                  // produced this event. editor.json
                                  // directives anchor here.
  type:
    | "record_start"
    | "record_stop"
    | "tap"                       // coordinate tap
    | "swipe"                     // coordinate swipe
    | "wait"                      // delay
    | "screenshot"                // screenshot "path" — captures current frame
    | "press_key"                 // press_key home|back|enter
    | "navigate"                  // navigate home

  intent?: string                 // from "# Intent: ..." comment
  caption?: string                // from "# Caption: ..." comment

  x?: number                      // tap coordinates (source-pixel space)
  y?: number
  x2?: number                     // swipe endpoint
  y2?: number

  durationMs?: number             // wait, swipe, AND tap duration. For taps
                                  // this is MobAI's full action time
                                  // (touch-down → touch-up + settle); useful
                                  // for editor.json zoom on a tap line.
  reason?: "technical" | "viewer_readability"   // from "# Reason: ..." comment

  path?: string                   // screenshot output path
  key?: string                    // press_key argument (home|back|enter)
  target?: string                 // navigate target (home)

  // Only on the leading `record_start` event:
  recordStartOffsetMs?: number    // ms between the recorder starting and the
                                  // `checkpoint "record_start"` line firing.
                                  // The exporter adds this to choreography
                                  // time when trimming the raw recording.
}
```

## How the agent builds `timeline.json`

Use the helper script whenever possible:

```bash
node scripts/build_timeline.js demo.mob test_run.json timeline.json --scale 3
node scripts/build_timeline.js --validate timeline.json
```

Pass the device scale factor with `--scale` so logical `.mob` coordinates become source-pixel coordinates for the recording. For example, iPhone logical coordinates captured at 402x874 need `--scale 3` when the recording is 1206x2622.

`.mob` files have no per-step event hook, and recording is started outside the script. The helper builds `timeline.json` by post-processing the `.mob` source and `test_run` result:

1. The recorder is started before the `.mob` runs, so the setup section (app launch, initial delays) runs *inside* the recording window. `recordStartOffsetMs` on the `record_start` event encodes that gap so the exporter can trim past it. Two ways the builder computes it:
   - **Preferred** (when `--recording` is passed): reads the recorder's `<out>.start_ts` sidecar (wall-clock epoch written by the recorder script) and subtracts it from `record_start`'s `startedAtMs`. Works regardless of how long the agent waited between starting the recorder and invoking `test_run`.
   - **Fallback**: warmup_ms + sum of pre-record_start step durations. Only accurate when `test_run` fires immediately after the recorder returns.
2. Run the `.mob` via `test_run`. Expected per-step entries: `lineNumber`, `lineText`, `durationMs`, and (optionally) `startedAtMs` — a **wall-clock unix timestamp in milliseconds** at which the step started (i.e. the actual clock-time, not "ms since the run started"). When `startedAtMs` is present on every step *including* the `record_start` checkpoint, `build_timeline.js` anchors choreography time by subtracting the checkpoint's `startedAtMs` from each action's `startedAtMs`; the absolute epoch never matters, only that record_start and every action share a clock. When `startedAtMs` is missing, the builder falls back to cumulative duration math (less precise but still correct on average).
3. For each step, look at the `.mob` source for the comment lines immediately preceding that step's action line:
   - `# Intent: ...` → `intent`
   - `# Caption: ...` → `caption`
   - `# Reason: technical|viewer_readability` → `reason` (only meaningful for `delay` steps)
4. Compute `timeMs` from `startedAtMs - recordStartTs` when available, else cumulatively. Each event also gets `line: action.lineNumber` so `editor.json` directives can join back to the source.
5. Emit one `DemoTimelineEvent` per step. Insert a synthetic `{ timeMs: 0, type: "record_start", recordStartOffsetMs }` at the head and a `{ timeMs: <elapsed_recording_choreography_ms>, type: "record_stop" }` at the tail.
6. Recognize the `checkpoint "record_start"` and `checkpoint "record_stop"` lines as boundaries: **skip every step before `record_start` and after `record_stop`** when emitting events. Setup-section actions are not in the timeline (their durations are folded into `recordStartOffsetMs` instead).

### Coordinate space

`.mob` coordinates are in device **logical points** (e.g. iPhone 16 Pro is 402×874). The MJPEG / simctl recorder captures at native **pixels** (1206×2622 for iPhone 16 Pro — 3× scale). The timeline must store coordinates in the **recording's source-pixel space** so the highlights overlay lands in the right spot. Multiply `.mob` coords by the device's scale factor before writing them to `timeline.json`.

### Invariants

1. The first event has `timeMs: 0` and `type: "record_start"`. It may also carry `recordStartOffsetMs` — the elapsed ms between the recorder starting and the `record_start` checkpoint firing.
2. `timeMs` is measured from the `record_start` checkpoint (choreography time), in milliseconds, monotonically increasing. To translate to raw-recording time, add `recordStartOffsetMs`.
3. The last event before `record_stop` is the final user-visible action.
4. The final event has `type: "record_stop"` and a `timeMs` equal to the elapsed choreography duration.

## Example

```json
[
  { "timeMs": 0,    "type": "record_start", "line": 29, "recordStartOffsetMs": 1800 },
  { "timeMs": 341,  "type": "tap",  "line": 33, "x": 603,  "y": 2454, "intent": "Open the New Reminder composer", "caption": "Add a reminder in seconds" },
  { "timeMs": 1141, "type": "wait", "line": 35, "durationMs": 800, "reason": "technical" },
  { "timeMs": 2675, "type": "tap",  "line": 38, "x": 600,  "y": 200,  "intent": "Tap the title field" },
  { "timeMs": 3675, "type": "wait", "line": 40, "durationMs": 1000, "reason": "viewer_readability" },
  { "timeMs": 4039, "type": "tap",  "line": 76, "x": 1104, "y": 234,  "intent": "Save", "caption": "Save" },
  { "timeMs": 5039, "type": "wait", "line": 78, "durationMs": 1000, "reason": "technical" },
  { "timeMs": 5381, "type": "tap",  "line": 113, "x": 96,   "y": 519,  "intent": "Mark complete", "caption": "Done!" },
  { "timeMs": 6864, "type": "wait", "line": 115, "durationMs": 1500, "reason": "viewer_readability" },
  { "timeMs": 8364, "type": "record_stop", "line": 117 }
]
```

## How the exporter uses the timeline

| Field | Used for |
|---|---|
| `type: "tap"` + `x,y` | render a tap ripple at that pixel coordinate AND drive the moving-finger overlay |
| `type: "swipe"` + endpoints + `durationMs` | drive the finger overlay along the swipe path |
| `intent` | tooltip / fallback caption when none provided |
| `caption` | floating caption overlay; on screen from this event to the next caption event (or `record_stop`) |
| `reason: "technical"` on `wait` | candidate for speed-up during edit (deferred MVP feature) |
| `reason: "viewer_readability"` on `wait` | preserve at 1× — never speed up |
| `recordStartOffsetMs` + first action `timeMs` | trim point for the start of the final video (in raw-recording time) |
| `recordStartOffsetMs` + `record_stop` / latest event end | trim point for the end of the final video |

## Validation rules

Before export, verify:

- `timeline.json` parses as JSON
- exactly one `record_start` and one `record_stop`
- `timeMs` is non-decreasing
- every `tap` has both `x` and `y`
- every `swipe` has both endpoints and `durationMs`
- every `wait` has `durationMs` and a `reason`

If any of these fail, do not export — fix the timeline-build step and re-emit (no need to re-record; the source mp4 is unchanged).
