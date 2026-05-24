// The creative composition - this is the file you edit. All the recording
// plumbing (parsing the contract, frame/coord mapping, walking cursor,
// ripples, swipe paths, anchor-floating captions) comes from ./bridge;
// here we only do the look. Drop the recording into public/ and `npm run
// studio` to iterate.
import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring} from 'remotion';
import {
  Recording, RecordingStage, RecordingCard, PhoneBezel,
  Cursor, TapRipple, SwipePath, Caption,
} from './bridge';

const ACCENT = '#7c5cff';

// Soft drifting blobs for background depth. Cheap to render, give the comp
// some life behind a static phone. Tune colors / size / speed to taste.
const Blob: React.FC<{x: number; y: number; size: number; color: string; speed: number; phase: number}> = ({
  x, y, size, color, speed, phase,
}) => {
  const f = useCurrentFrame();
  return (
    <div style={{
      position: 'absolute',
      left: x + Math.sin(f * speed + phase) * 100,
      top:  y + Math.cos(f * speed * 0.8 + phase) * 80,
      width: size, height: size, borderRadius: '50%',
      background: color, filter: 'blur(110px)', opacity: 0.55,
    }} />
  );
};

export const Demo: React.FC<{rec?: Recording}> = ({rec}) => {
  const frame = useCurrentFrame();
  const {fps, width, height, durationInFrames} = useVideoConfig();
  if (!rec) return null;

  // Background hue drifts subtly through the take.
  const hueShift = interpolate(frame, [0, durationInFrames], [0, 30]);
  const bg = `radial-gradient(circle at 25% 15%, hsl(${230 + hueShift},55%,18%), hsl(${260 + hueShift},70%,7%) 75%)`;

  // Fit the phone into the canvas with a comfortable margin.
  const marginV = 140;
  const marginH = 110;
  const fit = Math.min(
    (width  - marginH * 2) / rec.stageWidth,
    (height - marginV * 2) / rec.stageHeight,
  );

  // Spring entrance from below, then settle into a gentle float + slight tilt.
  const enter = spring({frame, fps, config: {damping: 12, mass: 0.9}});
  const scale  = fit * interpolate(enter, [0, 1], [0.85, 1]);
  const liftY  = interpolate(enter, [0, 1], [180, 0]);
  const floatY = Math.sin(frame / 24) * 12;
  const tiltY  = Math.sin(frame / 65) * 3.5;
  const tiltX  = Math.sin(frame / 90) * 2;

  return (
    <AbsoluteFill style={{
      background: bg,
      fontFamily: 'Inter, system-ui, sans-serif',
      overflow: 'hidden',
    }}>
      <Blob x={-120} y={-80}            size={680} color={ACCENT}    speed={0.011} phase={0} />
      <Blob x={width - 540} y={height - 660} size={760} color="#21d4fd"  speed={0.009} phase={2} />

      {/* Phone with the recording, ripples, walking cursor, swipe trail. */}
      <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center'}}>
        <div style={{perspective: 1800}}>
          <div style={{
            transform:
              `translateY(${liftY + floatY}px) ` +
              `scale(${scale}) ` +
              `rotateX(${tiltX}deg) ` +
              `rotateY(${tiltY}deg)`,
          }}>
            <PhoneBezel width={rec.stageWidth} height={rec.stageHeight}>
              <RecordingStage width={rec.stageWidth} height={rec.stageHeight}>
                <RecordingCard
                  src={rec.videoSrc}
                  width={rec.stageWidth}
                  height={rec.stageHeight}
                  playbackRate={rec.speed}
                />
                <SwipePath events={rec.events} />
                <TapRipple events={rec.events} />
                <Cursor events={rec.events} />
              </RecordingStage>
            </PhoneBezel>
          </div>
        </div>
      </AbsoluteFill>

      {/* Captions. The stageToOutput mapper uses the SETTLED phone position
          (no float/tilt wobble in the trajectory) so a caption launched at
          a tap coord lands cleanly on the bottom strip. */}
      <Caption
        captions={rec.captions}
        accent={ACCENT}
        stageToOutput={(sx, sy) => [
          width / 2  + (sx - rec.stageWidth  / 2) * fit,
          height / 2 + (sy - rec.stageHeight / 2) * fit,
        ]}
      />
    </AbsoluteFill>
  );
};
