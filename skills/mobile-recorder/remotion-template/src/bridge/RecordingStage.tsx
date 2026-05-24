import React from 'react';

// Sets up the recording's coordinate space (source-pixel space of the raw
// .mp4, e.g. 1206x2622 for an iPhone 17 Pro recording at 3x). Place
// <RecordingCard>, <Cursor>, <TapRipple>, <SwipePath> inside it - they
// share these coords, so the creative composition can scale/position/animate
// the stage as one unit and everything stays aligned with the footage.
export const RecordingStage: React.FC<{
  width: number;
  height: number;
  children: React.ReactNode;
}> = ({width, height, children}) => {
  return <div style={{position: 'relative', width, height}}>{children}</div>;
};
