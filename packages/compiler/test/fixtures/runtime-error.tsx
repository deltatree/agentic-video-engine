import { Scene, Text, composition } from '@agentic-video/sdk';

function title(frame: number): string {
  return `Frame ${frame}`;
}

export default composition({
  width: 640,
  height: 360,
  fps: 10,
  scene: ({ frame }) => {
    if (frame === 3) throw new Error('broken on purpose');
    return (
      <Scene>
        <Text id="t" text={title(frame)} />
      </Scene>
    );
  },
  duration: 10,
});
