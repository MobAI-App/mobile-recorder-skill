---
name: mobile-recorder-skill
description: Use this skill when the user asks to record, create, produce, or export a demo video of a **mobile app** (iOS or Android) - for launch, marketing, App Store/Play Store listings, social posts, bug reproductions, or internal walkthroughs. Triggers on "record a mobile demo", "iOS demo video", "Android demo video", "App Store screenshots video", "Play Store demo", "record an app demo on the simulator", "record the iPhone screen", "make a demo of this app". Enforces an exploration-first workflow - explore → script → dry-run → record → edit/export - and produces a `.mob` script, native iPhone/Android-pixel recording, timeline metadata, captions, tap highlights with a moving finger overlay, and upload copy. For desktop or web demos, use the sibling `desktop-recorder-skill` instead.
---

# Mobile Recorder

## Promise

Turn a prompt describing a mobile demo into a polished, reproducible demo video - plus a saved `.mob` script that can be re-recorded any time.

## The golden rule

**Never improvise during the final recording.**

Correct flow:

```
explore → script → dry-run → record → edit/export
```

Wrong flow (produces ugly, glitchy video):

```
start recording → observe → think → tap → observe → think → tap
```

The agent is allowed to be slow and uncertain during exploration. Once recording starts, every action must be pre-decided and pre-timed.

---

## Targets supported

| Target | Provider | Recording | Default format |
|---|---|---|---|
| iOS Simulator | MobAI | MJPEG q=100 via MobAI HTTP stream | `vertical_9_16` |
| iOS physical device | MobAI | MJPEG q=100 via MobAI HTTP stream | `vertical_9_16` |
| Android (physical or emulator) | MobAI | `adb screenrecord` | `vertical_9_16` |

**Before writing any `.mob` file**, read `mobai://reference/testing` and `mobai://reference/device-automation` - those are the canonical sources for `.mob` syntax and DSL actions. `references/mobile.md` in this skill only covers the demo-specific layer on top (what's allowed/banned in a demo `.mob`, finger-overlay coordinates, recording integration).

---

## Core rules

### Rule 1 - Explore first

Before writing the script, explore the target end-to-end. During exploration the agent may be slow and use observation-heavy tools: `observe` with `ui_tree` / `screenshot` / `ocr`, predicates, retries, manual reasoning.

Exploration must collect, at minimum:

- the exact tap sequence as `(x, y)` coordinates in device logical points
- per-action waits (technical waits vs. viewer-readability waits)
- fixed swipe counts and directions (no "scroll until X")
- demo data to use
- popups / permission dialogs / interstitials that need to be normalized in setup
- the start state (the screen the recording's first `tap` expects)
- moments that deserve a caption or callout
- on-screen-keyboard key coordinates if the demo includes text entry

### Rule 2 - Generate a deterministic `.mob`

After exploration, write a `.mob` that's **coordinate-driven inside the recording window** - every interaction inside `checkpoint "record_start"` / `checkpoint "record_stop"` is `tap X,Y` / `swipe X1,Y1 to X2,Y2` / `delay N` / `press_key …` / `navigate …`. Text entry is one `tap X,Y` per keyboard key. Keyboard dismissal is a coordinate tap.

The recording window is what gets trimmed into the final video; everything outside those two checkpoints is just device prep. So:

- **Outside the recording window** (setup section before `record_start`, and any tail after `record_stop`): predicates allowed. `app fresh`, `wait_for "Element" timeout:N`, `assert_exists`, `if_exists` - use the full MobAI `.mob` syntax to normalize state, wait for the app to actually paint, dismiss popups, etc.
- **Inside the recording window**: coordinates only, with **one exception**: `wait_for "Element" timeout:N` is allowed when you need to synchronize on an unpredictable screen change (network load, lazy paint). Other predicates (`tap "Text"`, `assert_*`, `if_exists`, `hide_keyboard`, `extract`, `type`, `observe`, `scroll to`) stay banned in-recording - they substitute for what should be coordinates and add UI-tree latency that surfaces as visible stutter on camera.

**Caveat on `wait_for` inside the recording window**: some apps have multi-hundred-ms UI-tree fetches. In those, `wait_for` polling visibly stutters the take - drop it for a tuned fixed `delay` measured from the dry-run. See `references/mobile.md` for full allowed/banned tables and the caveat.

Section layout - only two sections, demo scripts are choreography, not tests:

```
setup       – launch + wait for stable UI, dismiss popups, normalize state (predicates allowed)
recording   – linear deterministic actions, bracketed by checkpoint "record_start" / "record_stop"
```

There is no `preflight` or `validate` section.

**App launch placement - agent's choice:**

| Placement | What the demo opens on | When |
|---|---|---|
| Outside recording (default) - `app fresh` + `wait_for` in setup before `record_start` | Already-loaded app | Default. Cleanest trim. No splash on screen. |
| Inside recording - `record_start` first, then a coordinate tap of the app icon on the home screen | Home screen → tap icon → splash → app appears | Cinematic. Demonstrates discoverability. |

**Never use a fixed `delay` after `app fresh` to wait for the relaunch** - MobAI's reported `startedAtMs` for `app fresh` is when the IPC went out, not when iOS Springboard finishes the kill+relaunch+splash cycle (which takes ~3-4 s on iOS Simulator). A 1500 ms `delay` will land `record_start` on stale frames. Use `wait_for "<expected-element>" timeout:8000` instead - it returns the exact moment the loaded UI paints.

**Always add a trailing settle right before `checkpoint "record_stop"`** - otherwise the take freezes mid-transition. A fixed `delay 1500` covers most iOS push/pop and scroll inertia.

State normalization (closing prior runs, dismissing popups, logging in, navigating to start) can live in either the `.mob`'s setup section OR a separate one-off `execute_dsl` pass before the recorder starts. Pick whichever fits the demo's structure - both end on the same state by the time `record_start` fires.

If the take ends on the wrong screen, the video shows that - verify visually or with a one-off `observe` from outside the script.

Timeline metadata: attach `# Intent: …` and `# Caption: …` comments to the line immediately above each action. The exporter reads them from the `.mob` source.

Recording is started and stopped **outside** the `.mob`. The agent:

1. starts the native recorder (`scripts/mobile_record_*.sh`) - it writes a `<out>.start_ts` sidecar with the wall-clock epoch;
2. runs the `.mob` via `test_run`;
3. stops the recorder via `scripts/mobile_record_stop.sh <out>` - SIGINTs ffmpeg, and (for MJPEG) post-hoc retimes the mp4 so video duration matches wall-clock. The MJPEG stream has no per-frame timestamps and over-delivers during interactions, which would otherwise leave a slow-mo recording with mis-aligned highlights.

### Rule 3 - Dry-run before recording

Run the full `.mob` with `test_run` (no recorder running). If it fails:

1. capture screenshot / UI tree at the failure
2. fix the script (coordinate, timing, or pre-recording state normalization)
3. dry-run again

Do not record until a clean dry-run passes end-to-end.

### Rule 4 - Native recording only for the final take

Final output uses native / high-FPS device-pixel recording, not screenshot stitching.

Recording backends:

- iOS Simulator + iOS physical device → `scripts/mobile_record_mjpeg.sh <out> <udid> 60 100` - MobAI HTTP MJPEG stream at quality=100, 60fps. Stable 30fps CFR after `mobile_record_stop.sh` retime, writes the `.start_ts` sidecar `build_timeline.js` prefers for `recordStartOffsetMs`. Always pass `quality=100` (counter-intuitively produces smaller mp4s than lower quality - clean JPEGs compress better through H.264).
- Android → `scripts/mobile_record_android.sh <out>` - wraps `adb screenrecord`.

`xcrun simctl io recordVideo` is intentionally NOT supported - it only emits frames on display invalidation, so demo dwell time (intro holds, post-tap pauses) plays back as frozen frames.

### Rule 5 - No recovery inside the final recording

If the final take fails:

1. stop recording
2. discard the failed take
3. fix the script
4. re-record from scratch

Live recovery during recording makes ugly video. The only exception is `bug_repro` demos where the bug *is* the point.

---

## End-to-end workflow

```
1. Read the prompt → identify target device (iOS sim / iOS physical / Android), app, key flow, vibe.
2. Confirm device is booted, app installed, MobAI bridge running.
3. EXPLORE - walk the flow via execute_dsl with observe, note coordinates / waits / keyboard key positions.
4. DRAFT .mob - setup section may use predicates (app fresh, wait_for, assert_exists);
   recording section is coordinates + delay + wait_for. # Intent: / # Caption: / # Reason: comments above each action.
5. NORMALIZE state - either in the .mob's setup section OR via a separate execute_dsl pass.
6. DRY-RUN the .mob via test_run; fix until clean.
7. START native recorder (writes `<out>.start_ts` + `<out>.warmup_ms` sidecars).
8. RUN the .mob via test_run.
9. STOP recorder with `scripts/mobile_record_stop.sh <out>` - sends SIGINT and retimes the mp4 to wall-clock if needed.
10. BUILD timeline.json with `scripts/build_timeline.js demo.mob test_run.json timeline.json --scale N --recording demo.raw.mp4` - `--recording` pulls in the warmup + start_ts sidecars so `recordStartOffsetMs` matches the actual gap between recorder start and `record_start` checkpoint.
11. DRAFT editor.json - top-level captions[] + highlights[] + directives[] (zoom / speed / trim).
   Use startDelayMs / endDelayMs to fine-tune timing without re-recording. See references/editor.md.
12. ADD highlights (pass editor.json so captions[] and highlights[] are read) → FRAME (composite into
   phone-bezel + background, canvas aspect MUST match export aspect) → ZOOM (single fromLine/toLine
   range w/ optional pan waypoints) → SPEEDUPS → EXPORT.
13. WRITE copy.md.
14. SAVE the .mob + editor.json + timeline.json next to the video so the demo is reproducible.
```

---

## Outputs

Save outputs in a single demo folder (default: `./demo-out/<name>/`):

```
demo.mob              ← reproducible choreography script
editor.json           ← post-production directives (zoom / speed / trim)
timeline.json         ← per-event metadata, with `line` joining back to .mob
demo.raw.mp4          ← native recording, untouched
demo.hl.mp4           ← with tap ripples + moving finger overlay
demo.framed.mp4       ← composited into phone-bezel + background canvas
demo.hlz.mp4          ← + zoom passes (operates on the composite)
demo.hlzs.mp4         ← + speedups (writes <out>.timewarp.json)
demo.vertical.mp4     ← final 1080×1920 export
*.captions.json       ← caption track (sidecar, one per stage)
copy.md               ← upload copy
```

---

## Detailed references

Load these as needed:

- `references/mobile.md` - MobAI workflow, `.mob` script allowed/banned actions, coordinate capture, keyboard key tap patterns, recording-backend decision tree
- `references/timeline.md` - `DemoTimelineEvent` schema and how to build `timeline.json` from `.mob` source + `test_run` results
- `references/editor.md` - `editor.json` schema (zoom / speed / trim directives, `side` semantics, defaults)
- `references/editing.md` - pipeline order, highlights, captions, speed-up rules, time math, export presets
- `remotion-template/` - optional Remotion bridge: turn a recording (`timeline.json` + `editor.json` + `rec.mp4`) into React motion graphics. The bridge (`loadRecording` + `<RecordingStage>`/`<PhoneBezel>`/`<RecordingCard>`/`<Cursor>`/`<TapRipple>`/`<SwipePath>`/`<Caption>`) does the integration; you only write the creative composition. Separate from the lean ffmpeg pipeline; needs `npm install` and headless Chrome. See its `README.md`.

## Example scripts

- `assets/examples/mobile-onboarding.mob` - canonical mobile demo (tap sequence + per-key text entry)
- `assets/examples/mobile-bug-repro.mob` - bug reproduction (the one exception where post-record-stop branching is allowed)

## Templates

- `assets/templates/copy-template.md` - title / short post / Shorts title / thumbnail
- `assets/templates/captions-template.json` - caption track shape
- `assets/templates/editor-template.json` - sample editor.json with zoom + speed + trim directives

## Helper scripts

- `scripts/mobile_record_mjpeg.sh <out> <udid> [fps] [quality]` - MobAI HTTP MJPEG stream → mp4. Default fps=60, quality=100. Works for both iOS Sim and physical iOS devices. Writes `<out>.start_ts` + `<out>.warmup_ms` sidecars used by the stop helper and `build_timeline.js`.
- `scripts/mobile_record_android.sh <out>` - Android `adb screenrecord`.
- `scripts/mobile_record_stop.sh <out>` - SIGINTs the recorder cleanly, then if the mp4 is more than 5% longer than wall-clock (typical for MJPEG over-delivery), retimes it via `setpts=ratio*PTS,fps=30`. Required for the MJPEG path; harmless for `adb` (it produces wall-clock-accurate mp4s already).
- `scripts/build_timeline.js <demo.mob> <test_run.json> <timeline.json> [--scale n]` - build and validate timeline metadata from `.mob` comments + test_run timings (uses `startedAtMs` per step when available). Also supports `--validate <timeline.json>`.
- `scripts/add_highlights.js <raw.mp4> <timeline.json> <out.mp4> [editor.json] [flags]` - render tap ripples + walking-cursor finger overlay (slides from previous target into the new target, holds, fades out). Pass editor.json so captions come from editor.captions[] (preferred) and per-line tweaks from editor.highlights[] apply. Without editor.json, falls back to `.mob` `# Caption:` comments.
- `scripts/add_frame.js <in.mp4> <out.mp4> [flags]` - composite the highlighted recording into a phone-bezel + background canvas. **Canvas aspect MUST match the export aspect** (`export_video.js` pads, not crops). Default `1620x2880` (vertical 9:16, 1.5× oversample); use `--canvas 2880x1620` for horizontal_16_9. Writes a `<out>.frame.json` sidecar so the zoom stage knows the screen rect. Flags: `--canvas WxH`, `--bg-color RRGGBB`, `--bg-image PATH`, `--bg-gradient TOP:BOTTOM`, `--screen-margin PX`, `--bezel-thickness PX`, `--bezel-color RRGGBB`, `--screen-radius PX`, `--bezel-png PATH` (+ `--screen-rect X,Y,W,H`).
- `scripts/add_zoom.js <in.mp4> <timeline.json> <editor.json> <out.mp4>` - animated zoom from editor.json directives. Float-precise `scale=eval=frame` + bounded `crop` (no zoompan integer-rounding jitter at slow pan speeds). Default center is horizontal canvas center + vertical-clamped so the status bar stays visible at any zoom (override with explicit `x`/`y` in canvas pixels). Supports `pan: [{afterMs, x, y, ease}]` waypoints to fly the camera within a zoom range. Multi-action ranges use `{fromLine, toLine}` so the peak holds across actions without dipping. Skipped silently if no zoom directives.
- `scripts/add_speedups.js <in.mp4> <timeline.json> <editor.json> <out.mp4>` - re-time spans per editor.json (no auto pass; every segment is explicit). Writes `<out>.timewarp.json` and remaps the captions sidecar through the warp.
- `scripts/export_video.js <in.mp4> <timeline.json> <editor.json> <out.mp4> <format>` - trim (via `editor.trim`) + crop + final export. Maps trim points through `<in>.timewarp.json` if present.
- `scripts/burn_captions.js <in.mp4> <captions.json> <out.mp4>` - optional final pass that bakes the captions sidecar into pixels. Renders each caption to a PNG via pure-JS opentype.js (vendored, no npm) + a hand-rolled rasterizer in `lib/text-png.js`, then overlays with ffmpeg's `overlay` filter. Works on any ffmpeg build (no libass / libfreetype needed). Bundled default font: Inter Bold; override with `--font PATH`.
- `scripts/generate_copy.js <timeline.json> <prompt.txt> <copy.md>` - produce upload copy.

All recording scripts start in the background and write a PID file at `<output>.pid`. Use `mobile_record_stop.sh <output>` to stop cleanly - it sends SIGINT (which lets the recorder flush a valid mp4), waits for ffmpeg to exit, and retimes if needed. Direct `kill -INT $(cat <output>.pid)` also works for `adb` but skips the MJPEG retime, so the MJPEG mp4 will be a slow-mo.

---

## Failure handling at a glance

| Stage | Failure | Action |
|---|---|---|
| Exploration | flow unclear | ask user, or pick a reasonable path and note assumption in `copy.md` |
| Dry-run | step fails | inspect screen state, fix script, re-dry-run |
| Recording | step fails mid-take | stop recording, discard, fix script, re-record |
| Validate | wrong final screen | discard take, fix script, re-record |
| Export | ffmpeg error | re-read timeline, check format defaults in `references/editing.md` |

---

## Not in scope (use a different skill / tool)

- Desktop or web demos → use the sibling `desktop-recorder-skill`.
- Direct upload to YouTube/TikTok/X.
- AI voiceover or background music.
- A full GUI video editor.
