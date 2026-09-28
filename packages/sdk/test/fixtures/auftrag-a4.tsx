// Beispiel aus Auftrag A4, Abschnitt „TypeScript/JSX DSL“ (unverändert bis auf die Imports).
import { AmbientLight, Camera3D, DirectionalLight, Model, Scene, SubtitleTrack, Text, ThreeScene, animate, composition, spring } from '@agentic-video/sdk';

export default composition({
  width: 1920,
  height: 1080,
  fps: 60,
  duration: "12s",

  scene: ({frame, time}) => (
    <Scene background="#080A10">

      <Camera3D
        id="camera"
        position={animate(
          [0, 2, 8],
          [0, 1, 5],
          {from: 0, to: 4, ease: "easeInOutCubic"}
        )}
      />

      <ThreeScene camera="camera">
        <AmbientLight intensity={0.3} />

        <DirectionalLight
          position={[5, 8, 3]}
          intensity={3}
        />

        <Model
          src="./assets/product.glb"
          rotationY={time * 0.4}
        />
      </ThreeScene>

      <Text
        id="headline"
        text="The future is programmable."
        font="Inter"
        fontSize={92}
        x={120}
        y={760}
        opacity={spring({frame, from: 20})}
      />

      <SubtitleTrack src="./audio/voiceover.srt" />

    </Scene>
  )
});
