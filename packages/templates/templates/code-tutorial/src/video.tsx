/**
 * Code Tutorial: Schritt-Titel, Code tippt sich, Terminal zeigt das Ergebnis. 15 s, 1920×1080.
 *
 * Anpassen:
 * - `CODE` ist der gezeigte Quelltext; `HIGHLIGHT` markiert Zeilen (1-basiert).
 * - `COMMANDS` sind die Terminal-Befehle mit Ausgabe.
 * - Farben kommen aus dem Theme (`settings.theme`).
 */
import { THEMES } from '@agentic-video/components';
import { Group, Rect, Scene, Text, animate, component, composition, project, ref } from '@agentic-video/sdk';

const Badge = component('Badge');
const CodeEditor = component('CodeEditor');
const Terminal = component('Terminal');
const Callout = component('Callout');

const W = 1920;
const H = 1080;

const STEP = { number: 'STEP 2', title: 'Render your first frame' };

const CODE = [
  "import { composition, Scene, Text } from '@agentic-video/sdk';",
  '',
  'export default composition({',
  '  width: 1920, height: 1080, fps: 30, duration: "3s",',
  '  scene: ({ frame }) => (',
  '    <Scene background="#0B1020">',
  '      <Text text="Hello" x={frame * 4} fontSize={96} />',
  '    </Scene>',
  '  ),',
  '});',
].join('\n');

const HIGHLIGHT = [7];

const COMMANDS = [
  { command: 'npx openvideo frame video.tsx --at 1s', output: 'Wrote out/frame-30.png (1920×1080)' },
  { command: 'npx openvideo render video.tsx', output: 'Rendered 90 frames in 1.8 s → out/video.mp4' },
];

export default project({
  metadata: { title: 'Code Tutorial', description: 'Typing code editor and terminal output.', tags: ['tutorial', 'code'] },
  settings: { theme: THEMES.dark },
  compositions: [
    composition({
      id: 'main',
      width: W,
      height: H,
      fps: 30,
      duration: '15s',
      scene: (
        <Scene>
          <Rect id="background" width={W} height={H} fill={ref('theme.colors.background')} />
          {/* Kopfzeile mit Schritt und Titel, bleibt stehen. */}
          <Group id="header" x={120} y={70}>
            <Badge id="header-step" label={STEP.number} variant="accent" appearance="soft" exit="none" />
            <Text id="header-title" text={STEP.title} y={52} fontSize={64} fontWeight={800} letterSpacing={-1.2} fill={ref('theme.colors.text')} opacity={animate(0, 1, { from: '0.2s', duration: '0.5s' })} />
          </Group>
          <CodeEditor
            id="editor"
            code={CODE}
            language="ts"
            title="video.tsx"
            highlightLines={HIGHLIGHT}
            typing={45}
            typingDelay="0.8s"
            width={1120}
            fontSize={30}
            x={120}
            y={260}
            exit="none"
          />
          <Callout id="callout" text="x moves 4 px per frame" x={1300} y={330} target={{ x: -120, y: 271 }} width={360} timing={{ from: '8.5s', duration: '3.5s' }} />
          <Terminal
            id="terminal"
            commands={COMMANDS}
            title="zsh"
            typing={30}
            pause="0.6s"
            width={820}
            height={250}
            fontSize={24}
            x={980}
            y={780}
            timing={{ from: '9s' }}
            enter="slide-up"
            exit="none"
          />
        </Scene>
      ),
    }),
  ],
});
