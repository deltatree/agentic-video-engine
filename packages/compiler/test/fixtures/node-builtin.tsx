import { readFileSync } from 'node:fs';
import { Scene, Text, composition } from '@agentic-video/sdk';

export default composition({
  width: 640,
  height: 360,
  fps: 10,
  duration: 10,
  scene: <Scene><Text id="t" text={readFileSync('/etc/hostname', 'utf8')} /></Scene>,
});
