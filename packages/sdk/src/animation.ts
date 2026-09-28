/**
 * Animations-Helfer des SDK. `animate`, `keyframes`, `expr`, `ref`, `stagger` und
 * `sequence` kommen unverändert aus der Timeline. `spring` kennt zusätzlich die
 * Remotion-Form mit `frame`, die in Frame-Funktionen sofort eine Zahl liefert.
 */
import { OpenVideoError, spring as springData, springProgress, type AnimatedValue, type SpringOptions } from '@agentic-video/core';

export { animate, expr, keyframes, ref, sequence, stagger } from '@agentic-video/core';

/** Kontext des gerade ausgewerteten Frames (setzt `toIR`). */
export interface FrameContext {
  readonly frame: number;
  readonly fps: number;
}

let current: FrameContext | undefined;

/**
 * Führt `fn` mit gesetztem Frame-Kontext aus (für `spring` ohne `fps`).
 *
 * @example
 * ```ts
 * withFrameContext({ frame: 10, fps: 30 }, () => spring({ frame: 10 }));
 * ```
 */
export function withFrameContext<T>(context: FrameContext, fn: () => T): T {
  const previous = current;
  current = context;
  try {
    return fn();
  } finally {
    current = previous;
  }
}

/** Remotion-kompatible Feder: sofort ausgewertet. */
export interface FrameSpringOptions {
  /** Frame, an dem ausgewertet wird (die Feder startet bei Frame 0). */
  readonly frame: number;
  /** Startwert (Standard 0). */
  readonly from?: number;
  /** Zielwert (Standard 1). */
  readonly to?: number;
  /** Bilder pro Sekunde (Standard: fps der gerade ausgewerteten Composition). */
  readonly fps?: number;
  readonly config?: { readonly stiffness?: number; readonly damping?: number; readonly mass?: number; readonly velocity?: number };
}

function isFrameSpring(options: FrameSpringOptions | SpringOptions<unknown>): options is FrameSpringOptions {
  return 'frame' in options;
}

/**
 * Feder-Animation in zwei Formen:
 * - Daten-Form `spring({ from, to, at?, stiffness? … })` → `$spring` in der IR.
 * - Remotion-Form `spring({ frame, from?, to?, fps?, config? })` → Zahl für diesen Frame
 *   (Standard-Feder: stiffness 100, damping 10, mass 1).
 *
 * @example
 * ```ts
 * spring({ from: 0, to: 1, at: 20 });        // { $spring: … }
 * spring({ frame: 15, fps: 30 });             // ≈ 0.95
 * ```
 */
export function spring(options: FrameSpringOptions): number;
export function spring<T>(options: SpringOptions<T>): AnimatedValue<T>;
export function spring<T>(options: FrameSpringOptions | SpringOptions<T>): number | AnimatedValue<T> {
  if (!isFrameSpring(options)) return springData(options);
  const fps = options.fps ?? current?.fps;
  if (fps === undefined) {
    throw new OpenVideoError({
      code: 'OV_SDK_SPRING_FPS',
      errorClass: 'SdkError',
      problem: 'spring({ frame }) needs fps outside of a composition scene function.',
      suggestions: ['spring({ frame, fps: 30 })', 'Call spring inside scene: ({ frame }) => … so fps comes from the composition.'],
    });
  }
  const from = options.from ?? 0;
  const to = options.to ?? 1;
  const c = options.config ?? {};
  const params = {
    ...(c.stiffness !== undefined ? { stiffness: c.stiffness } : {}),
    ...(c.damping !== undefined ? { damping: c.damping } : {}),
    ...(c.mass !== undefined ? { mass: c.mass } : {}),
    ...(c.velocity !== undefined ? { velocity: c.velocity } : {}),
  };
  return from + (to - from) * springProgress(options.frame / fps, params);
}
