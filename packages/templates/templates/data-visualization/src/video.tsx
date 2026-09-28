/**
 * Data Visualization: Kennzahlen zählen hoch, dann Balken-, Linien- und Kreisdiagramm. 14 s, 1920×1080.
 *
 * Anpassen:
 * - Zahlen in `KPIS`, `REVENUE`, `USERS` und `SHARE` ersetzen.
 * - Diagrammfarben folgen der Theme-Palette (`settings.theme`).
 */
import { THEMES } from '@agentic-video/components';
import { Group, Rect, Scene, Text, component, composition, project, ref } from '@agentic-video/sdk';

const Counter = component('Counter');
const BarChart = component('BarChart');
const LineChart = component('LineChart');
const PieChart = component('PieChart');

const W = 1920;
const H = 1080;
const MARGIN = 160;

const KPIS = [
  { label: 'monthly renders', to: 128400, prefix: '', suffix: '', decimals: 0 },
  { label: 'avg. render time', to: 4.2, prefix: '', suffix: ' s', decimals: 1 },
  { label: 'revenue', to: 2.8, prefix: '$', suffix: 'M', decimals: 1 },
] as const;

const REVENUE = [
  { label: 'Q1', value: 1.2 },
  { label: 'Q2', value: 1.7 },
  { label: 'Q3', value: 2.1 },
  { label: 'Q4', value: 2.8 },
];

const USERS = [
  { name: '2024', data: [{ label: 'Jan', value: 12 }, { label: 'Mar', value: 18 }, { label: 'May', value: 21 }, { label: 'Jul', value: 26 }, { label: 'Sep', value: 30 }] },
  { name: '2025', data: [{ label: 'Jan', value: 22 }, { label: 'Mar', value: 31 }, { label: 'May', value: 39 }, { label: 'Jul', value: 47 }, { label: 'Sep', value: 58 }] },
];

const SHARE = [
  { label: 'Skia', value: 54 },
  { label: 'Browser', value: 23 },
  { label: 'Three.js', value: 15 },
  { label: 'Blender', value: 8 },
];

/** Überschrift einer Szene. */
function heading(id: string, text: string) {
  return <Text id={id} text={text} x={MARGIN} y={120} fontSize={72} fontWeight={800} letterSpacing={-1.5} fill={ref('theme.colors.text')} />;
}

/** Szene 1: drei Kennzahlen (0–4,6 s). */
const kpis = (
  <Group id="kpis" timing={{ from: 0, duration: '4.6s' }} transition={{ out: { type: 'fade', duration: '0.4s' } }}>
    {heading('kpis-heading', 'Year in numbers')}
    {KPIS.map((k, i) => (
      <Group id={`kpi-${String(i + 1)}`} key={k.label} x={MARGIN + i * 540} y={400} timing={{ from: `${String(0.1 + i * 0.2)}s` }} transition={{ in: { type: 'slide-up', duration: '0.5s', ease: 'easeOutCubic' } }}>
        <Rect id={`kpi-${String(i + 1)}-bg`} width={500} height={260} cornerRadius={24} fill={ref('theme.colors.surface')} />
        <Text id={`kpi-${String(i + 1)}-label`} text={k.label.toUpperCase()} x={44} y={44} fontSize={24} fontWeight={600} letterSpacing={3} fill={ref('theme.colors.muted')} />
        <Counter
          id={`kpi-${String(i + 1)}-value`}
          x={40}
          y={100}
          to={k.to}
          prefix={k.prefix}
          suffix={k.suffix}
          decimals={k.decimals}
          fontSize={92}
          duration="1.6s"
          delay={`${String(0.3 + i * 0.25)}s`}
          color={ref(i === 0 ? 'theme.colors.primary' : i === 1 ? 'theme.colors.accent' : 'theme.colors.success')}
        />
      </Group>
    ))}
  </Group>
);

/** Szene 2: Balken und Linien nebeneinander (4,4–9,6 s). */
const trends = (
  <Group id="trends" timing={{ from: '4.4s', duration: '5.2s' }} transition={{ in: { type: 'fade', duration: '0.4s' }, out: { type: 'slide-up', duration: '0.5s', ease: 'easeInCubic' } }}>
    {heading('trends-heading', 'Growth')}
    <BarChart id="revenue-chart" title="Revenue ($M)" data={REVENUE} showValues width={760} height={620} x={MARGIN} y={280} delay="0.3s" />
    <LineChart id="users-chart" title="Active users (k)" series={USERS} area width={760} height={620} x={1000} y={280} delay="0.8s" />
  </Group>
);

/** Szene 3: Anteile als Ring (9,4–14 s). */
const share = (
  <Group id="share" timing={{ from: '9.4s' }} transition={{ in: { type: 'slide-up', duration: '0.5s', ease: 'easeOutCubic' } }}>
    {heading('share-heading', 'Frames by backend')}
    <PieChart id="share-chart" data={SHARE} size={600} innerRadius={0.6} centerLabel="100 %" legend showPercent x={MARGIN} y={280} delay="0.3s" exit="none" />
    <Group id="share-note" x={1160} y={420} timing={{ from: '1.4s' }} transition={{ in: { type: 'slide-left', duration: '0.5s', ease: 'easeOutCubic' } }}>
      <Text id="share-note-value" text="54 %" fontSize={140} fontWeight={800} letterSpacing={-3} fill={ref('theme.colors.primary')} />
      <Text id="share-note-text" text="of all frames render on Skia, the fastest backend." y={170} width={600} fontSize={40} lineHeight={1.3} fill={ref('theme.colors.muted')} />
    </Group>
  </Group>
);

export default project({
  metadata: { title: 'Data Visualization', description: 'KPI counters, bar, line and donut charts.', tags: ['data', 'charts'] },
  settings: { theme: THEMES.dark },
  compositions: [
    composition({
      id: 'main',
      width: W,
      height: H,
      fps: 30,
      duration: '14s',
      scene: (
        <Scene>
          <Rect id="background" width={W} height={H} fill={ref('theme.colors.background')} />
          {kpis}
          {trends}
          {share}
        </Scene>
      ),
    }),
  ],
});
