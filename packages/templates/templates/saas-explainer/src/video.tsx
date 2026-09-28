/**
 * SaaS Explainer: Problem, Lösung im Produkt, drei Schritte. 15 s, 1920×1080.
 *
 * Anpassen:
 * - Texte in `COPY` ändern.
 * - Das Dashboard im Laptop besteht aus einfachen Rechtecken (`Dashboard`).
 * - Farben kommen aus dem Theme (`settings.theme`).
 */
import { THEMES } from '@agentic-video/components';
import { Circle, Group, Rect, Scene, Text, animate, component, composition, project, ref } from '@agentic-video/sdk';

const Title = component('Title');
const Subtitle = component('Subtitle');
const Laptop = component('Laptop');
const Cursor = component('Cursor');
const Callout = component('Callout');
const Connector = component('Connector');
const Grid = component('Grid');

const W = 1920;
const H = 1080;

const COPY = {
  problem: 'Weekly reports still take a full day.',
  problemSub: 'Exports, spreadsheets, copy and paste. Every single week.',
  solution: 'Flowboard builds them for you.',
  callout: 'One click: live report',
  steps: ['Connect', 'Automate', 'Share'],
  stepText: ['Link your data sources in minutes.', 'Pick a template, set a schedule.', 'Send a live link to your team.'],
  closing: 'Start free at flowboard.example',
} as const;

/** Einfaches Dashboard aus Rechtecken im Laptop-Bildschirm (Bildschirm ≈ 912×555 px). */
const Dashboard = (
  <Group id="dashboard">
    <Rect id="dash-sidebar" width={180} height={555} fill={ref('theme.colors.surface')} />
    <Rect id="dash-logo" x={28} y={32} width={96} height={20} cornerRadius={10} fill={ref('theme.colors.primary')} />
    {[0, 1, 2, 3].map((i) => (
      <Rect id={`dash-nav-${String(i + 1)}`} key={i} x={28} y={96 + i * 44} width={120} height={14} cornerRadius={7} fill={ref('theme.colors.muted')} opacity={0.45} />
    ))}
    {[0, 1, 2].map((i) => (
      <Rect id={`dash-kpi-${String(i + 1)}`} key={i} x={212 + i * 228} y={32} width={208} height={110} cornerRadius={14} fill={ref('theme.colors.surface')} />
    ))}
    {[0, 1, 2].map((i) => (
      <Rect id={`dash-kpi-value-${String(i + 1)}`} key={i} x={236 + i * 228} y={60} width={110} height={26} cornerRadius={8} fill={ref('theme.colors.text')} opacity={0.85} />
    ))}
    <Rect id="dash-chart" x={212} y={166} width={664} height={250} cornerRadius={14} fill={ref('theme.colors.surface')} />
    {[0.45, 0.7, 0.55, 0.85, 0.65, 0.95, 0.8].map((v, i) => (
      <Rect
        id={`dash-bar-${String(i + 1)}`}
        key={i}
        x={252 + i * 88}
        y={animate(396, 396 - v * 190, { from: `${String(1.2 + i * 0.08)}s`, duration: '0.7s', ease: 'easeOutCubic' })}
        width={48}
        height={animate(0, v * 190, { from: `${String(1.2 + i * 0.08)}s`, duration: '0.7s', ease: 'easeOutCubic' })}
        cornerRadius={8}
        fill={ref('theme.colors.primary')}
      />
    ))}
    <Rect id="dash-button" x={696} y={446} width={180} height={56} cornerRadius={28} fill={ref('theme.colors.accent')} />
    <Text id="dash-button-label" text="Export" x={696} y={462} width={180} textAlign="center" fontSize={22} fontWeight={700} fill={ref('theme.colors.background')} />
  </Group>
);

/** Szene 1: das Problem (0–4,2 s). */
const problem = (
  <Group id="problem" timing={{ from: 0, duration: '4.2s' }} transition={{ out: { type: 'fade', duration: '0.4s' } }}>
    <Title id="problem-title" text={COPY.problem} width={1700} fontSize={88} x={110} y={400} align="center" />
    <Subtitle id="problem-sub" text={COPY.problemSub} width={1500} x={210} y={560} align="center" timing={{ from: '1s' }} />
  </Group>
);

/** Szene 2: das Produkt im Laptop mit Mauszeiger und Hinweis (4–10 s). */
const product = (
  <Group id="product" timing={{ from: '4s', duration: '6s' }} transition={{ in: { type: 'slide-up', duration: '0.6s', ease: 'easeOutCubic' }, out: { type: 'wipe-left', duration: '0.5s' } }}>
    <Text id="product-heading" text={COPY.solution} x={160} y={110} width={1600} textAlign="center" fontSize={64} fontWeight={800} letterSpacing={-1} fill={ref('theme.colors.text')} />
    <Laptop id="product-laptop" width={960} x={480} y={250} enter="none">
      {Dashboard}
    </Laptop>
    <Cursor id="product-cursor" x={480} y={250} points={[{ x: 560, y: 520 }, { x: 800, y: 380 }, { x: 820, y: 505 }]} duration="2.2s" delay="1.8s" clicks={['4.2s']} timing={{ from: 0 }} />
    <Callout id="product-callout" text={COPY.callout} x={1470} y={660} target={{ x: -150, y: -30 }} width={320} timing={{ from: '4.4s' }} />
  </Group>
);

/** Szene 3: drei Schritte, verbunden mit Pfeilen (9,8–15 s). */
const steps = (
  <Group id="steps" timing={{ from: '9.8s' }} transition={{ in: { type: 'fade', duration: '0.5s' } }}>
    {COPY.steps.map((label, i) => (
      <Group id={`step-${String(i + 1)}`} key={label} x={260 + i * 560} y={300} timing={{ from: `${String(0.2 + i * 0.5)}s` }} transition={{ in: { type: 'zoom-in', duration: '0.5s', ease: 'easeOutBack' } }}>
        <Circle id={`step-${String(i + 1)}-circle`} radius={90} fill={ref('theme.colors.surface')} stroke={ref('theme.colors.primary')} strokeWidth={6} x={70} />
        <Text id={`step-${String(i + 1)}-number`} text={String(i + 1)} x={70} y={42} width={180} textAlign="center" fontSize={80} fontWeight={800} fill={ref('theme.colors.primary')} />
        <Text id={`step-${String(i + 1)}-label`} text={label} y={220} width={320} textAlign="center" fontSize={48} fontWeight={700} fill={ref('theme.colors.text')} />
        <Text id={`step-${String(i + 1)}-text`} text={COPY.stepText[i] ?? ''} y={290} width={320} textAlign="center" fontSize={26} lineHeight={1.35} fill={ref('theme.colors.muted')} />
      </Group>
    ))}
    {[0, 1].map((i) => (
      <Connector id={`step-link-${String(i + 1)}`} key={i} x={0} y={0} from={{ x: 540 + i * 560, y: 390 }} to={{ x: 790 + i * 560, y: 390 }} arrow timing={{ from: `${String(0.6 + i * 0.5)}s` }} exit="none" />
    ))}
    <Text id="steps-closing" text={COPY.closing} x={260} y={860} width={W - 520} textAlign="center" fontSize={40} fontWeight={600} fill={ref('theme.colors.accent')} timing={{ from: '2s' }} transition={{ in: { type: 'slide-up', duration: '0.5s', ease: 'easeOutCubic' } }} />
  </Group>
);

export default project({
  metadata: { title: 'SaaS Explainer', description: 'Problem, product demo and three steps.', tags: ['explainer', 'saas'] },
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
          <Grid id="grid" width={W} height={H} style="dots" opacity={0.45} enter="none" exit="none" />
          {problem}
          {product}
          {steps}
        </Scene>
      ),
    }),
  ],
});
