# mobile-recorder-skill

Claude Code skill that turns a prompt into a reproducible mobile-app demo video. The agent explores the app, writes a deterministic `.mob` choreography script, records a clean take via MobAI, and runs a Node + ffmpeg pipeline that adds tap highlights, frames the recording in a phone bezel + background, applies zoom/speed/trim from a sidecar `editor.json`, and exports to standard social formats.

For desktop/web demos, use the sibling `desktop-recorder-skill`.

## Install

This is a Claude Code skill. Drop the folder into your skills directory (or install via your plugin marketplace) and the agent will load `SKILL.md` automatically when a user asks to record a mobile demo. See `SKILL.md` for the canonical agent rules; this README is for developers maintaining the scripts.

## Pipeline

```
record    →  mobile_record_mjpeg.sh        # → demo.raw.mp4 (+ .start_ts, .warmup_ms, .pid sidecars)
stop      →  mobile_record_stop.sh         # SIGINT + post-hoc retime for MJPEG
timeline  →  build_timeline.js             # .mob + test_run.json → timeline.json
highlights→  add_highlights.js             # tap ripples, moving-finger, swipe trail → demo.hl.mp4
frame     →  add_frame.js                  # bezel + bg composite → demo.framed.mp4 (+ .frame.json)
zoom      →  add_zoom.js                   # ffmpeg zoompan on composite → demo.hlz.mp4
speedups  →  add_speedups.js               # warp segments → demo.hlzs.mp4 (+ .timewarp.json)
export    →  export_video.js               # trim + scale + pad → demo.vertical.mp4
captions  →  burn_captions.js              # optional libass burn-in
copy      →  generate_copy.js              # title / post / Shorts / thumbnail
```

Each stage propagates a `*.captions.json` sidecar in the appropriate time space (recording, post-warp, or trimmed). The shared resolver is `scripts/lib/editor.js` (loads timeline + editor.json, resolves line directives, probes fps).

## Recording backends

| Target | Script | Backend | Notes |
|---|---|---|---|
| iOS Simulator | `mobile_record_mjpeg.sh` | MobAI HTTP MJPEG q=100 (primary) | 30fps CFR after retime, writes `.start_ts` for accurate `recordStartOffsetMs`. |
| iOS Simulator | `mobile_record_ios_sim.sh` | `xcrun simctl io recordVideo` (no-MobAI fallback) | Still works (verified May 2026). VFR (~23-25fps avg). Writes `.start_ts` at spawn time, accurate to one IPC roundtrip. |
| iOS physical device | `mobile_record_mjpeg.sh` | MobAI HTTP MJPEG q=100 | simctl unavailable for physical devices. |
| Android | `mobile_record_android.sh` | `adb shell screenrecord` + `adb pull` | Caps at ~3 minutes per call. |

The polished workflow is MJPEG-centric: the `mobile_record_stop.sh` helper does a post-hoc `setpts*PTS,fps=30` retime when the captured mp4 is more than 5% longer than wall-clock (MobAI over-delivers MJPEG frames during interactions and ffmpeg has no per-frame timestamps from the multipart stream). simctl/adb produce wall-clock-accurate mp4s; running the stop helper against them is a no-op.

## Requirements

- macOS or Linux. The pipeline shells out heavily.
- `ffmpeg` and `ffprobe` with libass (Homebrew default ships both).
- `node` >= 16.
- `jq` for the recorder shell scripts.
- MobAI desktop app with the bridge started, for the MJPEG path (primary) and `test_run` orchestration.
- Xcode Command Line Tools (`xcrun`) only if you fall back to `mobile_record_ios_sim.sh`.
- Android platform-tools (`adb`) only for the Android path.

Each recording script checks its own dependencies at runtime.

## Known quirks

- `xcrun simctl io recordVideo` requires an **absolute** output path; relative paths fail with a misleading "SimRenderServer error 2". `mobile_record_ios_sim.sh` resolves to absolute automatically.
- The MJPEG endpoint must be called with `quality=100`. Counter-intuitively this produces *smaller* final mp4s than lower quality, because clean JPEGs re-encode through H.264 (CRF 18) more efficiently than noisy ones. `mobile_record_mjpeg.sh` defaults to 100.
- MobAI's MJPEG stream has no per-frame timestamps and over-delivers during interactions. Without `mobile_record_stop.sh` retime, you get a slow-motion mp4 and highlights drift off the actions.
- `build_timeline.js` needs `--recording <path>` to pick up `.start_ts` + `.warmup_ms` sidecars. Without it the builder falls back to `warmup + sum(setup-step durations)`, which is wrong by however many seconds elapsed between the recorder starting and `test_run` actually firing.
- ffmpeg's `geq` filter does not recognize `and()` / `or()` / `not()` as functions; we encode booleans via arithmetic (`AND` = product, `OR` = `gt(sum, 0)`, `NOT` = `1 - x`). See the helpers in `scripts/add_frame.js`.
- ffmpeg's `alphamerge` defaults to `shortest=0`; with a looped PNG mask it emits frames forever. Always pass `shortest=1`.
- The frame canvas aspect must match the export aspect (the exporter pads rather than crops). Default canvas is 1620x2880 (vertical 9:16, 1.5x the 1080x1920 export); change `--canvas` if you target horizontal or square.

## Development

The scripts are independent CLIs; each can be invoked directly without going through the agent. To iterate without the full agent flow, record a short take yourself and run the stages by hand against the resulting files:

```bash
# 1. Record (MobAI bridge running, simulator booted):
scripts/mobile_record_mjpeg.sh /tmp/demo.raw.mp4 <udid> 60 100
# … run your .mob via MobAI's test_run, save the JSON output to /tmp/test_run.json …
scripts/mobile_record_stop.sh /tmp/demo.raw.mp4

# 2. Build the timeline + run the pipeline:
node scripts/build_timeline.js path/to/demo.mob /tmp/test_run.json \
     /tmp/timeline.json --scale 3 --recording /tmp/demo.raw.mp4

node scripts/add_highlights.js /tmp/demo.raw.mp4 /tmp/timeline.json /tmp/demo.hl.mp4

node scripts/add_frame.js /tmp/demo.hl.mp4 /tmp/demo.framed.mp4 \
     --bg-gradient 1f2937:6b21a8

node scripts/export_video.js /tmp/demo.framed.mp4 /tmp/timeline.json \
     path/to/editor.json /tmp/demo.vertical.mp4 vertical_9_16
```

Editor + zoom + speedup stages are optional and slot in between `add_frame` and `export_video` (see [`references/editing.md`](./references/editing.md) for the full ordering).

`build_timeline.js --validate <timeline.json>` runs the timeline invariants check without rebuilding.

`references/` holds the long-form rules consumed by the agent (`mobile.md`, `timeline.md`, `editor.md`, `editing.md`). Keep them in sync when behavior changes. Worked examples and templates live under `assets/examples/` and `assets/templates/`.

## License

MIT (c) MobAI. See [LICENSE](./LICENSE).
