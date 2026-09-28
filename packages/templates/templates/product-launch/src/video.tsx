/**
 * Product Launch: Ankündigung, drei Vorteile, Aufruf zum Handeln. 12 s, 1920×1080.
 *
 * Anpassen:
 * - Texte in `COPY` ändern.
 * - Farben kommen aus dem Theme (`settings.theme`); `THEMES.light` färbt alles um.
 */
import { THEMES } from '@agentic-video/components';
import { Group, Rect, Scene, Text, animate, component, composition, project, ref } from '@agentic-video/sdk';

const Badge = component('Badge');
const Title = component('Title');
const Subtitle = component('Subtitle');
const Card = component('Card');
const BrowserWindow = component('BrowserWindow');
const GradientBackground = component('GradientBackground');
const ParticleField = component('ParticleField');

const W = 1920;
const H = 1080;

const COPY = {
  badge: 'INTRODUCING',
  product: 'Nova One',
  tagline: 'Render studio-grade video straight from your codebase.',
  features: [
    { title: 'Frame-exact', body: 'Every frame is a pure function of time. Same input, same pixels.' },
    { title: 'Agent-ready', body: 'A typed API that coding agents can drive end to end.' },
    { title: 'Scales out', body: 'Split renders across workers and stitch them losslessly.' },
  ],
  cta: 'Available today',
  url: 'nova.example.com',
} as const;

/** Szene 1: Produktname mit Badge und Unterzeile (0–4,4 s). */
const intro = (
  <Group id="intro" timing={{ from: 0, duration: '4.4s' }} transition={{ out: { type: 'zoom-in', duration: '0.5s', ease: 'easeInCubic' } }}>
    <Badge id="intro-badge" label={COPY.badge} variant="primary" x={160} y={330} />
    <Title id="intro-title" text={COPY.product} fontSize={168} width={1600} x={160} y={400} timing={{ from: '0.3s' }} />
    <Subtitle id="intro-tagline" text={COPY.tagline} width={1400} fontSize={44} x={160} y={640} timing={{ from: '1.1s' }} />
  </Group>
);

/** Szene 2: drei Vorteile als Karten, versetzt eingeblendet (4,2–8,6 s). */
const features = (
  <Group id="features" timing={{ from: '4.2s', duration: '4.4s' }} transition={{ in: { type: 'fade', duration: '0.4s' }, out: { type: 'slide-left', duration: '0.5s', ease: 'easeInCubic' } }}>
    <Text id="features-heading" text="Why teams switch" x={160} y={200} fontSize={72} fontWeight={800} letterSpacing={-1.5} fill={ref('theme.colors.text')} />
    {COPY.features.map((f, i) => (
      <Card
        id={`feature-${String(i + 1)}`}
        key={f.title}
        title={f.title}
        body={f.body}
        width={500}
        height={220}
        x={160 + i * 540}
        y={400}
        timing={{ from: `${String(0.3 + i * 0.25)}s` }}
        enter="slide-up"
      />
    ))}
  </Group>
);

/** Szene 3: Produktfenster und Aufruf (8,4–12 s). */
const cta = (
  <Group id="cta" timing={{ from: '8.4s' }} transition={{ in: { type: 'slide-left', duration: '0.5s', ease: 'easeOutCubic' } }}>
    <BrowserWindow id="cta-window" url={COPY.url} width={900} height={560} x={860} y={260} enter="scale" exit="none">
      <Rect id="cta-hero" x={48} y={56} width={320} height={24} cornerRadius={12} fill={ref('theme.colors.primary')} />
      <Rect id="cta-line-1" x={48} y={112} width={620} height={16} cornerRadius={8} fill={ref('theme.colors.muted')} opacity={0.5} />
      <Rect id="cta-line-2" x={48} y={144} width={520} height={16} cornerRadius={8} fill={ref('theme.colors.muted')} opacity={0.5} />
      <Rect id="cta-chart" x={48} y={200} width={804} height={240} cornerRadius={16} fill={ref('theme.colors.background')} opacity={0.6} />
      <Rect id="cta-bar" x={80} y={380} width={animate(0, 740, { from: '0.4s', duration: '1.6s', ease: 'easeOutCubic' })} height={24} cornerRadius={12} fill={ref('theme.colors.accent')} />
    </BrowserWindow>
    <Text id="cta-product" text={COPY.product} x={160} y={360} fontSize={96} fontWeight={800} letterSpacing={-2} fill={ref('theme.colors.text')} />
    <Text id="cta-line" text={COPY.cta} x={160} y={480} fontSize={48} fontWeight={500} fill={ref('theme.colors.accent')} />
    <Group id="cta-button" x={160} y={580} timing={{ from: '0.6s' }} transition={{ in: { type: 'fade', duration: '0.4s' } }}>
      <Rect id="cta-button-bg" width={420} height={84} cornerRadius={42} fill={ref('theme.colors.primary')} />
      <Text id="cta-button-label" text={COPY.url} y={24} width={420} textAlign="center" fontSize={30} fontWeight={600} fill="#FFFFFF" />
    </Group>
  </Group>
);

export default project({
  metadata: { title: 'Product Launch', description: 'Announcement, three benefits and a call to action.', tags: ['marketing', 'launch'] },
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
          <GradientBackground id="glow" width={W} height={H} opacity={0.55} enter="none" exit="none" />
          <ParticleField id="particles" width={W} height={H} count={60} opacity={0.35} enter="none" exit="none" />
          {intro}
          {features}
          {cta}
        </Scene>
      ),
    }),
  ],
});
