import React from 'react';
import {OffthreadVideo} from 'remotion';

// The recording itself, filling the stage. Wrap it in <PhoneBezel> for the
// rounded-corners + bezel look, or use it raw if you want the creative
// composition to provide its own framing (external mockup PNG, etc.).
export const RecordingCard: React.FC<{
  src: string;
  width: number;
  height: number;
  playbackRate?: number;
}> = ({src, width, height, playbackRate = 1}) => {
  return (
    <div style={{position: 'absolute', inset: 0, overflow: 'hidden'}}>
      <OffthreadVideo src={src} playbackRate={playbackRate} style={{width, height, display: 'block'}} />
    </div>
  );
};
