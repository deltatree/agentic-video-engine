/**
 * Logo Reveal: Das Zeichen zeichnet sich, rückt nach links, die Wortmarke erscheint. 6 s, 1920×1080.
 *
 * Anpassen:
 * - `MARK` ist SVG-Pfad-Daten in einem 200×200-Raster (eigenes Logo einsetzen).
 * - Name und Unterzeile in `COPY` ändern.
 * - Farben kommen aus dem Theme (`settings.theme`).
 */
import { THEMES } from '@agentic-video/components';
import { Ellipse, Group, Rect, RichText, Scene, Text, animate, component, composition, keyframes, project, ref } from '@agentic-video/sdk';

const Logo = component('Logo');

const W = 1920;
const H = 1080;

/** Eigenes Zeichen: Sechseck mit ausgespartem Play-Dreieck (evenodd). */
const MARK = 'M 100 10 L 178 55 L 178 145 L 100 190 L 22 145 L 22 55 Z M 80 62 L 142 100 L 80 138 Z';

const COPY = {
  first: 'Lumen',
  second: 'Studio',
  tagline: 'MOTION, RENDERED BY CODE',
} as const;

const LOGO = 220;
/** Endlage: Zeichen und Wortmarke zusammen mittig. */
const END_X = 560;

export default project({
  metadata: { title: 'Logo Reveal', description: 'Mark draws itself, then the wordmark appears.', tags: ['brand', 'logo'] },
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
          {/* Weicher Lichtschein hinter dem Zeichen. */}
          <Ellipse
            id="glow"
            x={560}
            y={140}
            width={800}
            height={800}
            fill={ref('theme.colors.primary')}
            filters={[{ type: 'blur', radius: 160 }]}
            opacity={keyframes([
              { t: 0, v: 0.1 },
              { t: '1.2s', v: 0.35, ease: 'easeOutCubic' },
              { t: '6s', v: 0.25 },
            ])}
          />
          <Group
            id="mark"
            y={(H - LOGO) / 2}
            x={keyframes([
              { t: 0, v: (W - LOGO) / 2 },
              { t: '2s', v: (W - LOGO) / 2 },
              { t: '2.8s', v: END_X, ease: 'easeInOutCubic' },
            ])}
            scale={keyframes([
              { t: 0, v: { x: 0.85, y: 0.85 } },
              { t: '1.6s', v: { x: 1, y: 1 }, ease: 'easeOutCubic' },
            ])}
          >
            <Logo id="mark-logo" path={MARK} viewBox={{ width: 200, height: 200 }} width={LOGO} height={LOGO} reveal="trim" duration="1.6s" exit="none" />
          </Group>
          <RichText
            id="wordmark"
            x={END_X + LOGO + 48}
            y={H / 2 - 88}
            fontSize={132}
            fontWeight={800}
            letterSpacing={-3}
            spans={[
              { text: COPY.first, fill: ref('theme.colors.text') },
              { text: COPY.second, fill: ref('theme.colors.primary'), fontWeight: 400 },
            ]}
            timing={{ from: '2.5s' }}
            textAnimation={{ unit: 'char', stagger: 2, duration: '0.5s', ease: 'easeOutCubic', from: { opacity: 0, x: -24 } }}
          />
          <Text
            id="tagline"
            text={COPY.tagline}
            x={END_X + LOGO + 54}
            y={H / 2 + 84}
            fontSize={30}
            fontWeight={500}
            letterSpacing={8}
            fill={ref('theme.colors.muted')}
            timing={{ from: '3.4s' }}
            opacity={animate(0, 1, { duration: '0.6s', ease: 'easeOutCubic' })}
          />
        </Scene>
      ),
    }),
  ],
});
