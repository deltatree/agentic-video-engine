/**
 * Zeitliche Einbettung einer Node in die Zeit ihres Elternteils (FR-13, FR-16).
 *
 * Reihenfolge der Abbildung vom Eltern-Frame P auf den Inhalts-Frame t:
 * 1. `rel = P - from`; die Node ist aktiv für `0 <= rel < duration`.
 * 2. `remap` (Sekunden als Funktion von rel) ersetzt Schritte 3–5, falls gesetzt.
 * 3. `speed` streckt die Zeit: `t = rel * speed`.
 * 4. `loop` mit `loopDuration` wiederholt den Bereich, optional `pingPong`.
 * 5. `reverse` spielt den Inhalt rückwärts über das Zeitfenster.
 * 6. `hold` friert den Inhalt auf einem festen Frame ein.
 */
import type { Timing } from '@agentic-video/schema';
import { evaluateAnimated } from './animated.js';
import { toFrames, type TimeContext } from './time.js';

/** Ergebnis der Zeitabbildung einer Node. */
export interface LocalTime {
  /** Ist die Node in diesem Frame sichtbar? */
  readonly active: boolean;
  /** Frame relativ zum Start der Node (vor Speed, Loop, Reverse). */
  readonly relFrame: number;
  /** Inhalts-Frame, an dem Animationen der Node ausgewertet werden. */
  readonly localFrame: number;
  /** Länge des Zeitfensters in Frames. */
  readonly durationFrames: number;
  /** Fortschritt im Zeitfenster, 0..1. */
  readonly progress: number;
  /** Composition-Frame, an dem rel = 0 gilt (für Marker-Verweise). */
  readonly startFrame: number;
}

/** Kontext der Zeitabbildung. */
export interface TimingContext extends TimeContext {
  readonly seed: number;
  /** Composition-Frame, an dem der Elternteil beginnt. */
  readonly parentStart: number;
  /** Dauer des Elternteils in Frames (Standard für `duration`). */
  readonly parentDuration: number;
}

/**
 * Bildet den Eltern-Frame auf die lokale Zeit einer Node ab.
 *
 * @example
 * ```ts
 * computeLocalTime({ from: '1s', duration: '2s', speed: 2 }, 45, { fps: 30, seed: 0, parentStart: 0, parentDuration: 300 });
 * // { active: true, relFrame: 15, localFrame: 30, durationFrames: 60, progress: 0.25, startFrame: 30 }
 * ```
 */
export function computeLocalTime(timing: Timing | undefined, parentFrame: number, ctx: TimingContext): LocalTime {
  const from = timing?.from !== undefined ? toFrames(timing.from, ctx) : 0;
  const duration = timing?.duration !== undefined ? toFrames(timing.duration, ctx) : ctx.parentDuration - from;
  const rel = parentFrame - from;
  const active = rel >= 0 && rel < duration;
  const startFrame = ctx.parentStart + from;
  let t: number;

  if (timing?.remap !== undefined) {
    const seconds = evaluateAnimated(timing.remap, { frame: rel, fps: ctx.fps, seed: ctx.seed, durationFrames: duration });
    t = typeof seconds === 'number' ? seconds * ctx.fps : rel;
  } else {
    const speed = timing?.speed ?? 1;
    t = rel * speed;
    const loopDuration = timing?.loopDuration !== undefined ? toFrames(timing.loopDuration, ctx) : undefined;
    if (timing?.loop !== undefined && loopDuration !== undefined && loopDuration > 0 && t >= 0) {
      const maxCycles = timing.loop === 'infinite' ? Number.POSITIVE_INFINITY : timing.loop;
      const cycle = Math.floor(t / loopDuration);
      if (cycle < maxCycles) {
        const within = t - cycle * loopDuration;
        t = timing.pingPong === true && cycle % 2 === 1 ? loopDuration - within : within;
      } else {
        t = timing.pingPong === true && maxCycles % 2 === 0 ? 0 : loopDuration;
      }
    } else if (timing?.pingPong === true && duration > 0) {
      // Ping-Pong ohne Loop: vorwärts in der ersten, rückwärts in der zweiten Hälfte
      const half = (duration * speed) / 2;
      t = t <= half ? t * 2 : (duration * speed - t) * 2;
    }
    if (timing?.reverse === true && Number.isFinite(duration)) {
      t = Math.max(0, (duration - 1) * speed - t);
    }
  }
  if (timing?.hold !== undefined) t = toFrames(timing.hold, ctx);

  return {
    active,
    relFrame: rel,
    localFrame: t,
    durationFrames: duration,
    progress: duration > 0 ? Math.min(Math.max(rel / duration, 0), 1) : 0,
    startFrame,
  };
}
