/**
 * Subtitle Video: Sprecher-Karte und Untertitel mit Wort-Hervorhebung. 12 s, 1920×1080.
 *
 * Die Untertitel stehen direkt im Code (`CUES`). Eine .srt- oder .vtt-Datei geht auch:
 * `<SubtitleTrack src="./captions.srt" … />`.
 *
 * Anpassen:
 * - Text und Zeiten in `CUES` ändern (Sekunden als "1.5s").
 * - Farben kommen aus dem Theme (`settings.theme`); das Hervorheben nutzt `colors.accent`.
 */
import { THEMES } from '@agentic-video/components';
import { Circle, Group, Rect, Scene, SubtitleTrack, Text, component, composition, keyframes, project, ref } from '@agentic-video/sdk';

const GradientBackground = component('GradientBackground');
const Badge = component('Badge');

const W = 1920;
const H = 1080;

const SPEAKER = { name: 'Jonas Weber', initials: 'JW', role: 'Product Designer' };

const CUES = [
  { start: '0.4s', end: '3.2s', text: 'Most teams still edit every video by hand.', speaker: 'JW' },
  { start: '3.4s', end: '6.4s', text: 'We describe the video as code instead.', speaker: 'JW' },
  { start: '6.6s', end: '9.2s', text: 'Change one line, and every frame updates.', speaker: 'JW' },
  { start: '9.4s', end: '12s', text: 'Subtitles included, perfectly in sync.', speaker: 'JW' },
];

export default project({
  metadata: { title: 'Subtitle Video', description: 'Talking-head style layout with inline, word-highlighted subtitles.', tags: ['subtitles', 'captions'] },
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
          <GradientBackground id="gradient" width={W} height={H} opacity={0.7} speed={6} enter="none" exit="none" />
          {/* Platzhalter für das Sprecherbild: großer Kreis mit Initialen, pulsiert beim Sprechen. */}
          <Group id="speaker" x={(W - 360) / 2} y={220}>
            <Circle
              id="speaker-halo"
              radius={180}
              fill={ref('theme.colors.primary')}
              opacity={keyframes(
                [
                  { t: 0, v: 0.15 },
                  { t: '0.4s', v: 0.35, ease: 'easeInOutSine' },
                  { t: '0.8s', v: 0.15, ease: 'easeInOutSine' },
                ],
                { loop: 'repeat' },
              )}
              scale={{ x: 1.18, y: 1.18 }}
            />
            <Circle id="speaker-avatar" radius={180} fill={ref('theme.colors.surface')} stroke={ref('theme.colors.primary')} strokeWidth={6} />
            <Text id="speaker-initials" text={SPEAKER.initials} y={118} width={360} textAlign="center" fontSize={112} fontWeight={800} fill={ref('theme.colors.text')} />
          </Group>
          <Text id="speaker-name" text={SPEAKER.name} y={650} width={W} textAlign="center" fontSize={48} fontWeight={700} fill={ref('theme.colors.text')} />
          <Text id="speaker-role" text={SPEAKER.role} y={714} width={W} textAlign="center" fontSize={30} fill={ref('theme.colors.muted')} />
          <Badge id="badge" label="CC" variant="muted" x={W - 200} y={80} exit="none" />
          <SubtitleTrack
            id="captions"
            track="captions"
            language="en"
            cues={CUES}
            style="word-highlight"
            position="bottom"
            fontSize={54}
            fontWeight={700}
            color={ref('theme.colors.text')}
            highlightColor={ref('theme.colors.accent')}
            box={{ color: '#000000A0', paddingX: 28, paddingY: 14, radius: 14 }}
            maxWidth={1400}
            safeArea={0.08}
          />
        </Scene>
      ),
    }),
  ],
});
