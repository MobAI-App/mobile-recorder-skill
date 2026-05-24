import React from 'react';
import {useCurrentFrame, useVideoConfig, interpolate} from 'remotion';
import {RecEvent} from './loadRecording';

// Soft expanding ring at each tap. Place inside <RecordingStage> so the
// coords match the footage. Default size is ~11% of the stage's short edge
// (matches the ffmpeg pipeline's ripple sprite); customize via `peakDiameter`.
export const TapRipple: React.FC<{
  events: RecEvent[];
  durationMs?: number;
  color?: string;
  peakDiameter?: number;
}> = ({events, durationMs = 520, color = 'rgba(255,255,255,0.9)', peakDiameter = 220}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const dur = (durationMs / 1000) * fps;
  return (
    <>
      {events
        .filter((e) => e.kind === 'tap' && frame >= e.frame && frame < e.frame + dur)
        .map((e, i) => {
          const local = frame - e.frame;
          const d = interpolate(local, [0, dur], [peakDiameter * 0.08, peakDiameter]);
          const opacity = interpolate(local, [0, dur], [0.9, 0]);
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: e.x - d / 2,
                top: e.y - d / 2,
                width: d,
                height: d,
                borderRadius: '50%',
                border: `${Math.max(3, d * 0.04)}px solid ${color}`,
                opacity,
                pointerEvents: 'none',
              }}
            />
          );
        })}
    </>
  );
};
