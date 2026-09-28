/**
 * Cinematic Title: Kinobalken, Staub im Licht, Titel mit sich schließender Laufweite. 10 s, 1920×1080.
 *
 * Anpassen:
 * - Texte in `COPY` ändern.
 * - Farben kommen aus dem Theme (`settings.theme`); die Kinobalken bleiben schwarz.
 */
import { THEMES } from '@agentic-video/components';
import { Ellipse, Group, Rect, Scene, Text, animate, component, composition, keyframes, project, ref } from '@agentic-video/sdk';

const ParticleField = component('ParticleField');
const Spotlight = component('Spotlight');

const W = 1920;
const H = 1080;
/** Höhe eines Kinobalkens für das Seitenverhältnis 2,39:1. */
const BAR = Math.round((H - W / 2.39) / 2);

const COPY = {
  presents: 'OPEN VIDEO PRESENTS',
  title: 'THE LAST FRAME',
  tagline: 'Every pixel has a past.',
  date: 'IN THEATERS · WINTER 2026',
} as const;

export default project({
  metadata: { title: 'Cinematic Title', description: 'Letterboxed film title with dust, light and tracking animation.', tags: ['cinematic', 'title', 'trailer'] },
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
          {/* Langsam wachsender Lichtkegel hinter dem Titel. */}
          <Ellipse
            id="light"
            x={W / 2 - 700}
            y={H / 2 - 260}
            width={1400}
            height={520}
            fill={ref('theme.colors.secondary')}
            filters={[{ type: 'blur', radius: 180 }]}
            opacity={keyframes([
              { t: 0, v: 0 },
              { t: '3s', v: 0.45, ease: 'easeInOutSine' },
              { t: '10s', v: 0.3 },
            ])}
            scale={animate({ x: 0.8, y: 0.8 }, { x: 1.15, y: 1.15 }, { duration: '10s', ease: 'easeOutSine' })}
          />
          <ParticleField id="dust" width={W} height={H} count={140} speed={12} size={3} direction={300} opacity={0.5} enter="none" exit="none" />
          <Text
            id="presents"
            text={COPY.presents}
            y={H / 2 - 150}
            width={W}
            textAlign="center"
            fontSize={26}
            fontWeight={500}
            letterSpacing={14}
            fill={ref('theme.colors.muted')}
            timing={{ from: '0.6s', duration: '2.6s' }}
            transition={{ in: { type: 'fade', duration: '0.8s' }, out: { type: 'fade', duration: '0.6s' } }}
          />
          {/* Titel: Laufweite schließt sich langsam, Unschärfe löst sich. */}
          <Group id="title-group" timing={{ from: '2.8s' }} transition={{ in: { type: 'blur', duration: '1.2s', ease: 'easeOutCubic' } }}>
            <Text
              id="title"
              text={COPY.title}
              y={H / 2 - 80}
              width={W}
              textAlign="center"
              fontSize={150}
              fontWeight={300}
              letterSpacing={animate(40, 20, { duration: '7.2s', ease: 'easeOutCubic' })}
              fill={ref('theme.colors.text')}
            />
            <Rect id="rule" x={W / 2 - 180} y={H / 2 + 110} width={360} height={2} fill={ref('theme.colors.text')} opacity={animate(0, 0.6, { from: '1.2s', duration: '1s' })} />
            <Text
              id="tagline"
              text={COPY.tagline}
              y={H / 2 + 140}
              width={W}
              textAlign="center"
              fontSize={40}
              fontStyle="italic"
              fontWeight={300}
              fill={ref('theme.colors.muted')}
              timing={{ from: '1.6s' }}
              opacity={animate(0, 1, { duration: '1s', ease: 'easeOutSine' })}
            />
          </Group>
          <Text
            id="date"
            text={COPY.date}
            y={H - BAR - 90}
            width={W}
            textAlign="center"
            fontSize={24}
            fontWeight={600}
            letterSpacing={10}
            fill={ref('theme.colors.accent')}
            timing={{ from: '6.4s' }}
            opacity={animate(0, 1, { duration: '0.8s' })}
          />
          {/* Vignette und Kinobalken liegen über allem. */}
          <Spotlight id="vignette" width={W} height={H} target={{ x: W / 2, y: H / 2 }} radius={760} softness={320} dim={0.55} ring={false} enter="none" exit="none" />
          <Rect id="bar-top" width={W} height={BAR} fill="#000000" />
          <Rect id="bar-bottom" y={H - BAR} width={W} height={BAR} fill="#000000" />
        </Scene>
      ),
    }),
  ],
});
