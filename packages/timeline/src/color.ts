/**
 * Farbmathe: Parsen, Formatieren, Transferfunktionen (A39).
 * Alle Funktionen sind rein und plattformunabhängig.
 */
import { OpenVideoError } from '@agentic-video/schema';

/** RGBA-Farbe mit Kanälen 0..1, nicht vormultipliziert, sRGB-kodiert. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/u;

/**
 * Parst `#RGB`, `#RRGGBB`, `#RRGGBBAA` oder `transparent`.
 *
 * @example
 * ```ts
 * parseColor('#FF800080'); // { r: 1, g: 0.502, b: 0, a: 0.502 }
 * ```
 */
export function parseColor(value: string): Rgba {
  if (value === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const m = HEX.exec(value);
  if (m?.[1] === undefined) {
    throw new OpenVideoError({
      code: 'OV_COLOR_INVALID',
      errorClass: 'ColorError',
      problem: `Invalid color "${value}".`,
      suggestions: ['Use "#RRGGBB" or "#RRGGBBAA", e.g. "#FF5500".'],
    });
  }
  let hex = m[1];
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) : 1 };
}

function to255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/** Formatiert eine Farbe als `#RRGGBB` oder `#RRGGBBAA` (Großbuchstaben). */
export function formatColor(c: Rgba): string {
  const hex = (v: number) => to255(v).toString(16).padStart(2, '0').toUpperCase();
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}${to255(c.a) === 255 ? '' : hex(c.a)}`;
}

/** sRGB-Transferfunktion: kodiert → linear. */
export function srgbToLinear(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** sRGB-Transferfunktion: linear → kodiert. */
export function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/** Rec.709-OETF: linear → kodiert (ITU-R BT.709). */
export function linearToRec709(v: number): number {
  return v < 0.018 ? 4.5 * v : 1.099 * v ** 0.45 - 0.099;
}

/** Inverse Rec.709-OETF: kodiert → linear. */
export function rec709ToLinear(v: number): number {
  return v < 0.081 ? v / 4.5 : ((v + 0.099) / 1.099) ** (1 / 0.45);
}

/** Relative Luminanz (Rec.709-Koeffizienten) eines linearen RGB-Werts. */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Interpoliert zwei Farben kanalweise im sRGB-Raum. */
export function mixColor(a: Rgba, b: Rgba, t: number): Rgba {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t };
}
