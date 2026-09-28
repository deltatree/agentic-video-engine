/**
 * Architecture Diagram: Dienste erscheinen Schicht für Schicht, Verbindungen zeigen den Datenfluss. 14 s, 1920×1080.
 *
 * Anpassen:
 * - Kästen in `BOXES` (Position = linke obere Ecke) und Verbindungen in `LINKS` ändern.
 * - Farben kommen aus dem Theme (`settings.theme`).
 */
import { THEMES } from '@agentic-video/components';
import { Group, Rect, Scene, Text, component, composition, project, ref } from '@agentic-video/sdk';

const Grid = component('Grid');
const Connector = component('Connector');
const Badge = component('Badge');

const W = 1920;
const H = 1080;
const BOX_W = 300;
const BOX_H = 120;

type Tone = 'primary' | 'secondary' | 'accent' | 'success' | 'warning';

interface Box {
  readonly id: string;
  readonly label: string;
  readonly sub: string;
  readonly x: number;
  readonly y: number;
  readonly tone: Tone;
  /** Einblendzeit in Sekunden. */
  readonly at: number;
}

/** Vier Schichten von links nach rechts: Client, Edge, Dienste, Daten. */
const BOXES: readonly Box[] = [
  { id: 'web', label: 'Web App', sub: 'React · Studio', x: 120, y: 420, tone: 'accent', at: 0.6 },
  { id: 'agent', label: 'Coding Agent', sub: 'MCP · CLI', x: 120, y: 680, tone: 'accent', at: 0.9 },
  { id: 'gateway', label: 'API Gateway', sub: 'Auth · Rate limits', x: 560, y: 550, tone: 'primary', at: 2.0 },
  { id: 'render', label: 'Render Service', sub: 'Frame plans', x: 1000, y: 350, tone: 'secondary', at: 3.2 },
  { id: 'scheduler', label: 'Scheduler', sub: 'Chunk queue', x: 1000, y: 550, tone: 'secondary', at: 3.5 },
  { id: 'workers', label: 'Workers ×32', sub: 'Skia · Chromium', x: 1000, y: 750, tone: 'secondary', at: 3.8 },
  { id: 'cache', label: 'Frame Cache', sub: 'Content addressed', x: 1480, y: 450, tone: 'success', at: 5.0 },
  { id: 'storage', label: 'Object Storage', sub: 'S3 compatible', x: 1480, y: 670, tone: 'success', at: 5.3 },
];

/** Verbindungen: von Kasten → zu Kasten, Einblendzeit in Sekunden. */
const LINKS: readonly (readonly [string, string, number])[] = [
  ['web', 'gateway', 2.4],
  ['agent', 'gateway', 2.6],
  ['gateway', 'render', 4.2],
  ['gateway', 'scheduler', 4.4],
  ['scheduler', 'workers', 4.6],
  ['render', 'cache', 5.8],
  ['workers', 'storage', 6.0],
];

function box(id: string): Box {
  const found = BOXES.find((b) => b.id === id);
  if (found === undefined) throw new Error(`Unknown box "${id}" in LINKS.`);
  return found;
}

/** Ein Dienst: Fläche, farbiger Rand links, Name und Untertitel. */
function Service(b: Box) {
  return (
    <Group id={b.id} key={b.id} x={b.x} y={b.y} timing={{ from: `${String(b.at)}s` }} transition={{ in: { type: 'zoom-in', duration: '0.45s', ease: 'easeOutBack' } }}>
      <Rect id={`${b.id}-bg`} width={BOX_W} height={BOX_H} cornerRadius={18} fill={ref('theme.colors.surface')} stroke={ref(`theme.colors.${b.tone}`)} strokeWidth={2} shadow={{ color: '#00000055', blur: 24, offsetY: 10 }} />
      <Rect id={`${b.id}-edge`} x={0} y={24} width={6} height={BOX_H - 48} cornerRadius={3} fill={ref(`theme.colors.${b.tone}`)} />
      <Text id={`${b.id}-label`} text={b.label} x={32} y={28} fontSize={34} fontWeight={700} fill={ref('theme.colors.text')} />
      <Text id={`${b.id}-sub`} text={b.sub} x={32} y={74} fontSize={22} fill={ref('theme.colors.muted')} />
    </Group>
  );
}

export default project({
  metadata: { title: 'Architecture Diagram', description: 'Layered service diagram with animated data flow.', tags: ['architecture', 'diagram'] },
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
          <Grid id="grid" width={W} height={H} style="lines" majorEvery={4} opacity={0.35} enter="none" exit="none" />
          <Text id="title" text="Render platform" x={120} y={90} fontSize={64} fontWeight={800} letterSpacing={-1.2} fill={ref('theme.colors.text')} />
          <Badge id="title-badge" label="v2 ARCHITECTURE" variant="primary" appearance="soft" x={120} y={180} exit="none" />
          {/* Verbindungen zuerst, damit sie unter den Kästen liegen. */}
          {LINKS.map(([from, to, at]) => {
            const a = box(from);
            const b = box(to);
            return (
              <Connector
                id={`link-${from}-${to}`}
                key={`${from}-${to}`}
                from={{ x: a.x + BOX_W, y: a.y + BOX_H / 2 }}
                to={{ x: b.x, y: b.y + BOX_H / 2 }}
                style="elbow"
                arrow
                timing={{ from: `${String(at)}s` }}
                exit="none"
              />
            );
          })}
          {BOXES.map((b) => Service(b))}
        </Scene>
      ),
    }),
  ],
});
