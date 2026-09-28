import { Rect, Scene, composition } from '@agentic-video/sdk';

export default composition({
  width: 640,
  height: 360,
  fps: 10,
  duration: 20,
  scene: ({ frame }) => (
    <Scene background="#101010">
      <Rect id="box" x={frame * 2} y={40} width={50} height={50} fill="#FF3366" />
    </Scene>
  ),
});
