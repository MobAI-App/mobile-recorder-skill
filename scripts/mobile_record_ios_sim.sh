#!/usr/bin/env bash
# Start native iOS Simulator recording in the background.
#
# Usage:
#   mobile_record_ios_sim.sh <output.mp4>
#
# The script:
#   - confirms a simulator is booted
#   - launches `xcrun simctl io booted recordVideo` in the background
#   - writes the PID to <output.mp4>.pid
#   - returns immediately
#
# Stop the recording with:
#   kill -INT $(cat <output.mp4>.pid)
# (SIGINT lets simctl finalize the mp4 cleanly; SIGTERM corrupts the file.)

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <output.mp4>" >&2
  exit 2
fi

OUT="$1"
PID_FILE="${OUT}.pid"
LOG_FILE="${OUT}.log"

if ! command -v xcrun >/dev/null 2>&1; then
  echo "xcrun not found — install Xcode Command Line Tools." >&2
  exit 3
fi

BOOTED=$(xcrun simctl list devices booted | grep -E "Booted" | head -n1 || true)
if [[ -z "$BOOTED" ]]; then
  echo "No booted iOS Simulator. Boot one with: xcrun simctl boot <udid>" >&2
  exit 4
fi

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Recording already running (PID $(cat "$PID_FILE")). Stop it first." >&2
  exit 5
fi

mkdir -p "$(dirname "$OUT")"

# `simctl io recordVideo` resolves output paths relative to its own daemon
# process, NOT the calling shell. A relative path silently fails with a
# misleading "SimRenderServer error 2". Always pass an absolute path.
case "$OUT" in
  /*) ABS_OUT="$OUT" ;;
  *)  ABS_OUT="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")" ;;
esac

# Capture wall-clock epoch right before spawning the recorder. With simctl
# the actual capture-start lags by an IPC roundtrip + the warmup sleep
# below, so this is a lower bound — but combined with MobAI's per-step
# `startedAtMs` it still lets build_timeline.js use the preferred
# start_ts-based recordStartOffsetMs path (more accurate than the legacy
# warmup + sum(setup durations) heuristic).
date +%s.%N >"${OUT}.start_ts"

nohup xcrun simctl io booted recordVideo --codec=h264 --force "$ABS_OUT" >"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"

# small grace period so the recorder is actually capturing when the agent
# kicks off the recording section. The duration is captured into a sidecar
# so build_timeline.js can include it in recordStartOffsetMs.
WARMUP_MS=400
sleep $(awk "BEGIN {printf \"%.3f\", $WARMUP_MS/1000}")
echo "$WARMUP_MS" >"${OUT}.warmup_ms"

echo "Recording → $OUT (pid $(cat "$PID_FILE"))"
echo "Stop with: kill -INT \$(cat $PID_FILE)"
