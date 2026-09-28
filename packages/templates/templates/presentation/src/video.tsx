/**
 * Presentation: drei Folien (Titel, Stichpunkte, Tabelle) mit Fußzeile und Fortschritt. 15 s, 1920×1080.
 *
 * Anpassen:
 * - Folien in `SLIDES` ändern; jede Folie dauert `SLIDE` Sekunden.
 * - Farben kommen aus dem Theme (`settings.theme`).
 */
import { THEMES } from '@agentic-video/components';
import { Group, Rect, Scene, Text, animate, component, composition, project, ref } from '@agentic-video/sdk';

const Title = component('Title');
const Subtitle = component('Subtitle');
const Table = component('Table');
const Badge = component('Badge');

const W = 1920;
const H = 1080;
const SLIDE = 5;
const MARGIN = 160;

const DECK = 'Q3 Engineering Review';

const BULLETS = [
  'Render time per frame down 38 %',
  'Frame cache hit rate now at 91 %',
  'Three new render backends shipped',
  'Zero flaky golden tests since July',
] as const;

const TABLE = {
  columns: ['Backend', 'Frames/s', 'Change'],
  rows: [
    ['Skia', '142', '+24 %'],
    ['Browser', '61', '+12 %'],
    ['Three.js', '38', '+31 %'],
    ['Blender', '2.4', '+8 %'],
  ],
} as const;

/** Zeitfenster der Folie `i` mit weichem Übergang. */
function slideTiming(i: number): { from: string; duration: string } {
  return { from: `${String(i * SLIDE)}s`, duration: `${String(SLIDE)}s` };
}

/** Folie 1: Titel. */
const titleSlide = (
  <Group id="slide-1" timing={slideTiming(0)} transition={{ out: { type: 'slide-left', duration: '0.5s', ease: 'easeInOutCubic' } }}>
    <Badge id="slide-1-badge" label="ENGINEERING" variant="primary" appearance="soft" x={MARGIN} y={380} />
    <Title id="slide-1-title" text={DECK} fontSize={120} width={1500} x={MARGIN} y={450} timing={{ from: '0.2s' }} />
    <Subtitle id="slide-1-sub" text="Platform team · October" x={MARGIN} y={670} timing={{ from: '0.9s' }} />
  </Group>
);

/** Folie 2: Stichpunkte, nacheinander eingeblendet. */
const bulletSlide = (
  <Group id="slide-2" timing={slideTiming(1)} transition={{ in: { type: 'slide-left', duration: '0.5s', ease: 'easeInOutCubic' }, out: { type: 'slide-left', duration: '0.5s', ease: 'easeInOutCubic' } }}>
    <Text id="slide-2-heading" text="Highlights" x={MARGIN} y={170} fontSize={80} fontWeight={800} letterSpacing={-1.5} fill={ref('theme.colors.text')} />
    {BULLETS.map((b, i) => (
      <Group
        id={`bullet-${String(i + 1)}`}
        key={b}
        x={MARGIN}
        y={340 + i * 130}
        timing={{ from: `${String(0.6 + i * 0.45)}s` }}
        transition={{ in: { type: 'slide-right', duration: '0.45s', ease: 'easeOutCubic' } }}
      >
        <Rect id={`bullet-${String(i + 1)}-dot`} y={18} width={20} height={20} cornerRadius={10} fill={ref('theme.colors.accent')} />
        <Text id={`bullet-${String(i + 1)}-text`} text={b} x={56} fontSize={48} fontWeight={500} fill={ref('theme.colors.text')} />
      </Group>
    ))}
  </Group>
);

/** Folie 3: Tabelle. */
const tableSlide = (
  <Group id="slide-3" timing={{ from: `${String(2 * SLIDE)}s` }} transition={{ in: { type: 'slide-left', duration: '0.5s', ease: 'easeInOutCubic' } }}>
    <Text id="slide-3-heading" text="Throughput by backend" x={MARGIN} y={170} fontSize={80} fontWeight={800} letterSpacing={-1.5} fill={ref('theme.colors.text')} />
    <Table id="slide-3-table" columns={TABLE.columns} rows={TABLE.rows} width={W - MARGIN * 2} fontSize={40} x={MARGIN} y={330} timing={{ from: '0.5s' }} stagger={5} exit="none" />
  </Group>
);

export default project({
  metadata: { title: 'Presentation', description: 'Three slides with footer and progress.', tags: ['presentation', 'slides'] },
  settings: { theme: THEMES.dark },
  compositions: [
    composition({
      id: 'main',
      width: W,
      height: H,
      fps: 30,
      duration: `${String(3 * SLIDE)}s`,
      scene: (
        <Scene>
          <Rect id="background" width={W} height={H} fill={ref('theme.colors.background')} />
          <Rect id="side-accent" width={16} height={H} fill={ref('theme.colors.primary')} />
          {titleSlide}
          {bulletSlide}
          {tableSlide}
          {/* Fußzeile: Titel links, Fortschritt rechts. */}
          <Text id="footer-title" text={DECK} x={MARGIN} y={H - 96} fontSize={24} fontWeight={500} fill={ref('theme.colors.muted')} />
          <Rect id="footer-track" x={W - MARGIN - 360} y={H - 86} width={360} height={6} cornerRadius={3} fill={ref('theme.colors.muted')} opacity={0.3} />
          <Rect id="footer-progress" x={W - MARGIN - 360} y={H - 86} width={animate(0, 360, { duration: `${String(3 * SLIDE)}s`, ease: 'linear' })} height={6} cornerRadius={3} fill={ref('theme.colors.primary')} />
        </Scene>
      ),
    }),
  ],
});
