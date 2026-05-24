import React from 'react';
import {useCurrentFrame} from 'remotion';
import {RecEvent} from './loadRecording';

// Comet trail per swipe: a line from (x,y) -> (x2,y2) drawn while the swipe
// is in progress (and for a brief lingering window after). Alpha grows from
// start to endpoint so the trail visually leads into where the cursor lands.
// Place inside <RecordingStage>.
export const SwipePath: React.FC<{
  events: RecEvent[];
  width?: number;            // line width in stage px
  color?: string;
  lingerFrames?: number;     // how long after the swipe ends to keep showing
}> = ({events, width = 36, color = 'rgba(255,255,255,0.85)', lingerFrames = 16}) => {
  const frame = useCurrentFrame();
  return (
    <>
      {events
        .filter((e) => e.kind === 'swipe')
        .map((e, i) => {
          if (e.kind !== 'swipe') return null;
          const start = e.frame;
          const end = e.frame + e.durationFrames;
          const fadeEnd = end + lingerFrames;
          if (frame < start || frame >= fadeEnd) return null;
          // While the swipe is in progress, the trail grows from (x,y)
          // toward the current cursor position; after the swipe ends we
          // hold the full trail and fade it out over `lingerFrames`.
          const inSwipe = frame < end;
          const u = inSwipe
            ? Math.min(1, (frame - start) / Math.max(1, e.durationFrames))
            : 1;
          const tipX = e.x + (e.x2 - e.x) * u;
          const tipY = e.y + (e.y2 - e.y) * u;
          const dx = tipX - e.x;
          const dy = tipY - e.y;
          const length = Math.hypot(dx, dy);
          if (length < 4) return null;
          const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
          const opacity = inSwipe ? 0.85 : 1 - (frame - end) / lingerFrames;
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: e.x,
                top: e.y - width / 2,
                width: length,
                height: width,
                background: `linear-gradient(to right, transparent 0%, ${color} 100%)`,
                transformOrigin: '0% 50%',
                transform: `rotate(${angleDeg}deg)`,
                opacity,
                pointerEvents: 'none',
                borderRadius: width / 2,
              }}
            />
          );
        })}
    </>
  );
};
