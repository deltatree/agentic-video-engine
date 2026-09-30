/**
 * Umrechnung zwischen vormultipliziertem und geradem Alpha.
 * FFmpeg erwartet und liefert gerades Alpha; {@link RgbaImage} ist vormultipliziert.
 * Die Rechnung liegt einmal in `@agentic-video/core` (Story 18.9); hier stehen die
 * bisherigen Namen dieses Pakets.
 */
import { premultiplyInPlace as corePremultiplyInPlace, unpremultiplyInto as coreUnpremultiplyInto, type RgbaImage } from '@agentic-video/core';

/**
 * Wandelt gerades RGBA im Puffer in vormultipliziertes RGBA um (in place).
 *
 * @example
 * ```ts
 * premultiplyInPlace(new Uint8Array([200, 100, 50, 128])); // [100, 50, 25, 128]
 * ```
 */
export function premultiplyInPlace(data: Uint8Array): Uint8Array {
  return corePremultiplyInPlace(data);
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
  return coreUnpremultiplyInto(image.data, out);
}
