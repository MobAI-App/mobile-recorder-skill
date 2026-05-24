# Editing & export

The final demo video is produced from four inputs:

- `demo.raw.mp4` - the native recording, untouched
- `timeline.json` - every action that happened during `record_start → record_stop`, with a `line` field that joins back to the `.mob` source
- `editor.json` - post-production directives (zoom / speed / trim), anchored by `.mob` line. See [`editor.md`](./editor.md) for the schema
- the `.mob` itself - referenced indirectly through `timeline.json`

The agent does not improvise during editing. Each operation is derived from
the timeline + directives.

## Pipeline

```bash
node scripts/build_timeline.js demo.mob test_run.json timeline.json \
     --scale 3 --recording demo.raw.mp4
node scripts/add_highlights.js demo.raw.mp4    timeline.json demo.hl.mp4 editor.json
node scripts/add_frame.js      demo.hl.mp4     demo.framed.mp4 \
     [--canvas WxH] [--bg-gradient TOP:BOT | --bg-image PATH | --bg-color RRGGBB]
node scripts/add_zoom.js       demo.framed.mp4 timeline.json editor.json demo.hlz.mp4
node scripts/add_speedups.js   demo.hlz.mp4    timeline.json editor.json demo.hlzs.mp4
node scripts/export_video.js   demo.hlzs.mp4   timeline.json editor.json demo.vertical.mp4 vertical_9_16
```

`add_highlights.js` accepts `editor.json` as an optional 4th positional -
pass it so captions come from `editor.captions[]` (preferred) and per-line
tweaks from `editor.highlights[]` apply. Without it, captions fall back to
`.mob` `# Caption:` comments.

The `--recording demo.raw.mp4` flag on `build_timeline.js` is required when
you want highlights to align with the visible UI - it pulls the warmup +
`start_ts` sidecars and computes `recordStartOffsetMs` from MobAI's
wall-clock anchors. Without it, the builder falls back to summing setup
step durations, which is off by however many seconds elapsed between the
recorder starting and `test_run` actually firing.

Ordering matters:

1. **highlights** burns the tap ripple + **walking-cursor finger** overlay
   onto the recording (still in recording-pixel space) and writes
   `<out>.captions.json` in raw-recording time. The finger fades in at the
   *previous* tap's target, slides across to the new target arriving at
   touch-down, holds through the ripple, then fades out - finger is
   invisible between actions. First action is a pulse-style fade-in at the
   target (no prior position). Swipes follow the path from `(x,y)` to
   `(x2,y2)` over the swipe's `durationMs`.
2. **frame** composites the highlighted recording inside a phone-bezel +
   background canvas (default 1620×2880 - vertical 9:16, 1.5× the export
   size so zoom stays sharp). Everything downstream operates in the
   composite-pixel space. Writes a `<out>.frame.json` sidecar that
   downstream stages read. **Canvas aspect must match the export aspect**
   (`export_video.js` pads rather than crops); change `--canvas` if you
   target horizontal or square output.
3. **zoom** runs **`scale=eval=frame` + bounded `crop`** on the composite -
   float-precise per-frame eval (NOT `zoompan`, which rounds x/y to
   integers per frame and judders at slow pan velocities). "Zoom" means
   the whole framed scene scales up, not "crop into the screen content."
   Default center is canvas horizontal-center + vertical-clamped so the
   phone status bar stays visible at any zoom level (override with
   explicit `x`/`y` in canvas pixels on the directive). Multi-action
   `fromLine/toLine` ranges hold at peak across actions; optional `pan:
   [{afterMs, x, y, ease}]` waypoints fly the camera within the range.
4. **speedups** re-times frames with `trim + setpts/{factor} + concat`;
   emits `<out>.timewarp.json` and remaps `<input>.captions.json` through the
   warp. Only spans explicitly named by editor.json directives are sped -
   nothing is auto-detected.
5. **export** trims by `editor.trim` (or first/last action by default), maps
   trim points through `<input>.timewarp.json` if present, scales + pads to
   the target format, and writes a captions sidecar in trimmed-video time.

Every stage **preserves the source's actual frame rate** (probed via
`nb_frames / duration`, then enforced as CFR through the encode). No
silent upsample/downsample, no duplicated frames creating uneven motion.

This matters because some captures (incl. simctl-produced mp4s if you bring
your own) report a bogus container `r_frame_rate` (e.g. `600/1`); without
probing, the overlay+loop filtergraph collapses to ~4 fps. The shared
`probeFps(input)` helper in `scripts/lib/editor.js` is what each stage uses
to compute the right rate.

Recording source: `mobile_record_mjpeg.sh` at fps=60. MobAI's HTTP MJPEG
stream caps at 60 fps and the chain rides that through to the export.

Skip any of zoom/speedups by skipping its invocation and feeding the
previous output to the next stage.

## Operations summary

| Step | What it does | Source of truth |
|---|---|---|
| Trim head | drop frames before `editor.trim.fromLine` (or first action). Honors `startDelayMs`. | `editor.json` + `timeline.json` |
| Trim tail | drop frames after `editor.trim.toLine` end + 600 ms (or last action). Honors `endDelayMs`. | `editor.json` + `timeline.json` |
| Speed up spans | `{kind:"speed", ..., factor, startDelayMs?, endDelayMs?}` - all explicit | `editor.json` |
| Zoom (+ optional pan) | `{kind:"zoom", fromLine, toLine, scale, x?, y?, pan?[], startDelayMs?, endDelayMs?, rampMs?}` | `editor.json` |
| Tap ripple + walking finger | one ripple per `tap` (anchored at startedAtMs + per-line `highlights[].startDelayMs`), finger slides from previous target to current | `timeline.json` + `editor.highlights[]` |
| Captions sidecar | `editor.captions[]` (preferred) with per-caption `startDelayMs`/`endDelayMs`/`durationMs`/`toLine`; falls back to `.mob` `# Caption:` comments | `editor.json` |
| Letterbox / crop | fit to `vertical_9_16` / `horizontal_16_9` / `square_1_1` | export arg |
| H.264 encode | yuv420p, no audio | export |

## Highlight rules

- Tap → soft circular ripple, ~11% of the recording's short edge in diameter.
- **Walking-cursor finger** (NOT a persistent overlay):
  - First action: finger fades in at the target (`PULSE_PRE` = 120 ms),
    holds through the ripple (`PULSE_HOLD` = 300 ms past touch-down),
    fades out (`PULSE_FADE` = 250 ms).
  - Each subsequent action: finger fades in at the *previous* action's
    resting target, slides linearly over `APPROACH` = 450 ms to the new
    target arriving at touch-down, holds, fades out.
  - Swipes: after slide-in arrival at `(x, y)`, the finger animates to
    `(x2, y2)` over the swipe's `durationMs`, then holds at `(x2, y2)`
    and fades. The next slide-in starts from `(x2, y2)`.
  - Between actions the finger is fully invisible. If two actions are so
    close that fade-out and fade-in would overlap, the next overlay's
    approach is clamped to start at the previous overlay's enable end -
    two finger sprites are never visible simultaneously.
- The radiant ripple plays on top of the finger at each landing.
- Per-tap anchor tweaks live in `editor.highlights[]` - see editor.md.
  Use a positive `startDelayMs` to push the ripple+finger arrival deeper
  into a long tap action whose visual response lands well after
  touch-down.
- Never use the iOS system touch indicator in the final export - custom
  highlights look better and are visually consistent across iOS versions.

## Caption rules

- short - under 6 words by default
- one caption visible at a time
- bottom third of the frame; move to top third only if a caption overlaps a
  critical UI element
- captions are editable - `add_highlights.js` and `export_video.js` emit
  `captions.json` sidecars that humans can tweak between stages
- font: system sans-serif, weight 700, 56 px at 1080-wide vertical, scaled
  proportionally for other formats

`captions.json` schema:

```json
[
  { "startMs": 320,  "endMs": 2620, "text": "Start in seconds" },
  { "startMs": 2620, "endMs": 4400, "text": "Create your first project" },
  { "startMs": 4400, "endMs": 6340, "text": "Done" }
]
```

Sidecars produced by each stage:

- `demo.hl.captions.json` - written by `add_highlights.js`, in
  **raw-recording time** (matches `demo.hl.mp4`).
- `demo.hlz.captions.json` - propagated through zoom unchanged (geometry
  doesn't move text in time).
- `demo.hlzs.captions.json` - remapped by `add_speedups.js` through the
  timewarp; matches `demo.hlzs.mp4` post-speed.
- `demo.vertical.captions.json` - written by `export_video.js` in
  **trimmed-video time** (trim head subtracted from the post-warp sidecar).
  This is the user-facing one.

### Burning captions into the final mp4

Captions ship as a sidecar by default so they're easy to hand-edit between
passes. To bake them into the pixels, run `scripts/burn_captions.js` against
the final export and its trimmed-video-time sidecar:

```bash
node scripts/burn_captions.js demo.vertical.mp4 demo.vertical.captions.json demo.vertical.captioned.mp4
```

The script converts the sidecar to a temp `.ass` (Advanced SubStation Alpha)
file and runs `ffmpeg -vf subtitles=...`, which uses libass for layout.
Flags: `--font-size`, `--margin-v`, `--font-name`, `--primary`, `--outline`.
Defaults are tuned for 1080×1920 vertical (56 px Helvetica-Bold, 8% bottom
margin, 3 px outline).

If you'd rather burn manually, the underlying ffmpeg invocation is:

```bash
# 1. Convert demo.vertical.captions.json → captions.srt (any small script).
# 2. Burn via libass:
ffmpeg -i demo.vertical.mp4 \
  -vf "subtitles=captions.srt:force_style='Alignment=2,FontName=Helvetica-Bold,FontSize=56,PrimaryColour=&H00FFFFFF,BorderStyle=1,Outline=3,Shadow=0,MarginV=160'" \
  -c:v libx264 -crf 18 -preset veryfast -pix_fmt yuv420p \
  -movflags +faststart \
  demo.vertical.captioned.mp4
```

`force_style` overrides take ASS keys (`Alignment=2` is bottom-center).
Requires an ffmpeg build with libass - `ffmpeg -filters | grep subtitles`
should list `subtitles  Render text subtitles onto input video using the
libass library.` Homebrew's default `ffmpeg` includes it.

## Export formats

```yaml
vertical_9_16:    { width: 1080, height: 1920 }
horizontal_16_9:  { width: 1920, height: 1080 }
square_1_1:       { width: 1080, height: 1080 }
```

Default → `vertical_9_16` (mobile). The user may override.

## Time math

Three coordinate systems show up:

| Space | Meaning | Where it lives |
|---|---|---|
| choreography ms | ms since `record_start` checkpoint | `timeline.json`, `editor.json` directive resolution |
| raw-recording seconds | seconds since the first frame of the raw mp4 | `add_zoom.js`, `add_speedups.js`, `add_highlights.js` |
| trimmed-video seconds | seconds since the first frame of the exported mp4 | the final captions sidecar |

Conversions:
- choreography ms → raw seconds: `(t + recordStartOffsetMs) / 1000`
- raw seconds → post-speed seconds: piecewise map via `<file>.timewarp.json`
- post-speed seconds → trimmed seconds: subtract `dstStart`

`lib/editor.js` handles the first conversion; `add_speedups.js` emits the
timewarp; `export_video.js` does the final shift.

## ffmpeg primitives used by the export script

For reference:

- Trim: `ffmpeg -ss <start> -to <end> -i raw.mp4 -c copy trimmed.mp4`
- Speed up a segment: `ffmpeg -i seg.mp4 -filter:v "setpts=PTS/3" sped.mp4`
- Concat: `ffmpeg -filter_complex "[0:v]trim=...,setpts=(PTS-STARTPTS)/F[s];... concat=n=N:v=1:a=0"`
- Crop + scale: `ffmpeg -i in.mp4 -vf "scale=...,pad=...,setsar=1" out.mp4`
- Zoom: `ffmpeg -i in.mp4 -vf "zoompan=z='...':x='...':y='...':d=1:s=WxH:fps=F" out.mp4`

## copy.md generation

`node scripts/generate_copy.js timeline.json prompt.txt copy.md` - reads
scene captions / intents from the timeline and produces title / short post /
Shorts title / thumbnail text. Hand-rewrite as needed.
