import {Composition} from 'remotion';
import {Demo} from './Demo';
import {loadRecording} from './bridge';

// calculateMetadata runs the bridge loader (Node at render / browser in
// Studio) and feeds the parsed recording in as props; it also sets the
// duration from the recording length, so the agent never hand-counts frames.
//
// Output canvas defaults to 1080x1920 (vertical_9_16). Change here for
// 1920x1080 (horizontal) or 1080x1080 (square).
export const RemotionRoot = () => (
  <Composition
    id="Demo"
    component={Demo}
    fps={30}
    width={1080}
    height={1920}
    durationInFrames={300}
    defaultProps={{}}
    calculateMetadata={async () => {
      const rec = await loadRecording(30);
      return {durationInFrames: rec.durationInFrames, props: {rec}};
    }}
  />
);
