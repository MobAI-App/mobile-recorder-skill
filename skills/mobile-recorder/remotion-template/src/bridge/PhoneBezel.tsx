import React from 'react';

// Rounded phone-bezel framing: a rounded mask on the recording, an optional
// outer bezel ring, and an optional iPhone Dynamic Island pill at the top.
// Sized in the same source-pixel space as <RecordingStage>; place this AS
// the stage container or just inside it to get the standard mobile look.
//
// Defaults follow real iPhone proportions:
//   - screen corner radius   ~12% of stage width
//   - bezel ring thickness   ~2.5% of stage width
//   - Dynamic Island width   28% of stage width, height 4.2%, top 1.3%
//
// All three accept explicit values to opt out of the iPhone-Pro look (e.g.
// Android / older iPhones / generic mockups).
export const PhoneBezel: React.FC<{
  width: number;
  height: number;
  cornerRadius?: number;
  bezelThickness?: number;
  bezelColor?: string;
  dynamicIsland?: boolean;
  islandWidthFrac?: number;
  islandHeightFrac?: number;
  islandTopFrac?: number;
  children: React.ReactNode;
}> = ({
  width,
  height,
  cornerRadius,
  bezelThickness,
  bezelColor = '#0a0a0a',
  dynamicIsland = true,
  islandWidthFrac = 0.28,
  islandHeightFrac = 0.042,
  islandTopFrac = 0.013,
  children,
}) => {
  const radius = cornerRadius ?? Math.round(width * 0.10);
  const bezel = bezelThickness ?? Math.max(4, Math.round(width * 0.022));
  const islandW = width * islandWidthFrac;
  const islandH = height * islandHeightFrac;
  const islandLeft = (width - islandW) / 2;
  const islandTop = height * islandTopFrac;
  return (
    <div style={{position: 'relative', width, height}}>
      {/* Rounded mask around the recording */}
      <div style={{
        position: 'absolute', inset: 0, borderRadius: radius, overflow: 'hidden',
      }}>
        {children}
      </div>
      {/* Bezel ring drawn as a border ON TOP of the recording */}
      <div style={{
        position: 'absolute', inset: -bezel,
        borderRadius: radius + bezel,
        border: `${bezel}px solid ${bezelColor}`,
        boxShadow: '0 50px 120px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05)',
        pointerEvents: 'none',
      }} />
      {/* Dynamic Island */}
      {dynamicIsland && (
        <div style={{
          position: 'absolute', left: islandLeft, top: islandTop,
          width: islandW, height: islandH,
          borderRadius: islandH / 2, background: bezelColor,
          pointerEvents: 'none',
        }} />
      )}
    </div>
  );
};
