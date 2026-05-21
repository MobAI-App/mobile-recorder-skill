# Mobile workflow (MobAI + `.mob`)

Use this reference when the demo target is a mobile app — iOS Simulator, iOS physical device, or Android.

## Read first

**Always** read the canonical MobAI references before touching a `.mob` file:

- `mobai://reference/testing` — `.mob` script syntax, rules, error fixes
- `mobai://reference/device-automation` — DSL actions, predicates, failure strategies

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
Start native device recording (xcrun simctl / adb screenrecord) OUTSIDE the .mob
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

`.mob` is a **flat** script — there is no literal `section ... end` block. Use heading comments to organize the script and `checkpoint` markers to bracket the recording portion:

```
# === setup ===
# normalize state: launch fresh, dismiss permissions, log in, navigate to start
# === recording ===
checkpoint "record_start"
# … the actions you want in the final video …
checkpoint "record_stop"
```

Only two sections. **No assertions** — see below.

The exporter uses `checkpoint "record_start"` and `checkpoint "record_stop"` to know where the recording portion begins and ends (so it can trim correctly).

## No UI-tree lookups in `.mob` — full allowed/banned list

A demo `.mob` is choreography. Anything that resolves a selector or branches on screen content forces a UI-tree fetch, which slows the take and turns the script into a test. **None of those belong in a demo `.mob`** — neither in `setup` nor in `recording`.

Allowed `.mob` actions:

| Action | Reason it's allowed |
|---|---|
| `app "<bundle>" fresh` | bundle-id launch, no UI lookup |
| `kill_app "<bundle>"` | bundle-id close, no UI lookup |
| `tap X,Y` | coordinate tap |
| `swipe X1,Y1 to X2,Y2` | coordinate swipe |
| `delay N` | timer, no lookup |
| `press_key home\|back\|enter` | hardware key |
| `navigate home` | navigation shortcut |
| `checkpoint "name"` | marker only |
| `screenshot "path"` | dumps current frame |

Banned everywhere in `.mob`:

| Action | Why banned |
|---|---|
| `type ...` (any form) | even `type "text"` is magic text-insertion that no real user does; real users tap keys |
| `assert_*` (`assert_exists`, `assert_not_exists`, `assert_count`, `assert_screen_changed`) | tree lookup; tests, not demos |
| `if_exists { ... } else { ... }` | tree lookup for branching |
| `wait_for "<pred>"` (predicate-based) | tree polling |
| `wait_for stable:true` | not supported in .mob today; until it is, use a fixed `delay` as the trailing settle — see exception below |
| `tap "Text"` / `tap "Text" type:button` / `tap "Text" near "..."` | predicate-based tap |
| `hide_keyboard` | dismiss via tap or swipe on coordinates instead |
| `observe` | full tree dump |
| `scroll down to "<element>"` | predicate-based scroll |
| `extract <key> from "<element>"` | predicate-based read |
| `copy_text "Field"` / `paste_text "Field"` | predicate-based |

### Trailing settle before `record_stop`

`checkpoint "record_stop"` fires the instant the previous action's runtime
finishes — but the screen animation it triggered (slide-in, fade, push,
scroll momentum) often isn't done yet. Without a settle, the final video
freezes mid-transition.

The right tool is `wait_for stable timeout:N`, which polls the UI tree
until it stops changing or `timeout` fires. The DSL JSON form supports
this (`{"action":"wait_for","stable":true,"timeout_ms":N}`), but the
`.mob` script grammar **does not currently parse `wait_for stable`** — it
reads the word "stable" as a predicate text and fails with "element not
found." Tracking with MobAI; until that lands, use a conservative
fixed-length `delay` as the settle:

```mob
swipe 201,650 to 201,300
delay 1800                # viewer_readability — hold on the result
delay 1500                # trailing settle: covers scroll-momentum + nav animations
checkpoint "record_stop"
```

Pick the trailing delay long enough to cover the longest plausible
animation at that point (1500 ms is usually enough for iOS push/pop and
scroll inertia). Don't use `wait_for` with a predicate inside the
recording for any reason — predicates are UI-tree calls and add latency
that shows up as stutter in the video.

When MobAI grows .mob support for `wait_for stable timeout:N`, replace
the trailing fixed `delay` with that — it returns as soon as motion
stops instead of always waiting the full timeout.

### Text input — tap each key on the keyboard

Real users don't paste text. They tap individual keyboard keys. The demo does the same.

During exploration, capture the center coordinate of each key on the app's on-screen keyboard in the locale and orientation the demo uses. Then in the recording section, emit one `tap X,Y` per character (plus shift/123/symbols toggles as needed). A `delay 60` between key taps gives the take a natural typing rhythm.

Example — typing "Test" with the iOS default English keyboard on iPhone (logical coords):

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

For long strings the script becomes verbose — that's fine, it's data, not logic. Generate it from a small helper (e.g. a Python/Node script that maps a target string + a keyboard layout JSON into `tap X,Y` lines) during the explore step and paste the result into the `.mob`.

Coord-capture for the keyboard layout is a one-time job per device/orientation: take one screenshot of the keyboard, mark the center of each key, save as `keyboard-layout-<device>-<lang>.json`. Reuse across all demos for that device.

### Keyboard dismissal — tap or swipe, never `hide_keyboard`

Dismiss the keyboard with the same coordinate-only vocabulary the rest of the take uses:

- tap the keyboard's own Return / Done / Search key at its known coordinate;
- tap a Done / Save button in the nav bar that the app shows above the keyboard (often the same tap that submits the form);
- tap a non-input area of the screen if the app dismisses-on-outside-tap;
- swipe down on the keyboard area if the app supports the gesture.

Choose what the app supports, capture the coordinate during exploration, and write a plain `tap X,Y` or `swipe X1,Y1 to X2,Y2`. Do not use `hide_keyboard`.

## State normalization happens OUTSIDE the `.mob`

Banning `if_exists` means a `.mob` can't gracefully handle "maybe-there's-a-popup" cases. That's fine — it shouldn't have to. Before running the `.mob`, the agent runs a one-off `execute_dsl` pass to:

- close any leftover apps from prior runs
- dismiss first-run popups (`Continue`, `Allow`, `Not Now`, `Skip`, etc.)
- log in if needed
- navigate to the exact screen the `.mob`'s first coordinate tap expects

By the time the recorder starts and the `.mob` runs, the device is in the known state the script was authored against.

## Recording control happens OUTSIDE the .mob

`.mob` scripts have no `record_start` / `record_stop` actions. Native recording is started and stopped by the agent, outside the script:

1. Start the recorder: `scripts/mobile_record_ios_sim.sh <abs-output.mp4>`, `scripts/mobile_record_mjpeg.sh <out> <udid>`, or `scripts/mobile_record_android.sh <out>`. The recorder writes:
   - `<out>.pid` — ffmpeg PID for the stop helper
   - `<out>.warmup_ms` — ms ffmpeg slept after start before returning
   - `<out>.start_ts` — wall-clock epoch (with fractional seconds) when ffmpeg launched. `build_timeline.js`'s `--recording <out>` flag picks this up to compute the accurate `recordStartOffsetMs` regardless of how long the agent waits before invoking `test_run`.
2. Wait the warmup (handled by the script's `sleep` — the call returns once the recorder is producing frames).
3. Run the `.mob` with `test_run`.
4. Stop the recorder: `scripts/mobile_record_stop.sh <out>`. This sends SIGINT (so ffmpeg flushes a valid mp4), waits for it to exit, and — for MJPEG sources — post-hoc retimes the mp4 to wall-clock duration via `setpts=ratio*PTS,fps=30`. The retime is needed because MJPEG over HTTP has no per-frame timestamps and MobAI delivers frames in bursts during interactions, so ffmpeg writes a slow-motion video by default. simctl and adb produce wall-clock-accurate mp4s already, but running the stop helper against them is harmless (it detects no drift and exits without retiming).

Alternatively, MobAI exposes `record_start` / `record_stop` as MCP actions (see `mobai://reference/device-automation` `<screen-recording>`). Those produce a frame-pair recording, not a clean native mp4 — use the shell wrappers for the final take.

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

## Use fixed `delay`, not `wait_for`

MobAI's testing rule is to put a `wait_for` before every interaction. For demo choreography, use **measured `delay`** instead:

- a `wait_for` introduces variable-length pauses (depending on how fast the previous action finished) — bad for video pacing;
- a `delay` is a fixed pause you tuned during exploration — predictable and editable.

Do not use `wait_for` in a demo `.mob`. If timing is genuinely unpredictable, normalize or preload the state outside the `.mob`, or make the flow a `bug_repro` where the variable wait is part of what the video demonstrates.

```mob
# === recording ===
checkpoint "record_start"

tap 184,712
# Reason: technical — fixed pause measured during exploration
delay 700

tap 190,704
# Reason: viewer_readability
delay 1200
```

## Use `delay`, not `wait`

Real `.mob` syntax is `delay 1000` (no `reason:` field). Tag the intent in a preceding comment:

```mob
# Reason: viewer_readability — give the viewer time to read the caption
delay 1000
```

The exporter reads `# Reason: technical` vs `# Reason: viewer_readability` from the preceding comment to decide whether the delay is a candidate for speed-up.

## Normalize popups outside the `.mob`

Use `execute_dsl` with predicates, screenshots, OCR, and conditional agent logic before the `.mob` runs. Dismiss permission dialogs, login screens, interstitials, and variable list state there, then start the deterministic `.mob` only once the device is on the exact screen the first coordinate expects.

Do not put `if_exists` in the `.mob` — it produces variable pauses on retry and turns the demo script into a test.

## Canonical `.mob` skeleton

```mob
# Tags: demo, smoke
# Device: iPhone 15
# Timeout: 30000
# On-Fail: abort

# === setup ===
# Coordinate-only launch/wait setup. Predicate-based normalization already ran
# via execute_dsl before this file.
app "com.example.app" fresh
delay 1500

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

`scripts/mobile_record_mjpeg.sh <out.mp4> <device_id> [fps=60] [quality=100]` — MobAI HTTP MJPEG stream → ffmpeg mpjpeg demuxer → h264 mp4. Native screen resolution, fully scriptable, no GUI step. Works for both the iOS Simulator (when the MobAI bridge is running) and physical devices.

Writes two sidecars used downstream: `<out>.warmup_ms` and `<out>.start_ts` (wall-clock epoch the moment ffmpeg started). Pair with `scripts/mobile_record_stop.sh <out>` to SIGINT cleanly and post-hoc retime the mp4 to wall-clock duration (MJPEG has no per-frame timestamps and MobAI over-delivers during interactions, which otherwise leaves a slow-motion mp4 with mis-aligned highlights).

**Always pass `quality=100`.** Counter-intuitively, q=100 produces *smaller* output mp4s than lower quality: the ffmpeg re-encode at CRF 18 compresses clean JPEGs much more efficiently than noisy/blocky ones (noise costs bits). So higher source JPEG quality means better picture *and* a smaller final file.

### iOS Simulator → `scripts/mobile_record_ios_sim.sh` (no-MobAI fallback)

Wraps `xcrun simctl io booted recordVideo`. Starts in the background, writes a PID file, returns immediately. Use this only when MobAI isn't available — it produces a VFR mp4 (~23-25fps avg, codec dependent on simctl version). Writes `.warmup_ms` and `.start_ts` sidecars so `build_timeline.js` can use the preferred `recordStartOffsetMs` path.

### Android → `scripts/mobile_record_android.sh`

Wraps `adb shell screenrecord` and `adb pull`. Caps at ~3 minutes per call (Android limit), fine for typical demos.

Other recording paths and why we don't use them as primary:

- **QuickTime mirroring + ffmpeg avfoundation.** Would give native-quality H.264. But requires a manual GUI step (QuickTime → New Movie Recording → select iPhone source) for every session — too flaky for a scripted workflow. Order-of-operations also fragile: starting MobAI's bridge after QT is fine, but starting QT after the bridge kicks the device into a USB reconnect that drops the bridge.

- **MobAI `record_start` / `record_stop` MCP actions.** Captures frame pairs, not native mp4. Lower quality than MJPEG-q100. Only use for diagnosing animation/transition issues.

- **iOS on-device screen recording (Control Center toggle).** The recording quality would be best, but there's no scriptable way to (a) trigger the Control Center toggle reliably across iOS versions and (b) pull the resulting `.mov` off the device without `ifuse` or a custom MobAI MCP action. Not in scope today.

Do not fall back to screenshot stitching for the final take.

## Decision tree

```
iOS Simulator (MobAI bridge running)?    → scripts/mobile_record_mjpeg.sh <out> <udid> 60 100
iOS Simulator (no MobAI)?                → scripts/mobile_record_ios_sim.sh <abs-out>
Physical iOS device?                     → scripts/mobile_record_mjpeg.sh <out> <udid> 60 100
Android (physical or emulator)?          → scripts/mobile_record_android.sh
bug_repro demo?                          → post-crash screenshot/diagnostics may be part of the take
List contents variable?                  → normalize outside `.mob`
Unpredictable timing?                    → normalize outside `.mob`, or make it a bug_repro
```
