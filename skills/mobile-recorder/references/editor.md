# editor.json - post-production directives

The `.mob` script owns choreography - it's what MobAI replays during the take.
`editor.json` owns post-production: captions, where to zoom, what spans to
speed up, where to trim, and per-line highlight tweaks. Both files live in
the same demo folder; they're regenerated together by the agent.

Every directive references `.mob` source lines by number. `build_timeline.js`
emits `line` on every timeline event, so the editing scripts can join the
two. Mirrors the desktop sibling's screenplay model (action IDs there;
line numbers here - same idea).

## Schema (v1)

```jsonc
{
  "schema_version": 1,

  // ----- trim ----------------------------------------------------------
  // Half-open range of the .mob that ends up in the final mp4.
  // Default: first action → last action end + 600 ms tail pad.
  "trim": {
    "fromLine":     22,    // optional, default = first action
    "toLine":       67,    // optional, default = last action + 600 ms
    "startDelayMs": -200,  // optional, signed ms shift on the head
    "endDelayMs":    0,    // optional, signed ms shift on the tail
    "headPadMs":     0,    // optional, extra ms pulled back from tStart
    "tailPadMs":     0     // optional, extra ms past tEnd
  },

  // ----- captions ------------------------------------------------------
  // Top-level array of overlay text spans. Same anchor shape as zoom/speed.
  // Each entry takes either `toLine` (+ optional `endDelayMs`) OR
  // `durationMs`. Captions may NOT overlap in time (single shared strip).
  "captions": [
    { "text": "Open the dashboard", "fromLine": 22, "toLine": 26, "endDelayMs": -400 },
    { "text": "Filter the list",    "fromLine": 32, "startDelayMs": -300, "toLine": 38, "endDelayMs": -400 },
    { "text": "Save",               "fromLine": 50, "startDelayMs": -300, "durationMs": 2800 }
  ],

  // ----- per-line highlight tuning -------------------------------------
  // Shifts the ripple + walking-finger arrival on a specific tap line by
  // `startDelayMs` (signed). Use sparingly - for individual taps whose
  // visual response lags the touch-down (long iOS view transitions).
  "highlights": [
    { "line": 26, "startDelayMs": 500 }
  ],

  // ----- directives (zoom + speed) -------------------------------------
  "directives": [
    // Multi-action zoom range with pan waypoints (preferred when several
    // actions live near each other - no unzoom-rezoom dip between).
    {
      "kind": "zoom",
      "fromLine": 26, "toLine": 44,
      "startDelayMs": -200, "endDelayMs": 300,
      "scale": 1.5,
      "x": 1440, "y": 540,             // canvas-pixel center (composite space)
      "rampMs": 300,
      "pan": [
        { "afterMs": 3200, "x": 1440, "y": 700, "ease": "in_out" },
        { "afterMs": 6500, "x": 1440, "y": 540, "ease": "in_out" }
      ]
    },

    // Single-action zoom (legacy shape, still supported).
    { "kind": "zoom", "line": 76, "side": "during", "scale": 2.0, "windowMs": 1500 },

    // Speed segments (always explicit - no auto pass).
    { "kind": "speed", "line": 78, "side": "during", "factor": 6.0,
      "startDelayMs": 0, "endDelayMs": 0 },
    { "kind": "speed", "fromLine": 80, "toLine": 84, "factor": 3.0 }
  ]
}
```

## Delays (the universal knob)

Every directive - zoom, speed, captions, trim, highlights - accepts signed
`startDelayMs` / `endDelayMs` ms offsets. Positive = later, negative = earlier.
This is how the agent tunes timing without re-recording or moving `.mob` lines:

- Caption feels late after a tap? `startDelayMs: -300` makes it arrive
  300 ms BEFORE the anchored action fires.
- Zoom should hold a bit longer past the last action? `endDelayMs: 300`.
- A specific tap's visual response lags the touch-down (long iOS view
  transition)? Add `{ "line": N, "startDelayMs": 400 }` to `highlights[]`
  to push the ripple + finger arrival into the action.

Always reach for delays before changing the `.mob` or rerecording - they
are non-destructive and re-orderable.

## Anchor shapes

Most directives accept either:

| Shape | Use |
|---|---|
| `{ line, side }` | Single-action span (`before` / `during` / `after`). `during` on a tap is zero-width - pair with `windowMs`. |
| `{ fromLine, toLine }` | Half-open range from `fromLine.tStart` to `toLine.tStart`. For zoom, holds at peak the whole range - no dip between actions. |

`fromLine`/`toLine` is the preferred shape for any directive that covers more
than one action. Always pair with `startDelayMs` / `endDelayMs` if you need to
shave or extend the endpoints.

## `kind: zoom`

Zoom operates on the **framed composite** (after `add_frame.js`), not the raw
recording. So `scale: 1.5` means the entire phone-bezel-on-background scene
gets 1.5× larger (camera moves closer to the phone), not "zoom into the
screen content."

### Default center

The default is **NOT the tap coordinate**. It's:

- Horizontally: canvas center (the phone is always centered by `add_frame.js`).
- Vertically: clamped so the **top of the crop window never goes above the
  phone's screen-top** - the iOS status bar stays visible at any zoom.

This means a tap near the top of the phone won't push the crop above the
canvas. Override with explicit `x`, `y` (in composite/canvas pixels) when you
want a different framing - e.g. zoom on the bottom half:

```jsonc
{ "kind": "zoom", "fromLine": 50, "toLine": 56, "scale": 1.6, "x": 1440, "y": 1100 }
```

The legacy `center: { x, y }` form still works.

### Pan within a zoom range

To fly the camera through several focal points within one zoom segment,
add a `pan` array. Each waypoint is `{ afterMs, x, y, ease? }`:

```jsonc
{
  "kind": "zoom",
  "fromLine": 26, "toLine": 44, "scale": 1.5,
  "x": 1440, "y": 540,
  "pan": [
    { "afterMs": 3200, "x": 1440, "y": 700, "ease": "in_out" },
    { "afterMs": 6500, "x": 1440, "y": 540 }
  ]
}
```

- `afterMs` is **absolute** relative to the post-delay segment start
  (`fromLine.tStart + startDelayMs`), NOT cumulative.
- Camera holds at the entry's `(x, y)` until the first waypoint, eases through
  each, then holds at the last position until segment end.
- `ease`: `linear` / `in` / `out` / `in_out` (default `in_out`).
- Waypoint coords are in composite/canvas pixels - same space as the entry's
  `x` / `y`.
- Validation: `afterMs` must be strictly increasing and less than the range
  duration. Out-of-range or out-of-order waypoints are a hard error.

Use `pan` for cinematic sweeps across a busy UI; use a static `x`/`y` (no
`pan`) for a steady held shot.

### Continuity

Two separate zoom directives that touch in time both ramp at the join - the
A directive ramps out, B ramps in, so the camera visibly un-zooms and
re-zooms. To keep one continuous camera across actions, write **one**
`fromLine/toLine` directive that spans all of them and use `pan` (or a
static center) to change focus inside.

### Implementation

Per-frame float-precise `scale=eval=frame` + bounded `crop`. Both expressions
evaluate in float, so sub-pixel pan motion comes out smooth - none of
zoompan's integer-rounding judder.

### Zero-width spans

`side: during` on a `tap` resolves to zero duration. `add_zoom.js` rejects
that with an explicit error. Fix one of:

- anchor on a `wait` / `swipe` line that has duration (and use `side: during`)
- pick a `side` that has a real gap around the action (`before` / `after`)
- set `windowMs` to center an explicit window on the resolved midpoint
- switch to `fromLine/toLine`

Overlapping zoom segments are also a hard error.

## `kind: speed`

```jsonc
{ "kind": "speed", "line": 78, "side": "during", "factor": 6.0 }
{ "kind": "speed", "fromLine": 80, "toLine": 84, "factor": 3.0,
  "startDelayMs": 0, "endDelayMs": 0 }
```

Every speed segment is explicit - there is no auto pass. To compress all
`reason: "technical"` waits, emit one `{kind:"speed", line, side:"during",
factor: N}` per wait line. `viewer_readability` waits stay at real time.

Validation: `factor > 0` and `!= 1`. Overlapping speed envelopes (post-delay)
are a hard error.

## Captions (top level array)

Captions are a top-level `captions[]` array, NOT a `.mob` `# Caption:`
comment. Each entry:

```jsonc
{
  "text":         "Filter the list",       // required
  "fromLine":     32,                       // required (or alias `line`)
  "startDelayMs": -300,                     // optional, signed ms
  "toLine":       38,                       // either this …
  "endDelayMs":   -400,                     //   (optional, with toLine)
  "durationMs":   1800                      // … or this (mutually exclusive)
}
```

Why a top-level array (vs. the older `.mob` `# Caption:` comments):
- Captions get explicit start/end anchors and signed offsets, instead of
  "from this action to the next captioned action."
- Re-timing one caption doesn't ripple across the others.
- Mirrors desktop-recorder-skill's screenplay format so the agent can use
  the same mental model on both.

Legacy fallback: if `editor.captions` is absent OR empty, `add_highlights.js`
and `export_video.js` derive captions from `.mob` `# Caption:` comments
(each captioned action runs until the next captioned action or `record_stop`).
Prefer the array.

Validation: entries may not overlap in time (single shared bottom strip) -
overlap is a hard error pointing at the offending pair. Tune with
`startDelayMs` / `endDelayMs` / `durationMs` to separate them.

## Highlights (per-line anchor tweaks)

```jsonc
"highlights": [
  { "line": 26, "startDelayMs": 500 }
]
```

Shifts the ripple + walking-finger arrival on `line 26`'s action by 500 ms
(positive = later). Useful when one specific tap triggers a long iOS view
transition and the visual response lands after touch-down - without this,
the highlight reads as firing before the screen actually reacts.

Unlisted lines get a 0 ms shift. Only `startDelayMs` is consumed today; no
`endDelayMs` / `durationMs` here because the finger's hold-and-fade are
constants in `add_highlights.js`, not per-tap.

## Trim

```jsonc
"trim": { "fromLine": 22, "toLine": 67, "startDelayMs": -200 }
```

- `fromLine`: head cut at this action's choreography start (default: first
  action). `startDelayMs` shifts the cut by a signed ms.
- `toLine`: tail cut at this action's end + 600 ms (default: last action +
  600 ms). `endDelayMs` shifts the cut.
- `headPadMs` / `tailPadMs`: legacy extra-pad shorthand - same effect as
  `startDelayMs` (negative) / `endDelayMs` (positive).

Both are choreography-time markers; `export_video.js` adds
`recordStartOffsetMs` to translate to raw-recording time, then maps through
`<input>.timewarp.json` if a speedup pass produced one.

Trim auto-extends the head to include any `fromLine/toLine` zoom's ramp-in
if the ramp would otherwise land in the trimmed-off region - so a zoom
that starts before the first kept action still rises into view.

## End-to-end pipeline

```bash
node scripts/build_timeline.js demo.mob test_run.json timeline.json --scale 3 --recording demo.raw.mp4
node scripts/add_highlights.js demo.raw.mp4 timeline.json demo.hl.mp4 editor.json
node scripts/add_frame.js      demo.hl.mp4  demo.framed.mp4 --canvas 1620x2880 --bg-image PATH
node scripts/add_zoom.js       demo.framed.mp4 timeline.json editor.json demo.hlz.mp4
node scripts/add_speedups.js   demo.hlz.mp4    timeline.json editor.json demo.hlzs.mp4
node scripts/export_video.js   demo.hlzs.mp4   timeline.json editor.json demo.vertical.mp4 vertical_9_16
```

Pass `editor.json` to `add_highlights.js` (optional 4th positional) so the
caption sidecar uses `captions[]` and the highlight anchor delays. Without
it, captions fall back to `.mob` `# Caption:` comments and per-line
highlight tweaks are ignored.

Skip any of zoom/speedups by skipping its invocation and feeding the
previous output to the next stage.

## Canvas aspect rule

The frame canvas (`--canvas WxH` to `add_frame.js`) **must match the export
format's aspect** - `export_video.js` pads, not crops. Defaults:

| Export format | Recommended canvas |
|---|---|
| `vertical_9_16` (1080×1920) | `1620x2880` (1.5× oversample for sharp zoom) |
| `horizontal_16_9` (1920×1080) | `2880x1620` |
| `square_1_1` (1080×1080) | `1620x1620` |

Wrong aspect = a small scene inside black bars.

## Beautiful bezels - bring your own PNG

The procedural bezel in `add_frame.js` is a deliberately simple band with
a Dynamic Island pill - enough for "phone on background" framing but not a
photo-realistic mockup. For a polished marketing look, drop in an external
PNG with `--bezel-png PATH --screen-rect X,Y,W,H`:

```
node scripts/add_frame.js demo.hl.mp4 demo.framed.mp4 \
  --canvas 1620x2880 \
  --bezel-png assets/bezels/iphone-17-pro-natural-titanium.png \
  --screen-rect 130,150,1240,2400 \
  --bg-color 1c1c1e
```

PNG requirements:
- Canvas-sized (matches `--canvas WxH`).
- Transparent inside the screen area + outside the device silhouette.
- Opaque everywhere else (bezel chrome, buttons, camera bumps, etc.).
- The screen rect coordinates inside the PNG are what `--screen-rect`
  encodes - measure once when you set the asset up.

The recording is placed UNDER the PNG, so anywhere the PNG is transparent,
the recording shows through; anywhere it's opaque, the PNG covers the
recording. That's why the rectangular recording's corners get masked into
the rounded screen shape automatically - the PNG covers them.

### Sources

The Simulator's bundled device skins (`/Library/Developer/CoreSimulator/
Profiles/DeviceTypes/iPhone\ <N>.simdevicetype/Contents/Resources/*.pdf`)
turn out to be flat silhouettes - only useful for outline, not chrome.
Better sources:

- **[Apple Design Resources](https://developer.apple.com/design/resources/)**
  - official iPhone PSDs/Sketch/Figma files with high-res device chrome.
  Licensed for "marketing or otherwise distributing apps developed for
  Apple platforms" - covers app demo videos. Open the PSD, export the
  device chrome with a transparent screen cutout to PNG.

- **[Figma Community: Apple iPhone Mockups](https://www.figma.com/community/search?model_type=hub_files&q=iphone+mockup)**
  - several CC-BY templates with high-quality bezels. Export → PNG.

- **[GitHub: ramotion/cyclone](https://github.com/ramotion/cyclone)** and
  similar repos publish PNG mockups under MIT/Apache. Quality varies; check
  the screen alpha matches `--screen-rect` exactly.

### Authoring tips

- Keep the bezel PNG dark (or with subtle shadow) so it reads as "device
  chrome" against most backgrounds. A glossy lit bezel can clash with
  the recording's content.
- Match `--canvas` to the bezel PNG's native size - scaling the PNG in
  ffmpeg blurs the bezel edges.
- If your bezel art is photographically realistic (camera bump, side
  buttons, even a hand holding the phone), match the recording's screen
  rect to the inner screen of the asset exactly. A 5 px offset is
  immediately visible.

## Brittleness

`line` is a source-line reference. The agent that writes the `.mob` also
writes the `editor.json`, so the two stay in sync by construction - when
choreography changes, both files are regenerated together. If a `.mob`
gets re-numbered (e.g. comments inserted), the matching `editor.json`
references update with it.
