import React from 'react';
import {useCurrentFrame} from 'remotion';
import {RecEvent, cursorAt} from './loadRecording';

// Walking-cursor touch dot. Same model as the ffmpeg pipeline's
// add_highlights.js: for each tap, fade in at the previous tap's resting
// target, slide over APPROACH frames to the new target arriving at
// touch-down, hold through the ripple, fade out. First tap is a quick
// pulse-style fade-in. Swipes follow (x,y) -> (x2,y2) linearly across the
// swipe's durationFrames, and the NEXT slide-in starts from (x2,y2).
//
// Place inside <RecordingStage> so the coords match the footage.
export const Cursor: React.FC<{
  events: RecEvent[];
  size?: number;                  // diameter in stage px
  color?: string;
  prePulseFrames?: number;
  approachFrames?: number;
  holdFrames?: number;
  fadeOutFrames?: number;
}> = ({
  events, size = 80, color = 'rgba(255,255,255,0.92)',
  prePulseFrames, approachFrames, holdFrames, fadeOutFrames,
}) => {
  const frame = useCurrentFrame();
  const pose = cursorAt(events, frame, {prePulseFrames, approachFrames, holdFrames, fadeOutFrames});
  if (!pose || pose.alpha <= 0) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: pose.x - size / 2,
        top: pose.y - size / 2,
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        opacity: pose.alpha,
        boxShadow: '0 4px 18px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.1)',
        pointerEvents: 'none',
      }}
    />
  );
};
