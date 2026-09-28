/**
 * Farbmatrizen für CSS-Filter (brightness, contrast, saturate, grayscale, sepia, invert,
 * hue-rotate, color-matrix). 4×5-Matrix zeilenweise, Verschiebung in 0..1, angewendet auf
 * nicht vormultiplizierte Farben – wie der `ColorMatrixFilter` von PixiJS und wie Skia.
 */

import type { ColorMatrix } from 'pixi.js';

/** Macht aus 20 Zahlen die Tupel-Form, die der `ColorMatrixFilter` von PixiJS erwartet. */
export function toColorMatrix(m: readonly number[]): ColorMatrix {
  const v = (i: number): number => m[i] ?? 0;
  return [v(0), v(1), v(2), v(3), v(4), v(5), v(6), v(7), v(8), v(9), v(10), v(11), v(12), v(13), v(14), v(15), v(16), v(17), v(18), v(19)];
}

/** Luma-Gewichte (Rec. 709) für Luminanz-Masken. */
export const LUMA = [0.2126, 0.7152, 0.0722] as const;

function saturateMatrix(s: number): number[] {
  return [
    0.2126 + 0.7874 * s, 0.7152 - 0.7152 * s, 0.0722 - 0.0722 * s, 0, 0,
    0.2126 - 0.2126 * s, 0.7152 + 0.2848 * s, 0.0722 - 0.0722 * s, 0, 0,
    0.2126 - 0.2126 * s, 0.7152 - 0.7152 * s, 0.0722 + 0.9278 * s, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

function hueRotateMatrix(degrees: number): number[] {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0, 0,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283, 0, 0,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

/**
 * Liefert die Farbmatrix eines Filters oder `undefined` (z. B. für `blur`).
 *
 * @example
 * ```ts
 * filterMatrix({ type: 'grayscale', amount: 1 });
 * ```
 */
export function filterMatrix(filter: Readonly<Record<string, unknown>>): number[] | undefined {
  const amount = typeof filter['amount'] === 'number' ? filter['amount'] : 1;
  switch (filter['type']) {
    case 'brightness':
      return [amount, 0, 0, 0, 0, 0, amount, 0, 0, 0, 0, 0, amount, 0, 0, 0, 0, 0, 1, 0];
    case 'contrast': {
      const o = (1 - amount) / 2;
      return [amount, 0, 0, 0, o, 0, amount, 0, 0, o, 0, 0, amount, 0, o, 0, 0, 0, 1, 0];
    }
    case 'saturate':
      return saturateMatrix(amount);
    case 'grayscale':
      return saturateMatrix(1 - Math.min(Math.max(amount, 0), 1));
    case 'sepia': {
      const k = 1 - Math.min(Math.max(amount, 0), 1);
      return [
        0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k, 0, 0,
        0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k, 0, 0,
        0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k, 0, 0,
        0, 0, 0, 1, 0,
      ];
    }
    case 'invert': {
      const a = Math.min(Math.max(amount, 0), 1);
      const d = 1 - 2 * a;
      return [d, 0, 0, 0, a, 0, d, 0, 0, a, 0, 0, d, 0, a, 0, 0, 0, 1, 0];
    }
    case 'hue-rotate':
      return hueRotateMatrix(typeof filter['degrees'] === 'number' ? filter['degrees'] : 0);
    case 'color-matrix': {
      const m = filter['matrix'];
      if (!Array.isArray(m) || m.length !== 20) return undefined;
      return m.map((v: unknown) => (typeof v === 'number' ? v : 0));
    }
    default:
      return undefined;
  }
}

/** Matrix, die Helligkeit (Luma) zur Deckkraft macht; für Luminanz-Masken auf schwarzem Grund. */
export const LUMINANCE_TO_ALPHA: readonly number[] = [0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, LUMA[0], LUMA[1], LUMA[2], 0, 0];
