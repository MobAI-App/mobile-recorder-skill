# Changelog

All notable changes to this skill. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Dates are
ISO-8601.

## [0.1.0] - 2026-05-24

Initial public release. The skill turns a prompt into a polished mobile
demo video by driving MobAI to record iOS / Android, then post-processing
through a Node + ffmpeg pipeline.

### Added

- **MobAI-driven `.mob` choreography**, dry-run, native pixel recording,
  timeline build from `test_run.json` (`startedAtMs` anchors when present).
- **`mobile_record_mjpeg.sh`** as the iOS recorder (MobAI HTTP MJPEG at
  `quality=100`, 30fps CFR after the post-hoc `setpts*PTS,fps=30` retime in
  `mobile_record_stop.sh`). Covers iOS Simulator + physical iOS. Android
  uses `adb shell screenrecord` via `mobile_record_android.sh`.
- **Captions burned in pure JS** (`scripts/lib/text-png.js` +
  vendored `opentype.js`, bundled Inter Bold). `burn_captions.js` renders
  each caption to a PNG and overlays via ffmpeg's standard `overlay`
  filter - no libass / libfreetype dependency.
- **Remotion bridge** (`remotion-template/`): optional React motion-graphics
  path alongside the ffmpeg pipeline. `loadRecording()` turns the recording
  contract (`timeline.json` + `editor.json`) into frame-indexed props;
  components `<RecordingStage>` / `<PhoneBezel>` / `<RecordingCard>` /
  `<Cursor>` / `<TapRipple>` / `<SwipePath>` / `<Caption>` do the
  integration (walking-cursor + ripples + swipe trail are timeline-driven
  in React, no ffmpeg-expression limits). A `speed` knob scales duration
  + event frames and feeds `playbackRate`. The agent writes only the
  creative composition; the user supplies the Remotion runtime
  (`npm install` + headless Chrome).
- **`.start_ts` + `.warmup_ms` sidecars** written by every recorder script;
  `build_timeline.js --recording <path>` picks them up to compute
  `recordStartOffsetMs` accurately regardless of how long the agent waits
  between starting the recorder and `test_run`.
- **`editor.json` v1 schema** for post-production directives. Single source
  of truth alongside the `.mob`, both regenerated together.
  - `trim`, `captions[]`, `highlights[]`, `directives[]` (zoom + speed).
  - Two anchor shapes: `{ line, side }` for single-action spans, `{ fromLine,
    toLine }` for multi-action ranges.
  - **Universal signed-ms `startDelayMs` / `endDelayMs`** on every directive
    (trim, captions, zoom, speed, highlights). Non-destructive timing
    knobs - no re-recording or `.mob` edits required.
  - **`captions[]`** top-level array replaces the legacy `# Caption:` in-mob
    comments as the primary source (comments still work as fallback). Each
    entry takes `fromLine` + (`toLine` + optional `endDelayMs`) OR
    `durationMs`. Caption overlap is a hard error.
  - **`highlights[]`** per-tap ripple / finger anchor tweaks. Use a positive
    `startDelayMs` to push the visual into a long-running tap whose iOS
    response lands well after touch-down.
  - **`pan: [{ afterMs, x, y, ease? }]`** waypoints inside a zoom directive
    fly the camera within one range. Easing modes `linear` / `in` / `out` /
    `in_out`.
- **Walking-cursor finger model** in `add_highlights.js`: finger fades in at
  the previous tap's resting target, slides over `APPROACH = 450 ms` to the
  new target arriving at touch-down, holds through the ripple, fades out.
  First action is a pulse-style fade-in (no prior target). Swipes follow
  the path from `(x, y)` to `(x2, y2)`, then the next slide-in starts from
  `(x2, y2)`. Between actions the finger is fully invisible. Overlapping
  approaches are clamped so two finger sprites never co-exist.
- **Mobile-safe default zoom center**: horizontal canvas center (the phone
  is always centered by `add_frame.js`), vertical clamped so the crop
  window top never goes above the phone's screen-top - the iOS status
  bar stays visible at any zoom. Explicit `x` / `y` on the directive
  override.
- **Per-frame float-precise zoom** via `scale=eval=frame` + bounded `crop`
  (replaces `zoompan`, which rounds x/y to integers per output frame and
  judders at slow pan speeds).
- **Canvas-aspect rule** documented + checked by example: `add_frame.js`'s
  `--canvas WxH` must match the export aspect. Default `1620x2880` for
  `vertical_9_16`, use `2880x1620` for `horizontal_16_9` and `1620x1620`
  for `square_1_1`.
- **`wait_for "Element" timeout:N`** allowed inside the recording window
  alongside coordinate actions - exact synchronization on state changes
  with no fixed-delay guesswork. Heavy UI trees can cause polling
  stutter; fall back to a tuned `delay` measured from the dry-run when
  that happens. (Predicates remain banned in-recording for everything
  else.)
- **Predicates fully allowed in `.mob` setup section** (above
  `checkpoint "record_start"`) - `app fresh`, `wait_for`, `assert_*`,
  `if_exists`. They settle the device into the known start state without
  showing on camera.
- **App-launch placement is the agent's choice**: outside the recording
  (clean start with app pre-loaded, recommended default) OR inside the
  recording (cinematic open from home screen → tap icon → splash → app).
- **`build_timeline.js`** parses `wait_for` lines and emits them as
  `type: "wait"` timeline events with the predicate text in `target` and
  actual elapsed `durationMs` from `test_run.json`.
- **`add_highlights.js`** accepts `editor.json` as optional 4th positional
  - when present, captions are sourced from `editor.captions[]` and
  per-tap delays from `editor.highlights[]`.
- **Two project memory notes** for future agent sessions:
  `app-fresh-ios-relaunch-lag` (use `wait_for`, never magic `delay`) and
  `predicates-in-recording-window` (setup allows everything, recording
  allows `wait_for` plus coordinates).

### Changed

- `add_frame.js` default canvas changed from `2880x1620` (landscape) to
  `1620x2880` (vertical, 1.5x oversample of the default `vertical_9_16`
  export). Pre-fix, the default pipeline produced a small landscape scene
  inside a 1080x1920 padded output.
- `build_timeline.js` `collectStepObjects` tightened: requires `lineText:
  string` plus at least one of `lineNumber` / timing / start-ms fields.
  Step records are treated as leaves so the script doesn't double-count
  parent objects that happen to carry aggregate `durationMs`. Disables
  the sequential fallback's vulnerability to MobAI emitting wrapper
  durations.
- `export_video.js` captions fallback now feeds choreography-ms through
  the loaded `<input>.timewarp.json` (when present) before subtracting
  `dstStart`, so the no-sidecar path matches the propagated-sidecar
  result.
- `add_speedups.js` ffprobe duration parsing switched from `csv=p=0` +
  `Number()` to `default=noprint_wrappers=1:nokey=1` + `parseFloat()`.
  ffprobe's single-field csv output appends a trailing comma that made
  `Number("50.633,")` parse as `NaN` and silently broke re-runs.
- Memory note recommendation evolved from "use `delay 5000` after `app
  fresh`" to "use `wait_for` - magic delays are brittle, predicates in
  setup are exact."

### Fixed

- Pan animation no longer judders at slow velocities (zoompan integer
  rounding replaced by float-precise scale + crop chain).
- Zoom no longer centers on the tap coordinate by default (was visibly
  cutting off the iOS status bar when tap was near the top of the
  phone). New default is horizontal-center + status-bar-safe vertical.
- Pulse-style finger replaced the previous continuous overlay model that
  hovered across the take, so the finger now visibly disappears between
  actions instead of looking like a permanently-present cursor.

### Repo housekeeping

- All em-dashes (`-`) in `.md` / `.js` / `.sh` / `.mob` / `.json` files
  replaced with regular hyphens for consistency with the desktop sibling.
- Repo restructured to `skills/mobile-recorder/{SKILL.md,
  references/, scripts/, assets/}` so install is a single
  `cp -R skills/mobile-recorder ~/.claude/skills/`. Mirrors the
  desktop-recorder-skill layout.
- `LICENSE` (MIT, MobAI), `CONTRIBUTING.md`, `install.md` written for
  open-source release.

[0.1.0]: https://github.com/MobAI-App/mobile-recorder-skill/releases/tag/v0.1.0
