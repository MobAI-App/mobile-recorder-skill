# editor.json — post-production directives

The `.mob` script owns choreography — it's what MobAI replays during the take.
`editor.json` owns post-production: where to zoom, what spans to speed up,
where to trim. Both files live in the same demo folder; they're regenerated
together by the agent.

Directives reference `.mob` source lines by number. `build_timeline.js` emits
`line` on every timeline event, so the editing scripts can join the two.

## Schema (v1)

```jsonc
{
  "schema_version": 1,

  // Optional. Both fields reference .mob action lines.
  // Default: first action → last action end + 600 ms tail pad.
  "trim": { "fromLine": 33, "toLine": 113 },

  "directives": [
    { "kind": "zoom",  "line": 76,  "side": "during", "scale": 2.0 },
    { "kind": "zoom",  "line": 113, "side": "before", "scale": 2.5,
      "center": { "x": 990, "y": 1539 }, "rampMs": 300 },

    { "kind": "speed", "line": 78,  "side": "during", "factor": 6.0 },
    { "kind": "speed", "line": 113, "side": "before", "factor": 1.0 }
  ]
}
```

## `side` semantics

Every directive anchors to a single `.mob` line. `side` decides which slice of
the recording the directive applies to:

| side     | Span                                                        |
|----------|-------------------------------------------------------------|
| `before` | previous action's end → this action's start                 |
| `during` | this action's own span (most useful for `wait` / `swipe`)   |
| `after`  | this action's end → next action's start                     |

Edge cases:
- `before` on the first action extends back to `record_start` (t=0).
- `after` on the last action extends forward to `record_stop`.
- A `tap` action has zero "during" duration, so `during` on a tap is a no-op
  for speed and a brief peak for zoom. Use `before` or `after` for a tap.

## `kind: zoom`

```jsonc
{
  "kind": "zoom",
  "line":   76,
  "side":   "during",
  "scale":  2.0,                                 // > 1
  "center": { "x": 500, "y": 1200 },             // optional — see defaults below
  "rampMs": 200,                                 // optional — ease in/out duration, default 200
  "windowMs": 1200                               // optional — explicit window centered on the span
}
```

Zoom now operates on the **framed composite**, not the raw recording. So
"scale: 2.0" means the entire phone-bezel-on-background scene gets twice as
large (the camera moves closer to the phone), not "zoom into the screen
content."

Center defaults (when `center` is omitted):
- **with `frame.json` sidecar present** (the usual case): center of the
  phone screen in composite coords, taken from the sidecar.
- **without `frame.json`** (pipeline run without framing): falls back to
  the timeline event's coord — tap `(x, y)`, swipe midpoint, or video center.

When `center` is explicit, its coords are in:
- **composite-pixel space** if `frame.json` is present (e.g. (540, 1200) for
  the middle of a 1080×2400 canvas)
- **recording-pixel space** otherwise

Most agents will set `windowMs` and lean on the default center — the phone
sits at a fixed position in the composite, so "zoom in" is geometrically
unambiguous and rarely needs an override.

### Zero-width spans

`side: during` on a `tap` resolves to a zero-width span (taps are
instantaneous). `add_zoom.js` rejects zero-width directives with an explicit
error — the editor.json must say what window it wants. Fix one of:

- anchor on a `wait` / `swipe` line that has duration, with `side: during`
- pick a `side` that has a real gap around the action (`before` / `after`)
- set `windowMs`:
  ```jsonc
  { "kind": "zoom", "line": 76, "side": "during", "scale": 2.0, "windowMs": 1500 }
  ```
  `windowMs` is centered on the resolved span's midpoint, so this works
  for tap anchors regardless of which side you picked.

The script also bans overlapping zoom segments; if you need two zooms back
to back, leave a gap between their windows.

## `kind: speed`

```jsonc
{
  "kind": "speed",
  "line": 78,
  "side": "during",
  "factor": 6.0                                  // > 0, != 1
}
```

Every speed segment is explicit — there's no auto pass. To compress all
`reason: "technical"` waits, emit one `{kind:"speed", line, side:"during",
factor: N}` per wait line. `viewer_readability` waits are usually left at
real time; if you do want to compress one, point an explicit directive at
it like any other span.

## Trim

```jsonc
"trim": { "fromLine": 33, "toLine": 113 }
```

- `fromLine`: head cut at this action's choreography start (default: first
  action).
- `toLine`: tail cut at this action's end + 600 ms (default: last action +
  600 ms).

Both are choreography-time markers; `export_video.js` adds
`recordStartOffsetMs` to translate to raw-recording time, then maps through
`<input>.timewarp.json` if a speedup pass produced one.

## End-to-end pipeline

```bash
node scripts/add_highlights.js demo.raw.mp4 timeline.json demo.hl.mp4
node scripts/add_zoom.js       demo.hl.mp4  timeline.json editor.json demo.hlz.mp4
node scripts/add_speedups.js   demo.hlz.mp4 timeline.json editor.json demo.hlzs.mp4
node scripts/export_video.js   demo.hlzs.mp4 timeline.json editor.json demo.vertical.mp4 vertical_9_16
```

Skip any of zoom/speedups by skipping its invocation and feeding the previous
output to the next stage.

## Beautiful bezels — bring your own PNG

The procedural bezel in `add_frame.js` is a deliberately simple band with
a Dynamic Island pill — enough for "phone on background" framing but not a
photo-realistic mockup. For a polished marketing look, drop in an external
PNG with `--bezel-png PATH --screen-rect X,Y,W,H`:

```
node scripts/add_frame.js demo.hl.mp4 demo.framed.mp4 \
  --canvas 1500x2700 \
  --bezel-png assets/bezels/iphone-17-pro-natural-titanium.png \
  --screen-rect 130,150,1240,2400 \
  --bg-color 1c1c1e
```

PNG requirements:
- Canvas-sized (matches `--canvas WxH`).
- Transparent inside the screen area + outside the device silhouette.
- Opaque everywhere else (bezel chrome, buttons, camera bumps, etc.).
- The screen rect coordinates inside the PNG are what `--screen-rect`
  encodes — measure once when you set the asset up.

The recording is placed UNDER the PNG, so anywhere the PNG is transparent,
the recording shows through; anywhere it's opaque, the PNG covers the
recording. That's why the rectangular recording's corners get masked into
the rounded screen shape automatically — the PNG covers them.

### Sources

The Simulator's bundled device skins (`/Library/Developer/CoreSimulator/
Profiles/DeviceTypes/iPhone\ <N>.simdevicetype/Contents/Resources/*.pdf`)
turn out to be flat silhouettes — only useful for outline, not chrome.
Better sources:

- **[Apple Design Resources](https://developer.apple.com/design/resources/)**
  — official iPhone PSDs/Sketch/Figma files with high-res device chrome.
  Licensed for "marketing or otherwise distributing apps developed for
  Apple platforms" — covers app demo videos. Open the PSD, export the
  device chrome with a transparent screen cutout to PNG.

- **[Figma Community: Apple iPhone Mockups](https://www.figma.com/community/search?model_type=hub_files&q=iphone+mockup)**
  — several CC-BY templates with high-quality bezels. Export → PNG.

- **[GitHub: ramotion/cyclone](https://github.com/ramotion/cyclone)** and
  similar repos publish PNG mockups under MIT/Apache. Quality varies; check
  the screen alpha matches `--screen-rect` exactly.

### Authoring tips

- Keep the bezel PNG dark (or with subtle shadow) so it reads as "device
  chrome" against most backgrounds. A glossy lit bezel can clash with
  the recording's content.
- Match `--canvas` to the bezel PNG's native size — scaling the PNG in
  ffmpeg blurs the bezel edges.
- If your bezel art is photographically realistic (camera bump, side
  buttons, even a hand holding the phone), match the recording's screen
  rect to the inner screen of the asset exactly. A 5 px offset is
  immediately visible.

## Brittleness

`line` is a source-line reference. The agent that writes the `.mob` also
writes the `editor.json`, so the two stay in sync by construction — when
choreography changes, both files are regenerated together.
