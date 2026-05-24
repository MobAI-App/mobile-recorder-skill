#!/usr/bin/env bash
# Start Android screen recording in the background using adb screenrecord.
#
# Usage:
#   mobile_record_android.sh <output.mp4> [device_serial]
#
# Notes:
#   - adb screenrecord caps at ~3 minutes per call. For longer demos, chain
#     calls and concatenate; we expect demos to be well under 3 minutes.
#   - The recording is captured on-device at /sdcard/demo_<ts>.mp4, then
#     pulled to <output.mp4> when stopped.
#
# Stop with:
#   kill -INT $(cat <output.mp4>.pid)
# The script's trap will pull the file back and clean up the on-device copy.

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <output.mp4> [device_serial]" >&2
  exit 2
fi

OUT="$1"
DEVICE="${2:-}"
PID_FILE="${OUT}.pid"
LOG_FILE="${OUT}.log"
REMOTE="/sdcard/demo_$(date +%s).mp4"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb not found - install platform-tools." >&2
  exit 3
fi

ADB=(adb)
if [[ -n "$DEVICE" ]]; then
  ADB+=(-s "$DEVICE")
fi

if ! "${ADB[@]}" get-state >/dev/null 2>&1; then
  echo "No Android device connected. Run: adb devices" >&2
  exit 4
fi

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Recording already running (PID $(cat "$PID_FILE")). Stop it first." >&2
  exit 5
fi

mkdir -p "$(dirname "$OUT")"

# Capture wall-clock epoch before spawning screenrecord. adb screenrecord
# has a small startup lag of its own, but combined with the warmup sleep
# below this is close enough that build_timeline.js can use the preferred
# start_ts-based recordStartOffsetMs path instead of the legacy
# warmup+sum(setup durations) heuristic.
date +%s.%N >"${OUT}.start_ts"

# Launch a small bash subshell that starts screenrecord, waits for SIGINT,
# then pulls the file back. Pass values as argv so output paths and serials
# with shell metacharacters cannot break the child command.
nohup bash -c '
  set -euo pipefail

  OUT="$1"
  REMOTE="$2"
  DEVICE="$3"

  ADB=(adb)
  if [[ -n "$DEVICE" ]]; then
    ADB+=(-s "$DEVICE")
  fi

  REC_PID=""
  finish() {
    if [[ -n "$REC_PID" ]]; then
      kill -INT "$REC_PID" 2>/dev/null || true
      wait "$REC_PID" 2>/dev/null || true
    fi
    "${ADB[@]}" pull "$REMOTE" "$OUT" >/dev/null 2>&1 || true
    "${ADB[@]}" shell rm -f "$REMOTE" >/dev/null 2>&1 || true
    exit 0
  }

  trap finish INT TERM

  "${ADB[@]}" shell screenrecord --bit-rate 8000000 "$REMOTE" &
  REC_PID=$!
  wait "$REC_PID" || true
  finish
' mobile_record_android_child "$OUT" "$REMOTE" "$DEVICE" >"$LOG_FILE" 2>&1 &

echo $! >"$PID_FILE"

# Brief warm-up so the first DSL action lands in the recording, not before it.
# Captured into a sidecar so build_timeline.js can include it in
# recordStartOffsetMs.
WARMUP_MS=600
sleep $(awk "BEGIN {printf \"%.3f\", $WARMUP_MS/1000}")
echo "$WARMUP_MS" >"${OUT}.warmup_ms"

echo "Recording → $OUT (pid $(cat "$PID_FILE"))"
echo "Stop with: kill -INT \$(cat $PID_FILE)"
