#!/usr/bin/env bash
# Record an iOS device (Simulator or physical) by consuming MobAI's HTTP
# MJPEG stream. The skill's primary recorder for iOS - `xcrun simctl io
# recordVideo` is intentionally not used because it only emits frames on
# display invalidation, freezing demo dwell time.
#
# Frame source: MobAI's local HTTP server (port 8686 by default) exposes a
# multipart/x-mixed-replace MJPEG stream per device. ffmpeg's `mpjpeg` demuxer
# consumes it directly and re-encodes to mp4.
#
# Usage:
#   mobile_record_mjpeg.sh <output.mp4> <device_id> [fps] [quality] [server]
#
# Defaults:
#   fps     = 60    (MobAI caps the stream at 60; lower values save CPU
#                   but the final video looks chunkier on motion)
#   quality = 100   (0–100, JPEG quality; use 100 for final demos)
#   server  = http://127.0.0.1:8686
#
# Stop with: kill -INT $(cat <output.mp4>.pid)
# SIGINT lets ffmpeg flush the moov atom cleanly; SIGTERM/SIGKILL produces
# an unreadable mp4.

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <output.mp4> <device_id> [fps] [quality] [server]" >&2
  exit 2
fi

OUT="$1"
DEVICE_ID="$2"
FPS="${3:-60}"
QUALITY="${4:-100}"
SERVER="${5:-http://127.0.0.1:8686}"
PID_FILE="${OUT}.pid"
LOG_FILE="${OUT}.log"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg not found." >&2
  exit 3
fi

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Recording already running (PID $(cat "$PID_FILE")). Stop it first." >&2
  exit 5
fi

URL="${SERVER}/device/${DEVICE_ID}/stream?fps=${FPS}&quality=${QUALITY}"

# Quick reachability check. The stream is infinite, so curl will often time
# out even on a healthy connection. Treat it as healthy only when the endpoint
# returns a 2xx code and either completes or times out after receiving bytes.
set +e
CURL_METRICS=$(curl -sS --max-time 1 -o /dev/null -w "%{http_code} %{size_download}" "$URL" 2>/dev/null)
CURL_EXIT=$?
set -e
HTTP_CODE="${CURL_METRICS%% *}"
BYTES_DOWNLOADED="${CURL_METRICS##* }"

if [[ ! "$HTTP_CODE" =~ ^2[0-9][0-9]$ ]] || { [[ "$CURL_EXIT" -ne 0 && "$CURL_EXIT" -ne 28 ]] || [[ "$CURL_EXIT" -eq 28 && "${BYTES_DOWNLOADED:-0}" -eq 0 ]]; }; then
  echo "MobAI stream unreachable: $URL (http $HTTP_CODE, curl exit $CURL_EXIT, bytes ${BYTES_DOWNLOADED:-0})" >&2
  echo "Is the MobAI desktop app running, and is the device booted?" >&2
  exit 4
fi

mkdir -p "$(dirname "$OUT")"

# Save the wall-clock start so the stop helper can retime the mp4 to match
# real-time duration. MJPEG multipart headers don't include timestamps and
# MobAI delivers frames in bursts during interactions; ffmpeg can't pace
# the encode to wall-clock on its own.
START_TS_FILE="${OUT}.start_ts"
date +%s.%N > "$START_TS_FILE"

# mpjpeg over HTTP has no per-frame timestamps. MobAI's stream rate also
# varies with screen activity - bursts during interaction, fewer frames
# during idle. Without an explicit output rate, ffmpeg encodes at a
# default 25 fps PTS regardless, so a 14 s real-time recording with
# bursty activity ends up 30-40 s of video.
#
# Combination that gives wall-clock-accurate timing:
#   -use_wallclock_as_timestamps 1   stamp each frame with arrival time
#   -r 30 -vsync cfr                 force output CFR at 30 fps so any
#                                    over-delivery collapses back to
#                                    real-time pacing
#
# 30 fps is a good compromise for screen content (smooth enough, half the
# encoder load of 60).
nohup ffmpeg -y \
  -use_wallclock_as_timestamps 1 \
  -f mpjpeg -i "$URL" \
  -r 30 -vsync cfr \
  -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p \
  -movflags +faststart \
  -an \
  "$OUT" >"$LOG_FILE" 2>&1 &

echo $! >"$PID_FILE"

# brief warm-up so the first DSL action lands in the recording, not before it.
# The duration is captured into a sidecar so build_timeline.js can include it
# in recordStartOffsetMs.
WARMUP_MS=500
sleep $(awk "BEGIN {printf \"%.3f\", $WARMUP_MS/1000}")
echo "$WARMUP_MS" >"${OUT}.warmup_ms"

if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "ffmpeg exited during startup; tail of log:" >&2
  tail -n 30 "$LOG_FILE" >&2 || true
  exit 6
fi

echo "Recording → $OUT (pid $(cat "$PID_FILE"))"
echo "Stop with: kill -INT \$(cat $PID_FILE)"
