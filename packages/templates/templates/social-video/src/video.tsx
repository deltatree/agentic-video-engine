/**
 * Social Video (Hochformat 1080×1920): Aufhänger, drei Tipps, Aufruf zum Folgen. 10 s.
 *
 * Anpassen:
 * - Texte in `COPY` ändern; die Tipp-Liste darf 2–4 Einträge haben.
 * - Farben kommen aus dem Theme (`settings.theme`).
 * - Sichere Zone: oben 200 px, unten 320 px frei lassen (Bedienelemente der Apps).
 */
import { THEMES } from '@agentic-video/components';
import { Group, Rect, Scene, Text, animate, component, composition, project, ref } from '@agentic-video/sdk';

const Badge = component('Badge');
const Title = component('Title');
const Counter = component('Counter');
const GradientBackground = component('GradientBackground');

const W = 1080;
const H = 1920;
const MARGIN = 90;

const COPY = {
  badge: 'TIP #12',
  hook: 'Render video 10× faster',
  tips: [
    { title: 'Cache every layer', body: 'Unchanged layers come straight from the cache.' },
    { title: 'Split into chunks', body: 'Render chunks in parallel, stitch losslessly.' },
    { title: 'Preview at ¼ size', body: 'Iterate on small frames, export at full size.' },
  ],
  stat: 'faster renders',
  follow: 'Follow for more',
  handle: '@openvideo',
} as const;

/** Szene 1: Aufhänger mit großer Zahl (0–3,6 s). */
const hook = (
  <Group id="hook" timing={{ from: 0, duration: '3.6s' }} transition={{ out: { type: 'slide-up', duration: '0.5s', ease: 'easeInCubic' } }}>
    <Badge id="hook-badge" label={COPY.badge} variant="accent" fontSize={32} x={MARGIN} y={320} />
    <Title id="hook-title" text={COPY.hook} width={W - MARGIN * 2} fontSize={132} x={MARGIN} y={420} timing={{ from: '0.2s' }} />
    <Counter id="hook-counter" from={1} to={10} suffix="×" fontSize={300} x={MARGIN} y={980} duration="1.6s" delay="0.8s" color={ref('theme.colors.primary')} />
    <Text id="hook-stat" text={COPY.stat} x={MARGIN} y={1330} fontSize={56} fontWeight={600} fill={ref('theme.colors.muted')} timing={{ from: '0.8s' }} opacity={animate(0, 1, { duration: '0.5s' })} />
  </Group>
);

/** Szene 2: drei Tipps als Karten untereinander (3,4–8 s). */
const tips = (
  <Group id="tips" timing={{ from: '3.4s', duration: '4.6s' }} transition={{ in: { type: 'fade', duration: '0.4s' }, out: { type: 'fade', duration: '0.4s' } }}>
    <Text id="tips-heading" text="Three quick wins" x={MARGIN} y={320} fontSize={88} fontWeight={800} letterSpacing={-1.5} fill={ref('theme.colors.text')} />
    {COPY.tips.map((tip, i) => (
      <Group
        id={`tip-${String(i + 1)}`}
        key={tip.title}
        x={MARGIN}
        y={500 + i * 360}
        timing={{ from: `${String(0.3 + i * 0.45)}s` }}
        transition={{ in: { type: 'slide-left', duration: '0.5s', ease: 'easeOutCubic' } }}
      >
        <Rect id={`tip-${String(i + 1)}-card`} width={W - MARGIN * 2} height={310} cornerRadius={28} fill={ref('theme.colors.surface')} shadow={{ color: '#00000055', blur: 30, offsetY: 12 }} />
        <Rect id={`tip-${String(i + 1)}-accent`} width={12} height={310} cornerRadius={[28, 0, 0, 28]} fill={ref('theme.colors.primary')} />
        <Text id={`tip-${String(i + 1)}-number`} text={String(i + 1)} x={56} y={48} fontSize={96} fontWeight={900} fill={ref('theme.colors.primary')} />
        <Text id={`tip-${String(i + 1)}-title`} text={tip.title} x={190} y={62} width={W - MARGIN * 2 - 240} fontSize={56} fontWeight={800} fill={ref('theme.colors.text')} />
        <Text id={`tip-${String(i + 1)}-body`} text={tip.body} x={190} y={148} width={W - MARGIN * 2 - 240} fontSize={40} lineHeight={1.3} fill={ref('theme.colors.muted')} />
      </Group>
    ))}
  </Group>
);

/** Szene 3: Aufruf zum Folgen (7,8–10 s). */
const follow = (
  <Group id="follow" timing={{ from: '7.8s' }} transition={{ in: { type: 'zoom-out', duration: '0.5s', ease: 'easeOutCubic' } }}>
    <Text id="follow-title" text={COPY.follow} y={800} width={W} textAlign="center" fontSize={110} fontWeight={800} letterSpacing={-2} fill={ref('theme.colors.text')} />
    <Group id="follow-pill" x={(W - 520) / 2} y={980}>
      <Rect id="follow-pill-bg" width={520} height={110} cornerRadius={55} fill={ref('theme.colors.primary')} />
      <Text id="follow-pill-label" text={COPY.handle} y={30} width={520} textAlign="center" fontSize={46} fontWeight={700} fill="#FFFFFF" />
    </Group>
  </Group>
);

export default project({
  metadata: { title: 'Social Video', description: 'Vertical 9:16 clip with hook, tips and follow call.', tags: ['social', 'vertical'] },
  settings: { theme: THEMES.dark },
  compositions: [
    composition({
      id: 'main',
      width: W,
      height: H,
      fps: 30,
      duration: '10s',
      scene: (
        <Scene>
          <Rect id="background" width={W} height={H} fill={ref('theme.colors.background')} />
          <GradientBackground id="glow" width={W} height={H} opacity={0.6} enter="none" exit="none" />
          {hook}
          {tips}
          {follow}
          {/* Fortschrittsleiste oben wie in Stories. */}
          <Rect id="progress-track" x={MARGIN} y={140} width={W - MARGIN * 2} height={8} cornerRadius={4} fill={ref('theme.colors.text')} opacity={0.2} />
          <Rect id="progress-fill" x={MARGIN} y={140} width={animate(0, W - MARGIN * 2, { duration: '10s', ease: 'linear' })} height={8} cornerRadius={4} fill={ref('theme.colors.text')} />
        </Scene>
      ),
    }),
  ],
});
