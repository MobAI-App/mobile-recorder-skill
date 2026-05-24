# Remotion bridge template (mobile)

Turn a mobile-recorder recording into a Remotion motion-graphics video. The
**bridge** (`src/bridge/`) does the integration; you only edit the creative
composition (`src/Demo.tsx`).

This is an **optional** path, separate from the lean ffmpeg pipeline in
`scripts/` (`add_highlights` → `add_frame` → `add_zoom` → `add_speedups` →
`export_video`). It needs Node + Remotion installed (heavier deps, headless
Chrome). Use it when you want React-grade motion graphics around the
recording instead of a flat composite.

The desktop sibling has the same shape at
`desktop-recorder-skill/skills/desktop-recorder/remotion-template/` -
identical contract idea, different inputs (`screenplay.json` vs our
`editor.json`, scene IDs vs `.mob` line numbers, multi-window comp vs
single-device source).

## Use

1. **Copy** this folder into a working dir and `npm install`.
2. **Feed the recording** into `public/`. `rec.mp4` MUST be pre-trimmed to
   the choreography portion - the bridge returns events and captions with
   frame numbers relative to the trim head, so the video has to start
   there too. Compute the trim head in raw-recording seconds:
   ```
   trim_start_sec = (editor.trim.startDelayMs + timeline[0].recordStartOffsetMs) / 1000
   ```
   Then transcode with `-ss`:
   ```
   ffmpeg -ss <trim_start_sec> -i demo.raw.mp4 \
     -c:v libx264 -pix_fmt yuv420p -an public/rec.mp4
   ```
   (the raw MJPEG-sourced `.mp4` is yuvj420p; `OffthreadVideo` wants
   yuv420p. The `-an` drops audio, which we don't record.)

   Also stage:
   - `public/timeline.json` - from `node scripts/build_timeline.js ...`
   - `public/editor.json` - optional; needed for captions[] and trim
3. **Render**: `npx remotion render Demo out/video.mp4`
   (first run: `npx remotion browser ensure` to fetch the headless shell).
4. **Iterate** in `npx remotion studio`.

## The bridge (`src/bridge/`)

- `loadRecording(fps, {speed?, videoFile?, recordingSize?})` - reads the
  contract (via `fetch(staticFile(...))`, so it runs in `calculateMetadata`)
  and returns frame-indexed props: `fps`, `durationInFrames`, `speed`,
  `stageWidth/Height` (recording source-pixel dims), `videoSrc`, `events`
  (taps + swipes as frame/x/y/x2/y2), `captions`, `recordStartOffsetMs`.
  `speed > 1` plays the footage faster - duration and event frames are
  scaled down to match; pass `rec.speed` to `<RecordingCard playbackRate>`
  so the cursor stays synced with the video.
- `cursorAt(events, frame, opts?)` - walking-cursor pose at a given frame:
  fade-in at the previous action's resting target, slide over the
  approach window into the current action, hold past touch-down, fade out.
  Mirrors the ffmpeg pipeline's `add_highlights.js`. Returns
  `{x, y, alpha}` or `null` (cursor invisible between actions).
- `<RecordingStage width height>` - the recording's source-pixel
  coordinate space. Put the card + cursor + ripples + swipe paths inside;
  the creative comp scales/positions the stage as one unit and everything
  stays aligned with the footage.
- `<RecordingCard src width height playbackRate?>` - the
  `<OffthreadVideo>`, sized to the stage.
- `<PhoneBezel width height ...>` - rounded mask + bezel ring + optional
  Dynamic Island. Wraps the recording. Defaults follow iPhone Pro
  proportions; override `cornerRadius`, `bezelThickness`, `bezelColor`,
  `dynamicIsland`, etc. for Android / older iPhones / generic mockups.
- `<Cursor events size? color?>` - timeline-driven, in stage coords.
- `<TapRipple events>` - expanding ring per tap.
- `<SwipePath events>` - comet trail from `(x,y) -> (x2,y2)` during a swipe.
- `<Caption captions>` - output-canvas captions (per-caption `x` / `y`
  override honored, default centered at 88% of canvas height).

`Root.tsx` wires `loadRecording` into `calculateMetadata`, so the
composition duration comes from the recording and `Demo` receives the
parsed `rec` prop.

## Coordinates

`timeline.json` x/y are in **recording source pixels** (e.g. 1206×2622 for
an iPhone 17 Pro recording at 3x scale). That's the same space `rec.mp4`'s
pixels live in, so a `<Cursor>` or `<TapRipple>` placed inside
`<RecordingStage>` lines up with the footage without any extra mapping.
The creative composition can scale / translate / tilt the stage as one
unit and everything inside follows.

## Differences from the ffmpeg pipeline

| | ffmpeg pipeline | Remotion bridge |
|---|---|---|
| Output | one mp4, one ffmpeg invocation per stage | one mp4 via headless Chrome render |
| Motion graphics | bezel, gradient bg, zoom, captions | full React + Remotion (springs, transitions, blobs, parallax, anything CSS can do) |
| Iteration | render-edit-render | `remotion studio` with hot reload |
| Footprint | node + ffmpeg, ~zero deps | node + Remotion (~hundreds of MB, headless Chrome) |

You almost certainly want the ffmpeg pipeline for production demos and
the Remotion bridge for one-off "show me a fancier opening" cuts. The
two can co-exist - run the bridge against the same `timeline.json` /
`editor.json` you already have.
