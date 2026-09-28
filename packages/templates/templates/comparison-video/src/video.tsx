/**
 * Comparison Video: Vorher und Nachher nebeneinander, dann das Ergebnis in Zahlen. 12 s, 1920×1080.
 *
 * Anpassen:
 * - Spalten in `BEFORE` und `AFTER` ändern (gleich viele Zeilen).
 * - Ergebnis in `RESULT` ändern.
 * - Farben kommen aus dem Theme (`settings.theme`): `danger` für vorher, `success` für nachher.
 */
import { THEMES } from '@agentic-video/components';
import { Group, Line, Rect, Scene, Text, animate, component, composition, project, ref } from '@agentic-video/sdk';

const Counter = component('Counter');
const Badge = component('Badge');

const W = 1920;
const H = 1080;
const COL_W = 720;
const LEFT_X = 180;
const RIGHT_X = W - 180 - COL_W;

const BEFORE = {
  title: 'Manual editing',
  rows: ['Every change means a re-export', 'Brand colors drift between videos', 'One editor, one video at a time', 'Hours per variant'],
};

const AFTER = {
  title: 'Video as code',
  rows: ['Change one line, re-render', 'Theme tokens keep brands exact', 'Render farm builds them in parallel', 'Minutes per variant'],
};

const RESULT = { from: 42, to: 3, unit: 'min', label: 'per video variant' };

type Tone = 'danger' | 'success';

/** Eine Spalte mit Kopf, farbiger Linie und Zeilen mit Symbol. */
function Column(props: { id: string; x: number; tone: Tone; title: string; rows: readonly string[]; symbol: string; at: number }) {
  const color = ref(`theme.colors.${props.tone}`);
  return (
    <Group id={props.id} x={props.x} y={230} timing={{ from: `${String(props.at)}s` }} transition={{ in: { type: props.tone === 'danger' ? 'wipe-right' : 'wipe-left', duration: '0.7s', ease: 'easeInOutCubic' } }}>
      <Rect id={`${props.id}-bg`} width={COL_W} height={600} cornerRadius={28} fill={ref('theme.colors.surface')} />
      <Rect id={`${props.id}-top`} width={COL_W} height={8} cornerRadius={4} fill={color} />
      <Text id={`${props.id}-title`} text={props.title} x={48} y={56} fontSize={56} fontWeight={800} letterSpacing={-1} fill={ref('theme.colors.text')} />
      {props.rows.map((row, i) => (
        <Group id={`${props.id}-row-${String(i + 1)}`} key={row} x={48} y={180 + i * 96} timing={{ from: `${String(0.6 + i * 0.3)}s` }} transition={{ in: { type: 'fade', duration: '0.35s' } }}>
          <Rect id={`${props.id}-row-${String(i + 1)}-icon`} width={48} height={48} cornerRadius={24} fill={color} opacity={0.18} />
          <Text id={`${props.id}-row-${String(i + 1)}-symbol`} text={props.symbol} y={6} width={48} textAlign="center" fontSize={30} fontWeight={800} fill={color} />
          <Text id={`${props.id}-row-${String(i + 1)}-text`} text={row} x={76} y={6} width={COL_W - 180} fontSize={32} fill={ref('theme.colors.text')} />
        </Group>
      ))}
    </Group>
  );
}

/** Szene 1: beide Spalten (0–7,4 s). */
const columns = (
  <Group id="columns" timing={{ from: 0, duration: '7.4s' }} transition={{ out: { type: 'zoom-out', duration: '0.5s', ease: 'easeInCubic' } }}>
    <Text id="heading" text="Before vs. after" y={80} width={W} textAlign="center" fontSize={64} fontWeight={800} letterSpacing={-1.2} fill={ref('theme.colors.text')} />
    <Column id="before" x={LEFT_X} tone="danger" title={BEFORE.title} rows={BEFORE.rows} symbol="✕" at={0.3} />
    <Column id="after" x={RIGHT_X} tone="success" title={AFTER.title} rows={AFTER.rows} symbol="✓" at={2.4} />
    <Line id="divider" from={{ x: W / 2, y: 270 }} to={{ x: W / 2, y: 790 }} stroke={ref('theme.colors.muted')} strokeWidth={2} opacity={0.4} trimEnd={animate(0, 1, { from: '2s', duration: '0.8s', ease: 'easeInOutCubic' })} />
    <Badge id="vs" label="VS" variant="muted" x={W / 2 - 34} y={510} timing={{ from: '2.2s' }} enter="scale" exit="none" />
  </Group>
);

/** Szene 2: Ergebnis als großer Zähler (7,2–12 s). */
const result = (
  <Group id="result" timing={{ from: '7.2s' }} transition={{ in: { type: 'zoom-out', duration: '0.5s', ease: 'easeOutCubic' } }}>
    <Text id="result-label" text="Time to ship a new variant" y={260} width={W} textAlign="center" fontSize={48} fontWeight={600} fill={ref('theme.colors.muted')} />
    <Counter id="result-counter" x={W / 2 - 290} y={360} from={RESULT.from} to={RESULT.to} suffix={` ${RESULT.unit}`} fontSize={240} duration="1.8s" delay="0.5s" ease="easeInOutCubic" color={ref('theme.colors.success')} exit="none" />
    <Text id="result-sub" text={`from ${String(RESULT.from)} ${RESULT.unit} to ${String(RESULT.to)} ${RESULT.unit} ${RESULT.label}`} y={700} width={W} textAlign="center" fontSize={36} fill={ref('theme.colors.text')} timing={{ from: '2.4s' }} opacity={animate(0, 1, { duration: '0.5s' })} />
  </Group>
);

export default project({
  metadata: { title: 'Comparison Video', description: 'Side-by-side before and after with a result counter.', tags: ['comparison', 'marketing'] },
  settings: { theme: THEMES.dark },
  compositions: [
    composition({
      id: 'main',
      width: W,
      height: H,
      fps: 30,
      duration: '12s',
      scene: (
        <Scene>
          <Rect id="background" width={W} height={H} fill={ref('theme.colors.background')} />
          {columns}
          {result}
        </Scene>
      ),
    }),
  ],
});
