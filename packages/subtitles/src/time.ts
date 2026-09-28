/**
 * Zeitdarstellung der Untertitel.
 *
 * Entscheidung: Cues und Wortzeiten in der IR tragen Zeiten als Sekunden-Texte
 * mit Einheit, z. B. `"1.5s"` (höchstens drei Nachkommastellen, also Millisekunden).
 * Grund: Untertitel-Formate zählen in (Milli-)Sekunden, nicht in Frames. So bleibt
 * ein Track unabhängig von der Framerate der Composition, und SRT/VTT lassen sich
 * ohne Rundungsverlust wieder exportieren.
 */
import { toSeconds, type TimeValue } from '@agentic-video/core';

/**
 * Wandelt Sekunden in einen IR-Zeitwert `"<sekunden>s"` (auf Millisekunden gerundet).
 *
 * @example
 * ```ts
 * secondsToTime(1.5); // "1.5s"
 * secondsToTime(3723.0004); // "3723s"
 * ```
 */
export function secondsToTime(seconds: number): string {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  const whole = Math.floor(ms / 1000);
  const frac = ms % 1000;
  if (frac === 0) return `${whole}s`;
  return `${whole}.${String(frac).padStart(3, '0').replace(/0+$/u, '')}s`;
}

/**
 * Liest einen IR-Zeitwert als Sekunden. Zahlen sind Frames und brauchen `fps`.
 *
 * @example
 * ```ts
 * timeToSeconds('1.5s'); // 1.5
 * timeToSeconds(48, 24); // 2
 * ```
 */
export function timeToSeconds(value: TimeValue, fps = 30, markers?: ReadonlyMap<string, number>): number {
  return toSeconds(value, { fps, ...(markers !== undefined ? { markers } : {}) });
}
