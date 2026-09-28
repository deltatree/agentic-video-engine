/**
 * Flusssteuerung wie in Motion Canvas: `all`, `any`, `chain`, `sequence`, `loop`,
 * `waitFor`, `waitUntil`, `delay`. Alle Tasks laufen symbolisch (siehe `runtime.ts`).
 */
import { OpenVideoError } from '@agentic-video/core';
import type { ThreadGenerator } from './runtime.js';

/**
 * Startet alle Tasks gleichzeitig und wartet, bis alle fertig sind.
 *
 * @example
 * ```ts
 * yield* all(rect.x(300, 1), rect.opacity(0, 1));
 * ```
 */
export function* all(...tasks: ThreadGenerator[]): ThreadGenerator {
  yield { kind: 'fork', tasks, join: 'all' };
}

/**
 * Startet alle Tasks gleichzeitig und wartet nur auf den ersten; die anderen laufen weiter.
 *
 * @example
 * ```ts
 * yield* any(rect.x(300, 2), waitFor(1));
 * ```
 */
export function* any(...tasks: ThreadGenerator[]): ThreadGenerator {
  yield { kind: 'fork', tasks, join: 'any' };
}

/**
 * Führt Tasks nacheinander aus.
 *
 * @example
 * ```ts
 * yield* chain(rect.x(300, 1), rect.x(0, 1));
 * ```
 */
export function* chain(...tasks: ThreadGenerator[]): ThreadGenerator {
  for (const task of tasks) yield* task;
}

/**
 * Wartet eine Zeit in Sekunden.
 *
 * @example
 * ```ts
 * yield* waitFor(0.5);
 * ```
 */
export function* waitFor(seconds = 0): ThreadGenerator {
  yield { kind: 'wait', seconds };
}

/**
 * Wartet auf ein benanntes Zeit-Event. Das Event wird als Composition-Marker exportiert.
 * Die Wartezeit kommt aus `toProject(…, { events })` (Standard 0 wie in Motion Canvas).
 *
 * @example
 * ```ts
 * yield* waitUntil('logo-in');
 * ```
 */
export function* waitUntil(event: string): ThreadGenerator {
  yield { kind: 'event', name: event };
}

/**
 * Führt einen Task oder eine Funktion nach einer Wartezeit aus.
 *
 * @example
 * ```ts
 * yield* delay(0.5, rect.opacity(1, 0.3));
 * yield* delay(1, () => rect.fill('#FF0000'));
 * ```
 */
export function* delay(seconds: number, task: ThreadGenerator | (() => void)): ThreadGenerator {
  yield { kind: 'wait', seconds };
  if (typeof task === 'function') task();
  else yield* task;
}

/**
 * Startet Tasks versetzt um `delaySeconds` und wartet, bis alle fertig sind.
 *
 * @example
 * ```ts
 * yield* sequence(0.1, a.opacity(1, 0.5), b.opacity(1, 0.5), c.opacity(1, 0.5));
 * ```
 */
export function* sequence(delaySeconds: number, ...tasks: ThreadGenerator[]): ThreadGenerator {
  yield { kind: 'fork', tasks: tasks.map((task, i) => delay(i * delaySeconds, task)), join: 'all' };
}

/**
 * Wiederholt einen Task `count`-mal nacheinander. Endlose Schleifen sind nicht erlaubt,
 * weil jede Szene eine feste Länge braucht.
 *
 * @example
 * ```ts
 * yield* loop(3, (i) => rect.rotation(120 * (i + 1), 0.5));
 * ```
 */
export function* loop(count: number, factory: (index: number) => ThreadGenerator | undefined): ThreadGenerator {
  if (!Number.isFinite(count) || count < 0) {
    throw new OpenVideoError({
      code: 'OV_MC_LOOP',
      errorClass: 'MotionCanvasAdapterError',
      problem: `loop() needs a finite, non-negative count, got ${String(count)}.`,
      suggestions: ['Use loop(3, (i) => ...) and repeat the scene with timing.loop if it must run forever.'],
    });
  }
  for (let i = 0; i < Math.floor(count); i++) {
    const task = factory(i);
    if (task !== undefined) yield* task;
  }
}
