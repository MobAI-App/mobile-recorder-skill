import React from 'react';
import {useCurrentFrame, useVideoConfig, spring, interpolate} from 'remotion';
import {RecCaption} from './loadRecording';

// Output-canvas captions. Two render modes:
//   - Static (default): caption sits at its resting position from start to
//     end of its lifetime. Resting position is (caption.x, caption.y) in
//     output px, or canvas-center-bottom if those are absent.
//   - Float-from-anchor: when the caption carries `anchorX` / `anchorY`
//     (stage source pixels, set by the bridge when the caption is anchored
//     to a tap/swipe), AND the Demo provides a `stageToOutput` mapper, the
//     caption appears AT the anchor point and floats down to the resting
//     position over `floatFrames` frames, then holds until endFrame.
//
// The Demo provides `stageToOutput` because it owns the phone's transform
// (scale + center). We pass it in rather than try to recompute - keeps the
// bridge agnostic to how the phone is composed.

export const Caption: React.FC<{
  captions: RecCaption[];
  accent?: string;
  fontSize?: number;
  floatFrames?: number;
  stageToOutput?: (sx: number, sy: number) => [number, number];
}> = ({captions, accent = '#7c5cff', fontSize = 56, floatFrames = 22, stageToOutput}) => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  return (
    <>
      {captions
        .filter((c) => frame >= c.startFrame && frame < c.endFrame)
        .map((c, i) => {
          const restX = c.x ?? width / 2;
          const restY = c.y ?? height * 0.88;

          // Resolve the start point. If we have an anchor + the mapper,
          // start at the tap/swipe location and float down. Otherwise
          // start at rest (so it just pops in there).
          let startX = restX, startY = restY;
          if (c.anchorX != null && c.anchorY != null && stageToOutput) {
            const [ax, ay] = stageToOutput(c.anchorX, c.anchorY);
            startX = ax;
            startY = ay;
          }

          // Float progress: 0 at startFrame -> 1 at startFrame + floatFrames.
          // Eased so the caption decelerates as it lands. clamp keeps it at
          // the resting position once the float is done.
          const localFrame = frame - c.startFrame;
          const u = Math.max(0, Math.min(1, localFrame / Math.max(1, floatFrames)));
          const eased = 1 - Math.pow(1 - u, 2.5); // ease-out cubic-ish

          const cx = startX + (restX - startX) * eased;
          const cy = startY + (restY - startY) * eased;

          // Existing fade/scale-in spring still drives opacity + a small pop.
          const pop = spring({frame: localFrame, fps, config: {damping: 14, mass: 0.7}});
          const popScale = interpolate(pop, [0, 1], [0.88, 1]);
          const opacity = interpolate(pop, [0, 1], [0, 1]);

          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: cx,
                top: cy,
                transform: `translate(-50%, -50%) scale(${popScale})`,
                opacity,
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              <span style={{
                display: 'inline-block',
                fontSize,
                fontWeight: 700,
                color: 'white',
                fontFamily: 'Inter, system-ui, sans-serif',
                background: 'rgba(0,0,0,0.55)',
                border: `1px solid ${accent}88`,
                padding: '14px 36px',
                borderRadius: 999,
                backdropFilter: 'blur(8px)',
                boxShadow: `0 8px 28px ${accent}33`,
              }}>
                {c.text}
              </span>
            </div>
          );
        })}
    </>
  );
};
