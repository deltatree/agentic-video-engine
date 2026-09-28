/**
 * Umrechnung zwischen vormultipliziertem und geradem Alpha.
 * FFmpeg erwartet und liefert gerades Alpha; {@link RgbaImage} ist vormultipliziert.
 */
import type { RgbaImage } from '@agentic-video/core';

/**
 * Wandelt gerades RGBA im Puffer in vormultipliziertes RGBA um (in place).
 *
 * @example
 * ```ts
 * premultiplyInPlace(new Uint8Array([200, 100, 50, 128])); // [100, 50, 25, 128]
 * ```
 */
export function premultiplyInPlace(data: Uint8Array): Uint8Array {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] ?? 0;
    if (a === 255) continue;
    if (a === 0) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      continue;
    }
    data[i] = Math.round(((data[i] ?? 0) * a) / 255);
    data[i + 1] = Math.round(((data[i + 1] ?? 0) * a) / 255);
    data[i + 2] = Math.round(((data[i + 2] ?? 0) * a) / 255);
  }
  return data;
}

/**
 * Schreibt die gerade (nicht vormultiplizierte) Form eines Bildes in `out`.
 *
 * @example
 * ```ts
 * const out = new Uint8Array(4);
 * unpremultiplyInto({ width: 1, height: 1, data: new Uint8Array([100, 50, 25, 128]) }, out); // [199, 100, 50, 128]
 * ```
 */
export function unpremultiplyInto(image: RgbaImage, out: Uint8Array): Uint8Array {
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] ?? 0;
    if (a === 255) {
      out[i] = data[i] ?? 0;
      out[i + 1] = data[i + 1] ?? 0;
      out[i + 2] = data[i + 2] ?? 0;
    } else if (a === 0) {
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
    } else {
      out[i] = Math.min(255, Math.round(((data[i] ?? 0) * 255) / a));
      out[i + 1] = Math.min(255, Math.round(((data[i + 1] ?? 0) * 255) / a));
      out[i + 2] = Math.min(255, Math.round(((data[i + 2] ?? 0) * 255) / a));
    }
    out[i + 3] = a;
  }
  return out;
}
