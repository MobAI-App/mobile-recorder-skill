#!/usr/bin/env bash
# Cleanly stop a background mobile_record_*.sh recorder and retime the
# resulting mp4 to wall-clock duration if needed.
#
# Usage:
#   mobile_record_stop.sh <output.mp4>
#
# The recorder writes:
#   <output>.pid        - ffmpeg PID
#   <output>.start_ts   - wall-clock epoch (with fractional seconds)
#
# This script:
#   1. SIGINTs the recorder so simctl/ffmpeg flushes the mp4 cleanly
#   2. Probes the resulting video duration
#   3. If the video is more than 5% longer than wall-clock real time (the
#      typical sign of mpjpeg over-delivery during interactions), re-times
#      the video by ratio = real_duration / video_duration. Output is
#      written back to the same path.
#
# We retime instead of pinning fps inside the recorder because mpjpeg
# bursts are unpredictable - sometimes 60 fps real, sometimes 25 fps,
# depending on simulator activity. Post-hoc retiming uses ground-truth
# wall-clock and Just Works.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <output.mp4>" >&2
  exit 2
fi

OUT="$1"
PID_FILE="${OUT}.pid"
START_TS_FILE="${OUT}.start_ts"

if [[ ! -f "$PID_FILE" ]]; then
  echo "no PID file at $PID_FILE - was the recorder started?" >&2
  exit 3
fi

PID=$(cat "$PID_FILE")
NOW=$(date +%s.%N)

if kill -0 "$PID" 2>/dev/null; then
  kill -INT "$PID"
  for i in $(seq 1 60); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.25
  done
  if kill -0 "$PID" 2>/dev/null; then
    echo "recorder $PID didn't exit after 15 s - sending SIGTERM" >&2
    kill -TERM "$PID" 2>/dev/null || true
    sleep 1
  fi
fi
echo "recorder stopped"

if [[ ! -f "$OUT" ]]; then
  echo "expected mp4 not found: $OUT" >&2
  exit 4
fi

if [[ ! -f "$START_TS_FILE" ]]; then
  echo "no start_ts sidecar - skipping retime"
  exit 0
fi

START_TS=$(cat "$START_TS_FILE")
REAL_DUR=$(awk "BEGIN {printf \"%.3f\", $NOW - $START_TS}")
# ffprobe's csv=p=0 trails a comma, strip it before arithmetic.
VIDEO_DUR=$(ffprobe -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 "$OUT" | tr -d ',\n\r ')

# Guard the math: a malformed ffprobe response would turn the awk expression
# into a division-by-zero that quietly produces inf and corrupts the retime.
if ! [[ "$VIDEO_DUR" =~ ^[0-9]+(\.[0-9]+)?$ ]] || [[ "$(awk "BEGIN {print ($VIDEO_DUR > 0) ? 1 : 0}")" != "1" ]]; then
  echo "error: ffprobe returned invalid duration '$VIDEO_DUR' for $OUT" >&2
  exit 5
fi
if ! [[ "$REAL_DUR" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
  echo "error: computed real_duration '$REAL_DUR' is invalid (start_ts=$START_TS, now=$NOW)" >&2
  exit 5
fi

# Ratio < 1 means the recording is stretched and we need to compress it
# to fit real time.
RATIO=$(awk "BEGIN {printf \"%.6f\", $REAL_DUR / $VIDEO_DUR}")

echo "Wall-clock real: ${REAL_DUR}s | mp4 reports: ${VIDEO_DUR}s | retime ratio: ${RATIO}x"

# Only retime if the stretch is noticeable. 5% tolerance covers natural
# variation (ffmpeg flush, last-frame quirks).
NEEDS_RETIME=$(awk "BEGIN {print ($RATIO < 0.95) ? 1 : 0}")
if [[ "$NEEDS_RETIME" != "1" ]]; then
  echo "Recording timing OK - no retime needed."
  exit 0
fi

TMP="${OUT}.retimed.mp4"
echo "Retiming → $TMP"

# setpts compresses PTS by the ratio; fps=30 re-samples to 30 fps CFR.
# Without the fps filter, setpts alone would just produce a higher-fps
# stream (e.g. 80 fps over 13 s instead of 30 fps over 36 s).
ffmpeg -y -loglevel error \
  -i "$OUT" \
  -vf "setpts=${RATIO}*PTS,fps=30" \
  -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p \
  -movflags +faststart -an \
  "$TMP"

mv "$TMP" "$OUT"
FINAL_DUR=$(ffprobe -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 "$OUT" | tr -d ',\n\r ')
echo "Retimed → $OUT (${FINAL_DUR}s, 30 fps)"
