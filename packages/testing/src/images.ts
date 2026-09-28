/**
 * Bildwerkzeuge für Tests: Pixel-Diff, Hash und einfache Testbilder (NFR-5).
 * Alle Bilder sind {@link RgbaImage}: 8 Bit, vormultipliziert, sRGB.
 */
import { colorBytes, sha256Hex, type RgbaImage } from '@agentic-video/core';

/** Toleranzen für {@link compareImages}. */
export interface CompareOptions {
  /** Größte erlaubte Abweichung je Kanal (0..255). Standard 2. */
  readonly maxChannelDelta?: number;
  /** Größter erlaubter Anteil abweichender Pixel (0..1). Standard 0.001. */
  readonly maxDiffRatio?: number;
}

/** Ergebnis von {@link compareImages}. */
export interface CompareResult {
  readonly pass: boolean;
  /** Anzahl Pixel mit mindestens einem Kanal über `maxChannelDelta`. */
  readonly diffPixels: number;
  /** Größte Kanalabweichung im ganzen Bild. */
  readonly maxDelta: number;
  /** Rot = abweichender Pixel, sonst abgedunkeltes Graubild der Erwartung. */
  readonly diffImage: RgbaImage;
}

/**
 * Vergleicht zwei Bilder pixelweise. Ein Pixel weicht ab, wenn ein Kanal (inklusive Alpha)
 * mehr als `maxChannelDelta` abweicht. Der Vergleich besteht, wenn höchstens
 * `maxDiffRatio` aller Pixel abweichen. Unterschiedliche Größen bestehen nie.
 *
 * @example
 * ```ts
 * const { pass, diffPixels } = compareImages(actual, expected, { maxChannelDelta: 2, maxDiffRatio: 0.001 });
 * ```
 */
export function compareImages(actual: RgbaImage, expected: RgbaImage, options: CompareOptions = {}): CompareResult {
  const maxChannelDelta = options.maxChannelDelta ?? 2;
  const maxDiffRatio = options.maxDiffRatio ?? 0.001;
  if (actual.width !== expected.width || actual.height !== expected.height) {
    const width = Math.max(actual.width, expected.width);
    const height = Math.max(actual.height, expected.height);
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set([255, 0, 0, 255], i);
    return { pass: false, diffPixels: width * height, maxDelta: 255, diffImage: { width, height, data } };
  }
  const a = actual.data;
  const e = expected.data;
  const diff = new Uint8Array(a.length);
  let diffPixels = 0;
  let maxDelta = 0;
  for (let i = 0; i < a.length; i += 4) {
    let pixelMax = 0;
    for (let c = 0; c < 4; c++) pixelMax = Math.max(pixelMax, Math.abs((a[i + c] ?? 0) - (e[i + c] ?? 0)));
    maxDelta = Math.max(maxDelta, pixelMax);
    if (pixelMax > maxChannelDelta) {
      diffPixels++;
      diff.set([255, 0, 0, 255], i);
    } else {
      const luma = Math.round(0.3 * (0.2126 * (e[i] ?? 0) + 0.7152 * (e[i + 1] ?? 0) + 0.0722 * (e[i + 2] ?? 0)));
      diff.set([luma, luma, luma, 255], i);
    }
  }
  const total = actual.width * actual.height;
  const pass = total === 0 ? true : diffPixels / total <= maxDiffRatio;
  return { pass, diffPixels, maxDelta, diffImage: { width: actual.width, height: actual.height, data: diff } };
}

/**
 * SHA-256 (Hex) über Breite, Höhe und Pixeldaten.
 *
 * @example
 * ```ts
 * expect(imageHash(renderA)).toBe(imageHash(renderB));
 * ```
 */
export function imageHash(image: RgbaImage): string {
  const bytes = new Uint8Array(8 + image.data.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, image.width);
  view.setUint32(4, image.height);
  bytes.set(image.data, 8);
  return sha256Hex(bytes);
}

function premultipliedBytes(color: string): [number, number, number, number] {
  const [r, g, b, a] = colorBytes(color);
  return [Math.round((r * a) / 255), Math.round((g * a) / 255), Math.round((b * a) / 255), a];
}

/**
 * Einfarbiges Bild. `color` ist `#RRGGBB`, `#RRGGBBAA` oder `transparent` (gerade Farbe);
 * das Ergebnis ist vormultipliziert.
 *
 * @example
 * ```ts
 * const red = solidImage(64, 64, '#FF0000');
 * const halfWhite = solidImage(4, 4, '#FFFFFF80'); // Pixel [128, 128, 128, 128]
 * ```
 */
export function solidImage(width: number, height: number, color: string): RgbaImage {
  const px = premultipliedBytes(color);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(px, i);
  return { width, height, data };
}

/**
 * Schachbrett mit quadratischen Feldern der Kantenlänge `cell`. Das Feld oben links hat `colorA`.
 *
 * @example
 * ```ts
 * const board = checkerImage(64, 64, 8, '#FFFFFF', '#000000');
 * ```
 */
export function checkerImage(width: number, height: number, cell = 8, colorA = '#FFFFFF', colorB = '#000000'): RgbaImage {
  const a = premultipliedBytes(colorA);
  const b = premultipliedBytes(colorB);
  const size = Math.max(1, Math.floor(cell));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const even = (Math.floor(x / size) + Math.floor(y / size)) % 2 === 0;
      data.set(even ? a : b, (y * width + x) * 4);
    }
  }
  return { width, height, data };
}
