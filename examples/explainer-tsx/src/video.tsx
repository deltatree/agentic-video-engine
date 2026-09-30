/**
 * Erklärvideo mit dem TSX-SDK (Story 19.7): Bibliothekskomponenten (Title, Subtitle, Callout,
 * ProgressBar, Connector), eine eigene Komponente (StepCard) und ein Marken-Theme.
 * 9 s, 1920×1080. `openvideo validate --trusted` kompiliert die Datei zu Composition IR.
 */
import { Group, Rect, Scene, Svg, animate, component, composition, project, ref } from '@agentic-video/sdk';
import { CARD_WIDTH, StepCard } from './StepCard.js';
import { BRAND_THEME } from './theme.js';

const Title = component('Title');
const Subtitle = component('Subtitle');
const Callout = component('Callout');
const Connector = component('Connector');
const ProgressBar = component('ProgressBar');

const W = 1920;
const H = 1080;

/** Texte an einer Stelle, damit Agents sie gezielt ändern können. */
const COPY = {
  title: 'How Tidewise plans your week',
  subtitle: 'Three steps, zero spreadsheets.',
  steps: [
    { title: 'Connect', body: 'Link calendar and task tools in two clicks.' },
    { title: 'Prioritise', body: 'Tidewise ranks tasks by deadline and effort.' },
    { title: 'Focus', body: 'Blocks of deep work land in your calendar.' },
  ],
  callout: 'Runs every Monday at 8:00',
} as const;

/** Linke Kante der ersten Karte; drei Karten mit 120 px Abstand, zentriert. */
const GAP = 120;
const LEFT = (W - (3 * CARD_WIDTH + 2 * GAP)) / 2;
const CARD_Y = 420;

export default project({
  metadata: { title: 'Explainer (TSX)', description: 'SDK components, a custom component and a brand theme.', tags: ['example', 'explainer', 'tsx'] },
  settings: { theme: BRAND_THEME },
  compositions: [
    composition({
      id: 'main',
      width: W,
      height: H,
      fps: 30,
      duration: '9s',
      scene: (
        <Scene>
          <Rect id="background" width={W} height={H} fill={ref('theme.colors.background')} />
          <Svg id="brand-mark" src="assets/mark.svg" x={LEFT} y={96} width={96} height={96} opacity={animate(0, 1, { from: 0, duration: '0.5s' })} />
          <Group id="heading" x={LEFT + 132} y={88}>
            <Title id="heading-title" text={COPY.title} width={1300} fontSize={72} />
            <Subtitle id="heading-sub" text={COPY.subtitle} width={1300} y={120} timing={{ from: '0.6s' }} />
          </Group>
          {COPY.steps.map((step, i) => (
            <StepCard id={`step-${String(i + 1)}`} index={i + 1} title={step.title} body={step.body} x={LEFT + i * (CARD_WIDTH + GAP)} y={CARD_Y} from={`${String(1.4 + i * 1.2)}s`} />
          ))}
          {[0, 1].map((i) => (
            <Connector
              id={`link-${String(i + 1)}`}
              key={i}
              from={{ x: LEFT + CARD_WIDTH + i * (CARD_WIDTH + GAP) + 12, y: CARD_Y + 150 }}
              to={{ x: LEFT + (i + 1) * (CARD_WIDTH + GAP) - 12, y: CARD_Y + 150 }}
              arrow
              timing={{ from: `${String(2.2 + i * 1.2)}s` }}
            />
          ))}
          <Callout id="schedule-callout" text={COPY.callout} x={LEFT + 2 * (CARD_WIDTH + GAP) + 60} y={CARD_Y + 380} target={{ x: 0, y: -90 }} width={380} timing={{ from: '5.4s' }} />
          <ProgressBar id="progress" x={LEFT} y={H - 90} width={3 * CARD_WIDTH + 2 * GAP} duration="9s" enter="none" />
        </Scene>
      ),
    }),
  ],
  renderProfiles: [{ id: 'web', format: 'mp4', codec: 'h264', quality: 80 }],
});
