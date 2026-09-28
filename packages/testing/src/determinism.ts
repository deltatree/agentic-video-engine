/**
 * Determinismus-Prüfung: Ein Frame muss unabhängig von der Render-Reihenfolge gleich sein.
 */
import type { RgbaImage } from '@agentic-video/core';
import { imageHash } from './images.js';

/** Ergebnis von {@link determinism}. */
export interface DeterminismResult {
  /** `true`, wenn jeder Frame vorwärts und rückwärts denselben Hash hat. */
  readonly deterministic: boolean;
  /** Frames mit unterschiedlichem Hash. */
  readonly mismatches: readonly number[];
  /** Hash je Frame aus dem Vorwärtslauf. */
  readonly forward: ReadonlyMap<number, string>;
  /** Hash je Frame aus dem Rückwärtslauf. */
  readonly backward: ReadonlyMap<number, string>;
}

/**
 * Rendert die Frames erst vorwärts, dann rückwärts, und vergleicht die Bild-Hashes.
 * Verborgener Zustand zwischen Frames (z. B. Simulation ohne Seek) fällt so auf.
 *
 * @example
 * ```ts
 * const result = await determinism((f) => renderFrame(project, f), [0, 1, 2, 30, 59]);
 * expect(result.mismatches).toEqual([]);
 * ```
 */
export async function determinism(fn: (frame: number) => RgbaImage | Promise<RgbaImage>, frames: readonly number[]): Promise<DeterminismResult> {
  const forward = new Map<number, string>();
  const backward = new Map<number, string>();
  for (const f of frames) forward.set(f, imageHash(await fn(f)));
  for (const f of [...frames].reverse()) backward.set(f, imageHash(await fn(f)));
  const mismatches = [...new Set(frames)].filter((f) => forward.get(f) !== backward.get(f));
  return { deterministic: mismatches.length === 0, mismatches, forward, backward };
}
