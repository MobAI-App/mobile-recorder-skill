---
name: mobile-recorder-skill
description: Use this skill when the user asks to record, create, produce, or export a demo video of a **mobile app** (iOS or Android) — for launch, marketing, App Store/Play Store listings, social posts, bug reproductions, or internal walkthroughs. Triggers on "record a mobile demo", "iOS demo video", "Android demo video", "App Store screenshots video", "Play Store demo", "record an app demo on the simulator", "record the iPhone screen", "make a demo of this app". Enforces an exploration-first workflow — explore → script → dry-run → record → edit/export — and produces a `.mob` script, native iPhone/Android-pixel recording, timeline metadata, captions, tap highlights with a moving finger overlay, and upload copy. For desktop or web demos, use the sibling `desktop-recorder-skill` instead.
---

# Mobile Recorder

## Promise

Turn a prompt describing a mobile demo into a polished, reproducible demo video — plus a saved `.mob` script that can be re-recorded any time.

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
| iOS Simulator | MobAI | MJPEG q=100 via MobAI HTTP stream (primary); `xcrun simctl io recordVideo` (no-MobAI fallback) | `vertical_9_16` |
| iOS physical device | MobAI | MJPEG q=100 via MobAI HTTP stream | `vertical_9_16` |
| Android (physical or emulator) | MobAI | `adb screenrecord` | `vertical_9_16` |

**Before writing any `.mob` file**, read `mobai://reference/testing` and `mobai://reference/device-automation` — those are the canonical sources for `.mob` syntax and DSL actions. `references/mobile.md` in this skill only covers the demo-specific layer on top (what's allowed/banned in a demo `.mob`, finger-overlay coordinates, recording integration).

---

## Core rules

### Rule 1 — Explore first

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

### Rule 2 — Generate a deterministic `.mob`

After exploration, write a `.mob` that uses **coordinates only** in the entire script. No `type`, no `hide_keyboard`, no predicates anywhere — every interaction is `tap X,Y` or `swipe X1,Y1 to X2,Y2`. Text entry is one `tap X,Y` per keyboard key. Keyboard dismissal is a coordinate tap (Return key, nav-bar Save button, or outside-input area). See `references/mobile.md` for the full allowed/banned list.

The whole point of exploring first is to capture stable coordinates so the take is smooth, predictable, and looks like a real user. Predicates require a UI-tree lookup per step, which shows up as visible stutter in the video. The target device size is fixed for this demo, so coordinates are safe.

Section layout. Only two sections — demo scripts are choreography, not tests:

```
setup       – open app, dismiss permissions, log in, seed data, navigate to start
recording   – linear, deterministic actions, bracketed by checkpoint "record_start" / "record_stop"
```

**No `assert_*` and no `if_exists` anywhere in a demo `.mob`.** Both trigger UI-tree lookups and turn the script into a test. Demo scripts are pure choreography from a known starting state. There is no `preflight` or `validate` section.

**Always add a trailing settle right before `checkpoint "record_stop"`** — otherwise the take freezes mid-transition. Use a conservative fixed `delay 1500` for now; once MobAI parses `wait_for stable timeout:N` in `.mob` syntax (today it only exists in the DSL JSON shape), swap to that. See `references/mobile.md` for the exact rule.

State normalization (closing prior runs, dismissing popups, logging in, navigating into a specific list) happens **outside** the `.mob`, in a separate `execute_dsl` pass the agent runs before the recorder starts. By the time the `.mob` runs, the device is on the exact screen the first `tap` expects.

If the take ends on the wrong screen, the video shows that — verify visually or with a one-off `observe` from outside the script.

Timeline metadata: attach `# Intent: …` and `# Caption: …` comments to the line immediately above each action. The exporter reads them from the `.mob` source.

Recording is started and stopped **outside** the `.mob`. The agent:

1. starts the native recorder (`scripts/mobile_record_*.sh`) — it writes a `<out>.start_ts` sidecar with the wall-clock epoch;
2. runs the `.mob` via `test_run`;
3. stops the recorder via `scripts/mobile_record_stop.sh <out>` — SIGINTs ffmpeg, and (for MJPEG) post-hoc retimes the mp4 so video duration matches wall-clock. The MJPEG stream has no per-frame timestamps and over-delivers during interactions, which would otherwise leave a slow-mo recording with mis-aligned highlights.

### Rule 3 — Dry-run before recording

Run the full `.mob` with `test_run` (no recorder running). If it fails:

1. capture screenshot / UI tree at the failure
2. fix the script (coordinate, timing, or pre-recording state normalization)
3. dry-run again

Do not record until a clean dry-run passes end-to-end.

### Rule 4 — Native recording only for the final take

Final output uses native / high-FPS device-pixel recording, not screenshot stitching.

Recording backends:

- iOS Simulator (MobAI bridge running) → `scripts/mobile_record_mjpeg.sh <out> <udid> 60 100` — MobAI HTTP MJPEG stream at quality=100, 60fps. Stable 30fps CFR after `mobile_record_stop.sh` retime, writes the `.start_ts` sidecar `build_timeline.js` prefers for `recordStartOffsetMs`.
- iOS Simulator (no MobAI) → `scripts/mobile_record_ios_sim.sh <abs-output.mp4>` — wraps `xcrun simctl io recordVideo`. Pass an **absolute** output path; relative paths produce a misleading "SimRenderServer error 2". simctl produces a VFR mp4 (~23-25fps avg). Writes both `.warmup_ms` and `.start_ts` sidecars.
- iOS physical device → `scripts/mobile_record_mjpeg.sh <out> <udid> 60 100` — always `quality=100` (counter-intuitively produces smaller mp4s than lower quality, because clean JPEGs compress better through H.264).
- Android → `scripts/mobile_record_android.sh <out>` — wraps `adb screenrecord`.

### Rule 5 — No recovery inside the final recording

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
3. EXPLORE — walk the flow via execute_dsl with observe, note coordinates / waits / keyboard key positions.
4. DRAFT .mob — coordinates only, section structure via heading comments + checkpoint markers,
   # Intent: / # Caption: / # Reason: comments above each action.
5. NORMALIZE state via a one-off execute_dsl pass (close apps, dismiss popups, navigate to start screen).
6. DRY-RUN the .mob via test_run; fix until clean.
7. RE-NORMALIZE state (the dry-run may have changed it).
8. START native recorder (writes `<out>.start_ts` + `<out>.warmup_ms` sidecars).
9. RUN the .mob via test_run.
10. STOP recorder with `scripts/mobile_record_stop.sh <out>` — sends SIGINT and retimes the mp4 to wall-clock if needed.
11. BUILD timeline.json with `scripts/build_timeline.js demo.mob test_run.json timeline.json --scale N --recording demo.raw.mp4` — `--recording` pulls in the warmup + start_ts sidecars so `recordStartOffsetMs` matches the actual gap between recorder start and `record_start` checkpoint.
12. DRAFT editor.json — post-production directives (zoom / speed / trim) anchored to .mob line numbers. See references/editor.md.
13. ADD highlights → FRAME (composite into phone-bezel + background) → ZOOM (on the composite) → SPEEDUPS → EXPORT vertical_9_16.
14. WRITE copy.md.
15. SAVE the .mob + editor.json + timeline.json next to the video so the demo is reproducible.
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

- `references/mobile.md` — MobAI workflow, `.mob` script allowed/banned actions, coordinate capture, keyboard key tap patterns, recording-backend decision tree
- `references/timeline.md` — `DemoTimelineEvent` schema and how to build `timeline.json` from `.mob` source + `test_run` results
- `references/editor.md` — `editor.json` schema (zoom / speed / trim directives, `side` semantics, defaults)
- `references/editing.md` — pipeline order, highlights, captions, speed-up rules, time math, export presets

## Example scripts

- `assets/examples/mobile-onboarding.mob` — canonical mobile demo (tap sequence + per-key text entry)
- `assets/examples/mobile-bug-repro.mob` — bug reproduction (the one exception where post-record-stop branching is allowed)

## Templates

- `assets/templates/copy-template.md` — title / short post / Shorts title / thumbnail
- `assets/templates/captions-template.json` — caption track shape
- `assets/templates/editor-template.json` — sample editor.json with zoom + speed + trim directives

## Helper scripts

- `scripts/mobile_record_ios_sim.sh <abs-output.mp4>` — iOS Simulator native recording. Pass absolute path.
- `scripts/mobile_record_mjpeg.sh <out> <udid> [fps] [quality]` — MobAI HTTP MJPEG stream → mp4. Default fps=60, quality=100. Works for both iOS Sim and physical iOS devices. Writes `<out>.start_ts` + `<out>.warmup_ms` sidecars used by the stop helper and `build_timeline.js`.
- `scripts/mobile_record_android.sh <out>` — Android `adb screenrecord`.
- `scripts/mobile_record_stop.sh <out>` — SIGINTs the recorder cleanly, then if the mp4 is more than 5% longer than wall-clock (typical for MJPEG over-delivery), retimes it via `setpts=ratio*PTS,fps=30`. Required for the MJPEG path; harmless for simctl / adb (they produce wall-clock-accurate mp4s already).
- `scripts/build_timeline.js <demo.mob> <test_run.json> <timeline.json> [--scale n]` — build and validate timeline metadata from `.mob` comments + test_run timings (uses `startedAtMs` per step when available). Also supports `--validate <timeline.json>`.
- `scripts/add_highlights.js <raw.mp4> <timeline.json> <out.mp4> [--ripple-color rgba]` — render tap ripples + moving finger overlay that travels between actions. Also writes a `<out>.captions.json` sidecar.
- `scripts/add_frame.js <in.mp4> <out.mp4> [flags]` — composite the highlighted recording into a phone-bezel + background canvas. Writes a `<out>.frame.json` sidecar with canvas / screen-rect metadata so the zoom stage can default its center. Flags: `--canvas WxH`, `--bg-color RRGGBB`, `--bg-image PATH`, `--screen-margin PX`, `--bezel-thickness PX`, `--bezel-color RRGGBB`, `--screen-radius PX`, `--bezel-png PATH` (+ `--screen-rect X,Y,W,H`).
- `scripts/add_zoom.js <in.mp4> <timeline.json> <editor.json> <out.mp4>` — animated zoom from editor.json directives. After framing, "zoom" enlarges the whole composite (phone moves closer to the camera). Skipped silently if no zoom directives.
- `scripts/add_speedups.js <in.mp4> <timeline.json> <editor.json> <out.mp4>` — re-time spans per editor.json (no auto pass; every segment is explicit). Writes `<out>.timewarp.json` and remaps the captions sidecar through the warp.
- `scripts/export_video.js <in.mp4> <timeline.json> <editor.json> <out.mp4> <format>` — trim (via `editor.trim`) + crop + final export. Maps trim points through `<in>.timewarp.json` if present.
- `scripts/burn_captions.js <in.mp4> <captions.json> <out.mp4>` — optional final pass that bakes the captions sidecar into pixels via ffmpeg's libass `subtitles` filter.
- `scripts/generate_copy.js <timeline.json> <prompt.txt> <copy.md>` — produce upload copy.

All recording scripts start in the background and write a PID file at `<output>.pid`. Use `mobile_record_stop.sh <output>` to stop cleanly — it sends SIGINT (which lets the recorder flush a valid mp4), waits for ffmpeg to exit, and retimes if needed. Direct `kill -INT $(cat <output>.pid)` also works for simctl/adb but skips the MJPEG retime, so the MJPEG mp4 will be a slow-mo.

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
