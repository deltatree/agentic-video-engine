/**
 * Lower Third mit transparentem Hintergrund (Alpha): Name und Rolle für Interviews. 6 s, 1920×1080.
 *
 * Die Composition hat keinen Hintergrund. Das Profil `alpha` rendert ProRes 4444 mit Alphakanal,
 * `alpha-webm` VP9 mit Alpha. So lässt sich die Einblendung in jedem Schnittprogramm über Video legen.
 *
 * Anpassen:
 * - Name, Rolle und Thema in `COPY` ändern.
 * - Farben kommen aus dem Theme (`settings.theme`).
 */
import { THEMES } from '@agentic-video/components';
import { Group, Rect, Scene, Text, component, composition, keyframes, project, ref } from '@agentic-video/sdk';

const LowerThird = component('LowerThird');

const W = 1920;
const H = 1080;
const MARGIN = 120;

const COPY = {
  name: 'Dr. Maya Okafor',
  role: 'Head of Rendering, Lumen Studio',
  topic: 'LIVE · Deterministic video at scale',
} as const;

export default project({
  metadata: { title: 'Lower Third', description: 'Name and role overlay with alpha channel.', tags: ['overlay', 'alpha', 'interview'] },
  settings: { theme: THEMES.dark },
  renderProfiles: [
    { id: 'alpha', format: 'mov', codec: 'prores-4444', alpha: true },
    { id: 'alpha-webm', format: 'webm', codec: 'vp9', alpha: true },
  ],
  compositions: [
    composition({
      id: 'main',
      width: W,
      height: H,
      fps: 30,
      duration: '6s',
      // Kein Scene-Hintergrund: alles außerhalb der Einblendung bleibt durchsichtig.
      scene: (
        <Scene>
          {/* `name` ist auch ein Feld jeder Node; deshalb steht es ausdrücklich in `props`. */}
          <LowerThird id="lower-third" props={{ name: COPY.name, role: COPY.role }} width={760} x={MARGIN} y={H - 330} timing={{ from: '0.3s', duration: '5.4s' }} />
          {/* Themen-Zeile über der Einblendung: Punkt pulsiert wie ein Live-Signal. */}
          <Group id="topic" x={MARGIN} y={H - 390} timing={{ from: '0.9s', duration: '4.8s' }} transition={{ in: { type: 'fade', duration: '0.4s' }, out: { type: 'fade', duration: '0.3s' } }}>
            <Rect id="topic-bg" width={560} height={44} cornerRadius={8} fill={ref('theme.colors.background')} opacity={0.8} />
            <Rect
              id="topic-dot"
              x={18}
              y={15}
              width={14}
              height={14}
              cornerRadius={7}
              fill={ref('theme.colors.danger')}
              opacity={keyframes(
                [
                  { t: 0, v: 1 },
                  { t: '0.5s', v: 0.3, ease: 'easeInOutSine' },
                  { t: '1s', v: 1, ease: 'easeInOutSine' },
                ],
                { loop: 'repeat' },
              )}
            />
            <Text id="topic-text" text={COPY.topic} x={46} y={9} fontSize={22} fontWeight={600} letterSpacing={2} fill={ref('theme.colors.text')} />
          </Group>
        </Scene>
      ),
    }),
  ],
});
