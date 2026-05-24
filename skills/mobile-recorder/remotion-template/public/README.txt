Drop the recording's contract into this folder. The bridge reads:

  public/rec.mp4           - the recording, pre-trimmed to the choreography
                             portion (-ss <trim_start_sec>) and transcoded
                             to a browser codec (libx264 + yuv420p, no audio)
  public/timeline.json     - from `node scripts/build_timeline.js ...`
  public/editor.json       - optional; only needed for captions[] / trim

See ../README.md for the full pipeline + the trim-head math.
