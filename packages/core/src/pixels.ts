/**
 * Pixel-Hilfen für 8-Bit-RGBA (Story 18.9): Umrechnung zwischen geradem und vormultipliziertem
 * Alpha an genau einer Stelle. PNG-Dekodierung, FFmpeg-Reader und -Encoder nutzen sie gemeinsam.
 *
 * Rundung (bitgleich zu den früheren Kopien in `png` und `ffmpeg`):
 * - vormultiplizieren: `round(c · a / 255)`,
 * - entmultiplizieren: `min(255, round(c · 255 / a))`, bei `a = 0` alle Kanäle 0.
 *
 * Beide Richtungen laufen über Tabellen mit 65 536 Einträgen (Index `a · 256 + c`), die beim
 * ersten Aufruf entstehen; die Schleifen rechnen danach ohne Division.
 */

let premulTable: Uint8Array | undefined;
let unpremulTable: Uint8Array | undefined;

function premulLookup(): Uint8Array {
  if (premulTable === undefined) {
    const t = new Uint8Array(65536);
    for (let a = 0; a < 256; a++) for (let c = 0; c < 256; c++) t[(a << 8) | c] = Math.round((c * a) / 255);
    premulTable = t;
  }
  return premulTable;
}

function unpremulLookup(): Uint8Array {
  if (unpremulTable === undefined) {
    const t = new Uint8Array(65536);
    for (let a = 1; a < 256; a++) for (let c = 0; c < 256; c++) t[(a << 8) | c] = Math.min(255, Math.round((c * 255) / a));
    unpremulTable = t;
  }
  return unpremulTable;
}

/**
 * Wandelt gerades RGBA im Puffer in vormultipliziertes RGBA um (in place) und gibt den Puffer zurück.
 * Pixel mit Alpha 0 werden ganz 0.
 *
 * @example
 * ```ts
 * premultiplyInPlace(new Uint8Array([200, 100, 50, 128])); // [100, 50, 25, 128]
 * ```
 */
export function premultiplyInPlace(data: Uint8Array): Uint8Array {
  const t = premulLookup();
  const n = data.length - (data.length % 4);
  for (let i = 0; i < n; i += 4) {
    const a = data[i + 3] ?? 0;
    if (a === 255) continue;
    if (a === 0) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      continue;
    }
    const row = a << 8;
    data[i] = t[row | (data[i] ?? 0)] ?? 0;
    data[i + 1] = t[row | (data[i + 1] ?? 0)] ?? 0;
    data[i + 2] = t[row | (data[i + 2] ?? 0)] ?? 0;
  }
  return data;
}

/**
 * Schreibt die gerade (nicht vormultiplizierte) Form von `data` in `out` (darf `data` selbst sein)
 * und gibt `out` zurück. `out` muss mindestens so lang sein wie `data`.
 *
 * @example
 * ```ts
 * const out = unpremultiplyInto(new Uint8Array([100, 50, 25, 128]), new Uint8Array(4)); // [199, 100, 50, 128]
 * ```
 */
export function unpremultiplyInto(data: Uint8Array, out: Uint8Array): Uint8Array {
  const t = unpremulLookup();
  const n = data.length - (data.length % 4);
  for (let i = 0; i < n; i += 4) {
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
      const row = a << 8;
      out[i] = t[row | (data[i] ?? 0)] ?? 0;
      out[i + 1] = t[row | (data[i + 1] ?? 0)] ?? 0;
      out[i + 2] = t[row | (data[i + 2] ?? 0)] ?? 0;
    }
    out[i + 3] = a;
  }
  return out;
}
