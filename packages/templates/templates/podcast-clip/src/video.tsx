/**
 * Podcast Clip (quadratisch 1080×1080): Wellenform aus Audio-Amplituden, Zitat, Sprecher. 12 s.
 *
 * Die Balken folgen den Amplituden aus `waveform.ts` (RMS je Frame eines Test-Tons,
 * erzeugt von `scripts/build-templates.mjs`). Jede Amplitude wird ein Keyframe.
 * Eigene Episode: Amplituden der eigenen Audiodatei berechnen, `AMPLITUDES` ersetzen
 * und die Datei per `<AudioTrack><AudioClip src="./episode.mp3" /></AudioTrack>` einbinden.
 *
 * Anpassen:
 * - Texte in `COPY` ändern.
 * - Farben kommen aus dem Theme (`settings.theme`).
 */
import { THEMES } from '@agentic-video/components';
import { Circle, Group, Rect, Scene, Text, animate, component, composition, keyframes, project, ref } from '@agentic-video/sdk';
import { AMPLITUDES, WAVEFORM_FPS } from './waveform.js';

const Badge = component('Badge');

const W = 1080;
const H = 1080;
const MARGIN = 90;

const COPY = {
  show: 'The Render Loop',
  episode: 'Ep. 18 · Deterministic pixels',
  quote: '“Every frame is a pure function of time. That is the whole trick.”',
  host: { name: 'Lea Brandt', initials: 'LB' },
  guest: { name: 'Sam Ortiz', initials: 'SO' },
} as const;

/** Wellenform: 3 Gruppen mit je 12 Balken; jede Gruppe folgt den Amplituden leicht versetzt. */
const GROUPS = 3;
const BARS_PER_GROUP = 12;
const BAR_W = 14;
const BAR_GAP = 10;
const WAVE_H = 260;
/** Nur jeden zweiten Frame als Keyframe: halb so viele Daten, kaum sichtbarer Unterschied. */
const STEP = 2;

/** Grundhöhe je Balken (0..1): in der Mitte hoch, am Rand niedrig, leicht unregelmäßig. */
function barProfile(index: number, count: number): number {
  const center = (count - 1) / 2;
  const bell = Math.exp(-(((index - center) / (count * 0.32)) ** 2));
  const ripple = 0.82 + 0.18 * Math.cos(index * 2.3);
  return 0.18 + 0.82 * bell * ripple;
}

/** Keyframes der Lautstärke, um `delayFrames` Frames verzögert. */
function amplitudeKeyframes(delayFrames: number) {
  const frames = [];
  for (let f = 0; f < AMPLITUDES.length; f += STEP) {
    const a = AMPLITUDES[Math.max(0, f - delayFrames)] ?? 0;
    frames.push({ t: f, v: { x: 1, y: 0.15 + 0.85 * a } });
  }
  return keyframes(frames);
}

const TOTAL_BARS = GROUPS * BARS_PER_GROUP;
const WAVE_W = TOTAL_BARS * BAR_W + (TOTAL_BARS - 1) * BAR_GAP;

const waveform = (
  <Group id="waveform" x={(W - WAVE_W) / 2} y={420}>
    {Array.from({ length: GROUPS }, (_, g) => (
      <Group id={`wave-${String(g + 1)}`} key={g} width={WAVE_W} height={WAVE_H} scale={amplitudeKeyframes(g * 2)}>
        {Array.from({ length: BARS_PER_GROUP }, (_, b) => {
          // Balken der Gruppen wechseln sich ab: 0,1,2,0,1,2 …
          const index = b * GROUPS + g;
          const h = WAVE_H * barProfile(index, TOTAL_BARS);
          return (
            <Rect
              id={`bar-${String(index + 1)}`}
              key={index}
              x={index * (BAR_W + BAR_GAP)}
              y={(WAVE_H - h) / 2}
              width={BAR_W}
              height={h}
              cornerRadius={BAR_W / 2}
              fill={ref(index % 4 === 0 ? 'theme.colors.accent' : 'theme.colors.primary')}
            />
          );
        })}
      </Group>
    ))}
  </Group>
);

/** Rundes Profilbild-Platzhalter mit Initialen und Namen. */
function Person(props: { id: string; x: number; name: string; initials: string; label: string }) {
  return (
    <Group id={props.id} x={props.x} y={880}>
      <Circle id={`${props.id}-avatar`} radius={40} fill={ref('theme.colors.surface')} stroke={ref('theme.colors.primary')} strokeWidth={3} />
      <Text id={`${props.id}-initials`} text={props.initials} y={24} width={80} textAlign="center" fontSize={28} fontWeight={700} fill={ref('theme.colors.text')} />
      <Text id={`${props.id}-name`} text={props.name} x={100} y={8} fontSize={30} fontWeight={700} fill={ref('theme.colors.text')} />
      <Text id={`${props.id}-label`} text={props.label} x={100} y={46} fontSize={22} fill={ref('theme.colors.muted')} />
    </Group>
  );
}

const DURATION_S = AMPLITUDES.length / WAVEFORM_FPS;

export default project({
  metadata: { title: 'Podcast Clip', description: 'Square audiogram with waveform bars, quote and speakers.', tags: ['podcast', 'audiogram', 'square'] },
  settings: { theme: THEMES.dark },
  compositions: [
    composition({
      id: 'main',
      width: W,
      height: H,
      fps: WAVEFORM_FPS,
      duration: `${String(DURATION_S)}s`,
      scene: (
        <Scene>
          <Rect id="background" width={W} height={H} fill={ref('theme.colors.background')} />
          <Rect id="card" x={40} y={40} width={W - 80} height={H - 80} cornerRadius={40} fill={ref('theme.colors.surface')} opacity={0.55} />
          <Badge id="badge" label="PODCAST" variant="primary" x={MARGIN} y={100} exit="none" />
          <Text id="show" text={COPY.show} x={MARGIN} y={160} fontSize={72} fontWeight={800} letterSpacing={-1.5} fill={ref('theme.colors.text')} />
          <Text id="episode" text={COPY.episode} x={MARGIN} y={250} fontSize={32} fill={ref('theme.colors.muted')} />
          {waveform}
          <Text
            id="quote"
            text={COPY.quote}
            x={MARGIN}
            y={720}
            width={W - MARGIN * 2}
            textAlign="center"
            fontSize={36}
            fontStyle="italic"
            lineHeight={1.35}
            fill={ref('theme.colors.text')}
            timing={{ from: '1s' }}
            textAnimation={{ unit: 'word', stagger: 3, duration: '0.4s', ease: 'easeOutCubic', from: { opacity: 0, y: 12 } }}
          />
          <Person id="host" x={MARGIN} name={COPY.host.name} initials={COPY.host.initials} label="Host" />
          <Person id="guest" x={W / 2 + 30} name={COPY.guest.name} initials={COPY.guest.initials} label="Guest" />
          {/* Abspielfortschritt am unteren Rand der Karte. */}
          <Rect id="progress-track" x={MARGIN} y={H - 84} width={W - MARGIN * 2} height={6} cornerRadius={3} fill={ref('theme.colors.muted')} opacity={0.3} />
          <Rect id="progress" x={MARGIN} y={H - 84} width={animate(0, W - MARGIN * 2, { duration: `${String(DURATION_S)}s`, ease: 'linear' })} height={6} cornerRadius={3} fill={ref('theme.colors.accent')} />
        </Scene>
      ),
    }),
  ],
});
