/**
 * Wortzeiten und Zeitwerte.
 *
 * Diese beiden kleinen Funktionen spiegeln `secondsToTime` und `estimateWordTimings`
 * aus `@agentic-video/subtitles`. Die Abhängigkeitsregeln (AD-14) erlauben `speech`
 * nur `core`, `cache` und `ffmpeg`; deshalb liegt hier eine eigene Kopie.
 * Das Format ist dasselbe: Sekunden-Texte wie `"1.5s"`.
 */

/** Ein Wort mit Zeiten in Sekunden. */
export interface TimedWord {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Wandelt Sekunden in einen IR-Zeitwert `"<sekunden>s"` (auf Millisekunden gerundet).
 *
 * @example
 * ```ts
 * secondsTime(1.5); // "1.5s"
 * ```
 */
export function secondsTime(seconds: number): string {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  const frac = ms % 1000;
  const whole = Math.floor(ms / 1000);
  return frac === 0 ? `${whole}s` : `${whole}.${String(frac).padStart(3, '0').replace(/0+$/u, '')}s`;
}

/**
 * Verteilt die Spanne `start..end` proportional zur Zeichenzahl auf die Wörter von `text`.
 *
 * @example
 * ```ts
 * estimateWords('ab cd', 0, 1); // [{ text: 'ab', start: 0, end: 0.5 }, { text: 'cd', start: 0.5, end: 1 }]
 * ```
 */
export function estimateWords(text: string, start: number, end: number): TimedWord[] {
  const words = text.split(/\s+/u).filter((w) => w !== '');
  const total = words.reduce((n, w) => n + Array.from(w).length, 0);
  if (total === 0) return [];
  const step = (end - start) / total;
  let cursor = start;
  return words.map((w) => {
    const s = cursor;
    cursor += Array.from(w).length * step;
    return { text: w, start: s, end: cursor };
  });
}
