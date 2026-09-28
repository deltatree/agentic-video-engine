/**
 * Wortzeiten: Zerlegung von Text in Wörter mit Start- und Endzeit.
 */
import type { SubtitleCue } from '@agentic-video/core';
import { secondsToTime, timeToSeconds } from './time.js';

/** Ein Textstück mit bekannter Zeitspanne in Sekunden (z. B. eine Karaoke-Silbe). */
export interface TimedSegment {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** Ein Wort mit Zeiten in Sekunden. */
export interface WordTiming {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Verteilt die Zeit jedes Segments proportional auf seine sichtbaren Zeichen und fasst
 * Zeichen zwischen Leerraum zu Wörtern zusammen. Ein Wort darf über mehrere Segmente
 * reichen (Silben-Karaoke: `{\k20}hel{\k30}lo`).
 *
 * @example
 * ```ts
 * timedWords([{ text: 'hel', start: 0, end: 0.2 }, { text: 'lo world', start: 0.2, end: 1 }]);
 * // [{ text: 'hello', start: 0, end: ~0.43 }, { text: 'world', start: ~0.43, end: 1 }]
 * ```
 */
export function timedWords(segments: readonly TimedSegment[]): WordTiming[] {
  const words: WordTiming[] = [];
  let current: { text: string; start: number; end: number } | undefined;
  const close = () => {
    if (current !== undefined) words.push(current);
    current = undefined;
  };
  for (const seg of segments) {
    const chars = Array.from(seg.text);
    const visible = chars.filter((c) => !/\s/u.test(c)).length;
    const step = visible === 0 ? 0 : (seg.end - seg.start) / visible;
    let i = 0;
    for (const c of chars) {
      if (/\s/u.test(c)) {
        close();
        continue;
      }
      const t0 = seg.start + i * step;
      const t1 = seg.start + (i + 1) * step;
      i++;
      if (current === undefined) current = { text: c, start: t0, end: t1 };
      else {
        current.text += c;
        current.end = t1;
      }
    }
  }
  close();
  return words;
}

/**
 * Ergänzt fehlende Wortzeiten: Die Dauer des Cues wird proportional zur Zeichenzahl
 * auf die Wörter verteilt. Cues mit Wortzeiten bleiben unverändert.
 *
 * @example
 * ```ts
 * estimateWordTimings({ start: '0s', end: '1s', text: 'ab cd' }).words;
 * // [{ text: 'ab', start: '0s', end: '0.5s' }, { text: 'cd', start: '0.5s', end: '1s' }]
 * ```
 */
export function estimateWordTimings(cue: SubtitleCue, fps = 30): SubtitleCue {
  if (cue.words !== undefined && cue.words.length > 0) return cue;
  const start = timeToSeconds(cue.start, fps);
  const end = timeToSeconds(cue.end, fps);
  const words = timedWords([{ text: cue.text, start, end }]).map((w) => ({ text: w.text, start: secondsToTime(w.start), end: secondsToTime(w.end) }));
  return { ...cue, words };
}
