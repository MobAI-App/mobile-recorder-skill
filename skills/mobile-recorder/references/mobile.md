# Mobile workflow (MobAI + `.mob`)

Use this reference when the demo target is a mobile app - iOS Simulator, iOS physical device, or Android.

## Read first

**Always** read the canonical MobAI references before touching a `.mob` file:

- `mobai://reference/testing` - `.mob` script syntax, rules, error fixes
- `mobai://reference/device-automation` - DSL actions, predicates, failure strategies

This document is a thin layer on top of those. It covers only the parts that are specific to the demo-recorder skill (timeline metadata, recording control, section structure).

## Pipeline

```
User prompt
  ↓
Explore the app via MobAI MCP (observe ui_tree / screenshots / installed_apps / OCR)
  ↓
Generate an optimized .mob script (real .mob syntax, see below)
  ↓
Dry-run the .mob (test_run, observation/assertions enabled)
  ↓
Start native device recording (MobAI MJPEG / adb screenrecord) OUTSIDE the .mob
  ↓
Run the same .mob again (or just the recording portion) via test_run
  ↓
Stop recording (kill the recorder)
  ↓
Build timeline.json from test_run step timings + .mob source comments
  ↓
Export edited video + copy
```

## Section structure (convention, not syntax)

`.mob` is a **flat** script - there is no literal `section ... end` block. Use heading comments to organize the script and `checkpoint` markers to bracket the recording portion:

```
# === setup ===
# normalize state: launch fresh, dismiss permissions, log in, navigate to start
# === recording ===
checkpoint "record_start"
# … the actions you want in the final video …
checkpoint "record_stop"
```

Only two sections. **No assertions** - see below.

The exporter uses `checkpoint "record_start"` and `checkpoint "record_stop"` to know where the recording portion begins and ends (so it can trim correctly).

## Predicates: allowed in setup, banned in recording

The `checkpoint "record_start"` / `checkpoint "record_stop"` lines bracket
the recording window. **What's banned vs allowed depends entirely on which
side of those checkpoints a line lives:**

### Setup (anything before `checkpoint "record_start"`) - anything goes

Use MobAI's full `.mob` syntax here. Predicates, assertions, `wait_for`,
`if_exists` - all fine. The recorder is already running, but these lines
just settle the device into the known start state; they don't show as
"actions" in the final video because they happen before the trim head.

The standard setup pattern is:

```
# === setup ===
app "<bundle>" fresh
wait_for "<expected-element>" timeout:8000   # blocks until the loaded UI is painted
# (optional: dismiss permission dialog, log in, navigate to start, etc.)
# === recording ===
checkpoint "record_start"
```

`wait_for "Element" timeout:N` polls the UI tree until the element appears
(or timeout fires). This replaces brittle `delay N` magic numbers after
`app fresh` - iOS Simulator's Springboard processes the relaunch
asynchronously and `app fresh` returns on IPC, not on the visual completion.
Picking a delay big enough is guesswork; `wait_for` is exact.

### Recording (between the two checkpoints) - coordinates, plus `wait_for`

Most predicates are banned inside the recording window: they substitute
for coordinate-based actions, and the UI-tree fetch they trigger is wasted
work that surfaces as visible stutter on the video. Coordinates make the
take deterministic and smooth.

The one exception is **`wait_for "Element" timeout:N`** - there's no other
way to visibly synchronize on app state changes (e.g. waiting for a sheet
to settle, a list to load, a network response to paint). It's allowed in
the recording window:

```mob
tap 184,712
wait_for "Dashboard" timeout:3000   # block until the new view is on screen
tap 200,400
```

**Caveat - fall back to `delay` if the UI tree is slow.** Some apps
(complex SwiftUI hierarchies, web views, heavy third-party SDKs) have
multi-hundred-ms UI-tree fetches. In those, `wait_for` will hammer the
tree every poll interval and noticeably stutter the recording. Symptoms:
the take looks choppy around `wait_for` lines, or the per-step `durationMs`
in the test_run output is much longer than the actual visual wait.

When that happens, drop the `wait_for` and use a tuned fixed `delay`
measured from the dry-run instead:

```mob
tap 184,712
delay 1200    # measured from the dry-run: visual settle takes ~1100 ms
tap 200,400
```

Other predicates (`tap "Text"`, `assert_*`, `if_exists`, `scroll to`,
`hide_keyboard`, `extract`, `type`, `observe`) stay banned inside the
recording window - use coordinates / hardware keys / explicit delays.

Allowed inside the recording window:

| Action | Reason it's allowed |
|---|---|
| `tap X,Y` | coordinate tap |
| `swipe X1,Y1 to X2,Y2` | coordinate swipe |
| `delay N` | timer, no lookup |
| `wait_for "Element" timeout:N` | exact synchronization on state change - but watch for UI-tree latency, see caveat above |
| `press_key home\|back\|enter` | hardware key |
| `navigate home` | navigation shortcut |
| `screenshot "path"` | dumps current frame, no lookup |

Banned inside the recording window:

| Action | Why banned |
|---|---|
| `type ...` (any form) | even `type "text"` is magic text-insertion no real user does; real users tap keys |
| `assert_*` (`assert_exists`, `assert_not_exists`, `assert_count`) | tree lookup substitutes for what should be a coordinate tap |
| `if_exists { ... } else { ... }` | tree lookup for branching - non-deterministic, breaks the choreography contract |
| `tap "Text"` / `tap "Text" type:button` / `tap "Text" near "..."` | predicate-based tap; use coordinates |
| `hide_keyboard` | dismiss via tap or swipe on coordinates instead |
| `observe` | full tree dump |
| `scroll down to "<element>"` | predicate-based scroll; use a coordinate swipe |
| `extract <key> from "<element>"` | predicate-based read |
| `copy_text "Field"` / `paste_text "Field"` | predicate-based |

### Trailing settle before `record_stop`

`checkpoint "record_stop"` fires the instant the previous action's runtime
finishes - but the screen animation it triggered (slide-in, fade, push,
scroll momentum) often isn't done yet. Without a settle, the final video
freezes mid-transition.

Use a fixed-length `delay` as the trailing settle, picked long enough to
cover the longest plausible animation at that point (1500 ms is usually
enough for iOS push/pop and scroll inertia):

```mob
swipe 201,650 to 201,300
delay 1800                # viewer_readability - hold on the result
delay 1500                # trailing settle: covers scroll-momentum + nav animations
checkpoint "record_stop"
```

If a known final element appears once the animation completes, `wait_for`
also works here (returns as soon as the element paints rather than always
waiting the full timeout) - but watch the UI-tree-latency caveat. For a
short trailing settle, a fixed `delay` is almost always faster and simpler.

### Text input - tap each key on the keyboard

Real users don't paste text. They tap individual keyboard keys. The demo does the same.

During exploration, capture the center coordinate of each key on the app's on-screen keyboard in the locale and orientation the demo uses. Then in the recording section, emit one `tap X,Y` per character (plus shift/123/symbols toggles as needed). A `delay 60` between key taps gives the take a natural typing rhythm.

Example - typing "Test" with the iOS default English keyboard on iPhone (logical coords):

```mob
# Intent: Type the reminder title
# Caption: Type what you need to remember
tap 25,740     # shift
delay 80
tap 180,620    # T
delay 80
tap 100,620    # e
delay 80
tap 68,680     # s
delay 80
tap 180,620    # t
delay 80
```

For long strings the script becomes verbose - that's fine, it's data, not logic. Generate it from a small helper (e.g. a Python/Node script that maps a target string + a keyboard layout JSON into `tap X,Y` lines) during the explore step and paste the result into the `.mob`.

Coord-capture for the keyboard layout is a one-time job per device/orientation: take one screenshot of the keyboard, mark the center of each key, save as `keyboard-layout-<device>-<lang>.json`. Reuse across all demos for that device.

### Keyboard dismissal - tap or swipe, never `hide_keyboard`

Dismiss the keyboard with the same coordinate-only vocabulary the rest of the take uses:

- tap the keyboard's own Return / Done / Search key at its known coordinate;
- tap a Done / Save button in the nav bar that the app shows above the keyboard (often the same tap that submits the form);
- tap a non-input area of the screen if the app dismisses-on-outside-tap;
- swipe down on the keyboard area if the app supports the gesture.

Choose what the app supports, capture the coordinate during exploration, and write a plain `tap X,Y` or `swipe X1,Y1 to X2,Y2`. Do not use `hide_keyboard`.

## State normalization - `.mob` setup or one-off `execute_dsl`

Two equally valid placements:

1. **In the `.mob`'s setup section.** Use `app fresh`, `wait_for`,
   `assert_exists`, `if_exists` to dismiss popups, log in, navigate to the
   start screen. Cleanest when the normalization is short and stable.

2. **In a one-off `execute_dsl` pass before the `.mob` runs.** Use this
   when normalization is heavier, needs agent reasoning across steps
   (screenshots + OCR + branching decisions), or is shared across many
   demos.

Both end at the same place: by the time `checkpoint "record_start"` fires,
the device is in the known state the choreography was authored against.
Choose based on whether the normalization is part of the demo's authored
configuration (option 1) or a separate setup step (option 2).

## Recording lifecycle

The native `ffmpeg` recorder is started + stopped by the agent (it's a shell
script, not a `.mob` action). The `.mob` script bounds the recording WINDOW
inside the longer mp4 via `checkpoint "record_start"` and
`checkpoint "record_stop"` markers - those are how the trim is computed.

### Where the app launch lives - agent's choice

Two valid styles for `app fresh`:

| Style | What the demo opens on | When to pick |
|---|---|---|
| **Launch outside the recording** - `app fresh` + `wait_for` in setup, before `record_start` | Already-loaded app | Default. Cleanest trim, no splash on screen. |
| **Launch inside the recording** - `record_start` first, then a coordinate tap of the app icon | Home screen → tap icon → splash → app appears | Cinematic open. Demonstrates app discovery. |

For the inside-recording style, the device must be on the home screen with
the app icon visible BEFORE the recorder runs the `.mob`. Normalize that
in setup or in an `execute_dsl` pass.

### Lifecycle steps:

1. Start the recorder: `scripts/mobile_record_mjpeg.sh <out> <udid>` (iOS Simulator + physical iOS) or `scripts/mobile_record_android.sh <out>`. The recorder writes:
   - `<out>.pid` - ffmpeg PID for the stop helper
   - `<out>.warmup_ms` - ms ffmpeg slept after start before returning
   - `<out>.start_ts` - wall-clock epoch (with fractional seconds) when ffmpeg launched. `build_timeline.js`'s `--recording <out>` flag picks this up to compute the accurate `recordStartOffsetMs` regardless of how long the agent waits before invoking `test_run`.
2. Wait the warmup (handled by the script's `sleep` - the call returns once the recorder is producing frames).
3. Run the `.mob` with `test_run`.
4. Stop the recorder: `scripts/mobile_record_stop.sh <out>`. This sends SIGINT (so ffmpeg flushes a valid mp4), waits for it to exit, and - for MJPEG sources - post-hoc retimes the mp4 to wall-clock duration via `setpts=ratio*PTS,fps=30`. The retime is needed because MJPEG over HTTP has no per-frame timestamps and MobAI delivers frames in bursts during interactions, so ffmpeg writes a slow-motion video by default. `adb screenrecord` produces wall-clock-accurate mp4s already; running the stop helper against it is harmless (detects no drift and exits without retiming).

Alternatively, MobAI exposes `record_start` / `record_stop` as MCP actions (see `mobai://reference/device-automation` `<screen-recording>`). Those produce a frame-pair recording, not a clean native mp4 - use the shell wrappers for the final take.

## Timeline metadata via comments

Real `.mob` syntax has no `intent:` or `caption:` modifiers on action lines. Instead, attach metadata via **comments preceding each action**:

```mob
# Intent: Start onboarding
# Caption: Start in seconds
tap 184,712
```

The agent builds `timeline.json` by:

1. Parsing the `.mob` source for `# Intent:` and `# Caption:` lines, attaching each to the next non-comment, non-blank action.
2. Running the script via `test_run` and recording per-step elapsed times (relative to `t0` from when the recorder was started).
3. Emitting one `DemoTimelineEvent` per step, with `intent` / `caption` from the comments and `timeMs` from the step timing.

See `references/timeline.md` for the event schema.

## Coordinates throughout the `.mob`

The `.mob` is choreography from a known start state. Smoothness and reproducibility matter more than layout-change robustness, because:

- predicates require a UI-tree lookup per step, which adds latency and shows up as visible stutter on the video;
- the device's screen size is fixed for the take, so a coordinate captured during exploration is stable for this recording;
- if the app layout actually changes between exploration and take, the dry-run (Rule 3) catches it.

State normalization that needs predicates or branching happens outside the `.mob`, in a one-off `execute_dsl` pass before dry-run and before recording. There is no `preflight` or `validate` section in a demo `.mob`.

Coordinate syntax in `.mob` is `tap X,Y` (comma, no space):

```mob
# === recording ===
checkpoint "record_start"

# Intent: Start onboarding
# Caption: Start in seconds
tap 184,712
delay 700

# Intent: Type the project name
tap 161,438
tap 25,740     # shift
delay 80
tap 108,680    # D
delay 80
tap 100,620    # e
```

Do not use `type` in a demo `.mob`. Text entry is represented by key-by-key coordinate taps on the visible keyboard.

## `delay` vs `wait_for` inside the recording window

Both are allowed inside the recording window; pick on a per-action basis:

| Use… | When |
|---|---|
| `delay N` (measured from dry-run) | The visual settle is reliably fixed-length - most iOS animations, scroll momentum, fade-ins. Predictable pacing, no UI-tree cost. |
| `wait_for "Element" timeout:N` | The settle time is variable (network, layout, lazy load) and there's a stable element to anchor on. Exact, but pays a UI-tree fetch. |

Defaults favor `delay` because video pacing is the priority - fixed-length
pauses are smoother to edit and re-time. Reach for `wait_for` only when
the alternative is over-padding a `delay` to cover the worst case
(viewer waiting on a still screen).

If `wait_for` is making the take stutter (heavy UI tree, see caveat in
the previous section), drop it in favor of a `delay` measured from the
dry-run.

```mob
# === recording ===
checkpoint "record_start"

tap 184,712
# Reason: technical - fixed pause measured during exploration
delay 700

tap 190,704
# Reason: viewer_readability
delay 1200

tap 230,500
# variable settle - network load, no fixed value works
wait_for "Inbox" timeout:4000
```

## Use `delay`, not `wait`

Real `.mob` syntax is `delay 1000` (no `reason:` field). Tag the intent in a preceding comment:

```mob
# Reason: viewer_readability - give the viewer time to read the caption
delay 1000
```

The exporter reads `# Reason: technical` vs `# Reason: viewer_readability` from the preceding comment to decide whether the delay is a candidate for speed-up.

## Normalize popups: in the setup section or in a one-off `execute_dsl`

Permission dialogs, login screens, interstitials, and variable list state
are normalized BEFORE `checkpoint "record_start"` - either in the `.mob`'s
own setup section (predicates allowed there) or in an `execute_dsl` pass
the agent runs separately. Pick whichever fits the demo's structure; both
end on the same state by the time the recording window opens.

Do not put `if_exists` or other predicates INSIDE the recording window -
they produce variable pauses and UI-tree stutter that show up on camera.
For state checks that need to live during the recording, prefer a single
`wait_for` (see the caveats earlier) over conditional branching.

## Canonical `.mob` skeleton

```mob
# Tags: demo, smoke
# Device: iPhone 15
# Timeout: 30000
# On-Fail: abort

# === setup ===
# Predicates allowed here: this is OUTSIDE the recording window.
# Use `wait_for` to block until the loaded UI is actually painted -
# `app fresh` returns on IPC, not on the visual relaunch (Springboard
# takes a few seconds on iOS Simulator), and a fixed `delay` is brittle.
app "com.example.app" fresh
wait_for "<expected-element>" timeout:8000

# === recording ===
# Coordinates only. Captured during exploration.
checkpoint "record_start"

# Intent: …
# Caption: …
tap <x>,<y>
# Reason: viewer_readability
delay 800

# Intent: …
tap <x>,<y>            # focus the field
# tap each character on the on-screen keyboard, e.g. for "ab":
tap <key_a_x>,<key_a_y>
delay 60
tap <key_b_x>,<key_b_y>
# Reason: technical
delay 300

# … more actions …

# Trailing settle (1500 ms covers most iOS animations / scroll momentum).
delay 1500
checkpoint "record_stop"
```

See `assets/examples/mobile-onboarding.mob` for a full worked example and `assets/examples/mobile-bug-repro.mob` for the bug-repro variant.

## Recording backends

### iOS (Simulator or physical) → `scripts/mobile_record_mjpeg.sh` (primary)

`scripts/mobile_record_mjpeg.sh <out.mp4> <device_id> [fps=60] [quality=100]` - MobAI HTTP MJPEG stream → ffmpeg mpjpeg demuxer → h264 mp4. Native screen resolution, fully scriptable, no GUI step. Works for both the iOS Simulator (when the MobAI bridge is running) and physical devices.

Writes two sidecars used downstream: `<out>.warmup_ms` and `<out>.start_ts` (wall-clock epoch the moment ffmpeg started). Pair with `scripts/mobile_record_stop.sh <out>` to SIGINT cleanly and post-hoc retime the mp4 to wall-clock duration (MJPEG has no per-frame timestamps and MobAI over-delivers during interactions, which otherwise leaves a slow-motion mp4 with mis-aligned highlights).

**Always pass `quality=100`.** Counter-intuitively, q=100 produces *smaller* output mp4s than lower quality: the ffmpeg re-encode at CRF 18 compresses clean JPEGs much more efficiently than noisy/blocky ones (noise costs bits). So higher source JPEG quality means better picture *and* a smaller final file.

### Android → `scripts/mobile_record_android.sh`

Wraps `adb shell screenrecord` and `adb pull`. Caps at ~3 minutes per call (Android limit), fine for typical demos.

Other recording paths and why we don't use them:

- **`xcrun simctl io booted recordVideo`.** Built into Xcode, but it's a VFR-on-display-invalidation capture: it only emits frames when the screen actually changes. Demo recordings have intentional dwell time (intro holds, post-tap pauses, viewer-readability waits) where the screen is static - simctl drops to ~0 fps during those, producing a frozen-looking video. The MJPEG path delivers frames at a stable cadence regardless of activity, so dwell time plays back smoothly. Not exposed by the skill.

- **QuickTime mirroring + ffmpeg avfoundation.** Would give native-quality H.264. But requires a manual GUI step (QuickTime → New Movie Recording → select iPhone source) for every session - too flaky for a scripted workflow. Order-of-operations also fragile: starting MobAI's bridge after QT is fine, but starting QT after the bridge kicks the device into a USB reconnect that drops the bridge.

- **MobAI `record_start` / `record_stop` MCP actions.** Captures frame pairs, not native mp4. Lower quality than MJPEG-q100. Only use for diagnosing animation/transition issues.

- **iOS on-device screen recording (Control Center toggle).** The recording quality would be best, but there's no scriptable way to (a) trigger the Control Center toggle reliably across iOS versions and (b) pull the resulting `.mov` off the device without `ifuse` or a custom MobAI MCP action. Not in scope today.

Do not fall back to screenshot stitching for the final take.

## Decision tree

```
iOS Simulator (MobAI bridge running)?    → scripts/mobile_record_mjpeg.sh <out> <udid> 60 100
Physical iOS device?                     → scripts/mobile_record_mjpeg.sh <out> <udid> 60 100
Android (physical or emulator)?          → scripts/mobile_record_android.sh
bug_repro demo?                          → post-crash screenshot/diagnostics may be part of the take
List contents variable?                  → normalize outside `.mob`
Unpredictable timing?                    → normalize outside `.mob`, or make it a bug_repro
```
