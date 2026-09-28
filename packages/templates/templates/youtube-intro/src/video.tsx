/**
 * YouTube Intro: Play-Zeichen springt ins Bild, Kanalname und Folge erscheinen. 6 s, 1920×1080.
 *
 * Anpassen:
 * - Kanalname und Folge in `COPY` ändern.
 * - Farben kommen aus dem Theme (`settings.theme`).
 */
import { THEMES } from '@agentic-video/components';
import { Group, Polygon, Rect, Scene, Text, animate, component, composition, keyframes, project, ref } from '@agentic-video/sdk';

const Badge = component('Badge');
const GradientBackground = component('GradientBackground');
const ParticleField = component('ParticleField');

const W = 1920;
const H = 1080;

const COPY = {
  channel: 'BUILD WITH CODE',
  badge: 'NEW EPISODE',
  episode: 'Ep. 42 · Rendering at scale',
} as const;

const ICON_W = 240;
const ICON_H = 168;

export default project({
  metadata: { title: 'YouTube Intro', description: 'Channel intro with play mark, channel name and episode.', tags: ['youtube', 'intro'] },
  settings: { theme: THEMES.dark },
  compositions: [
    composition({
      id: 'main',
      width: W,
      height: H,
      fps: 30,
      duration: '6s',
      scene: (
        <Scene>
          <Rect id="background" width={W} height={H} fill={ref('theme.colors.background')} />
          <GradientBackground id="gradient" width={W} height={H} speed={24} enter="none" exit="none" />
          <ParticleField id="sparks" width={W} height={H} count={90} speed={60} direction={270} opacity={0.6} enter="none" exit="none" />
          <Group id="content" timing={{ from: 0, duration: '6s' }} transition={{ out: { type: 'zoom-in', duration: '0.5s', ease: 'easeInCubic' } }}>
            {/* Play-Zeichen: federt mit Überschwinger ins Bild. */}
            <Group
              id="icon"
              x={(W - ICON_W) / 2}
              y={250}
              width={ICON_W}
              height={ICON_H}
              scale={keyframes([
                { t: 0, v: { x: 0, y: 0 } },
                { t: '0.2s', v: { x: 0, y: 0 } },
                { t: '0.75s', v: { x: 1, y: 1 }, ease: 'easeOutBack' },
              ])}
              rotation={keyframes([
                { t: '0.2s', v: -12 },
                { t: '0.9s', v: 0, ease: 'easeOutBack' },
              ])}
            >
              <Rect id="icon-body" width={ICON_W} height={ICON_H} cornerRadius={48} fill={ref('theme.colors.primary')} shadow={{ color: '#00000066', blur: 40, offsetY: 16 }} />
              <Polygon
                id="icon-play"
                points={[
                  [98, 52],
                  [158, 84],
                  [98, 116],
                ]}
                fill="#FFFFFF"
                strokeJoin="round"
                stroke="#FFFFFF"
                strokeWidth={10}
              />
            </Group>
            <Text
              id="channel"
              text={COPY.channel}
              y={500}
              width={W}
              textAlign="center"
              fontSize={128}
              fontWeight={900}
              letterSpacing={6}
              fill={ref('theme.colors.text')}
              timing={{ from: '0.8s' }}
              textAnimation={{ unit: 'char', stagger: 1, duration: '0.45s', ease: 'easeOutBack', from: { opacity: 0, y: 60, scale: 0.6 } }}
            />
            <Badge id="badge" label={COPY.badge} variant="accent" x={W / 2 - 110} y={700} timing={{ from: '1.8s' }} enter="scale" exit="none" />
            <Text
              id="episode"
              text={COPY.episode}
              y={780}
              width={W}
              textAlign="center"
              fontSize={44}
              fontWeight={500}
              fill={ref('theme.colors.muted')}
              timing={{ from: '2.1s' }}
              opacity={animate(0, 1, { duration: '0.5s', ease: 'easeOutCubic' })}
            />
          </Group>
        </Scene>
      ),
    }),
  ],
});
