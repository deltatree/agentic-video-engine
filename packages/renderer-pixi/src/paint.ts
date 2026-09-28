/**
 * Füllung und Kontur für PixiJS: Farben und lineare/radiale Verläufe (FR-31).
 * Verlaufskoordinaten rechnen wir selbst in Pixel der lokalen Box um (`textureSpace: 'global'`),
 * damit `units: 'relative'` und der Radius relativ zur größeren Box-Seite genau wie Skia wirken.
 */
import { isRecord, parseColor } from '@agentic-video/core';
import { FillGradient, type FillInput, type StrokeStyle } from 'pixi.js';

/** Box in lokalen Koordinaten. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function hex(v: number): string {
  return Math.round(Math.min(Math.max(v, 0), 1) * 255)
    .toString(16)
    .padStart(2, '0');
}

/**
 * Wandelt eine IR-Farbe in Farbe (`#RRGGBB`) und Alpha.
 *
 * @example
 * ```ts
 * colorAlpha('#FF000080'); // { color: '#ff0000', alpha: 0.502 }
 * ```
 */
export function colorAlpha(value: string): { color: string; alpha: number } {
  const c = parseColor(value);
  return { color: `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`, alpha: c.a };
}

function point(v: unknown, fallback: { x: number; y: number }): { x: number; y: number } {
  if (!isRecord(v)) return fallback;
  return { x: typeof v['x'] === 'number' ? v['x'] : fallback.x, y: typeof v['y'] === 'number' ? v['y'] : fallback.y };
}

/**
 * Baut einen PixiJS-Verlauf aus einem IR-Verlauf. Konische Verläufe gibt es in PixiJS nicht
 * (`undefined`; `checkPixiNode` meldet sie).
 */
export function toGradient(g: Readonly<Record<string, unknown>>, box: Box): FillGradient | undefined {
  const stops = Array.isArray(g['stops']) ? g['stops'].filter(isRecord) : [];
  const colorStops = stops.map((s) => {
    const { color, alpha } = colorAlpha(typeof s['color'] === 'string' ? s['color'] : '#000000');
    return { offset: typeof s['offset'] === 'number' ? s['offset'] : 0, color: `${color}${hex(alpha)}` };
  });
  const relative = g['units'] !== 'pixels';
  const toPx = (p: { x: number; y: number }): { x: number; y: number } => (relative ? { x: box.x + p.x * box.width, y: box.y + p.y * box.height } : p);
  if (g['type'] === 'linear') {
    return new FillGradient({ type: 'linear', start: toPx(point(g['start'], { x: 0, y: 0 })), end: toPx(point(g['end'], { x: 1, y: 0 })), colorStops, textureSpace: 'global' });
  }
  if (g['type'] === 'radial') {
    const center = toPx(point(g['center'], { x: 0.5, y: 0.5 }));
    const r = typeof g['radius'] === 'number' ? g['radius'] : 0.5;
    const radius = relative ? r * Math.max(box.width, box.height) : r;
    return new FillGradient({ type: 'radial', center, innerRadius: 0, outerCenter: center, outerRadius: radius, colorStops, textureSpace: 'global' });
  }
  return undefined;
}

/** Füllung aus einer IR-Paint (Farbe oder Verlauf). */
export function toFill(paint: unknown, box: Box): FillInput | undefined {
  if (typeof paint === 'string') return colorAlpha(paint);
  if (isRecord(paint)) return toGradient(paint, box);
  return undefined;
}

/** Kontur aus einer IR-Paint plus Breite, Enden und Ecken. Die Kontur liegt mittig auf der Kante. */
export function toStroke(paint: unknown, box: Box, props: Readonly<Record<string, unknown>>): StrokeStyle | undefined {
  const width = typeof props['strokeWidth'] === 'number' ? props['strokeWidth'] : 1;
  if (width <= 0) return undefined;
  const capRaw = props['strokeCap'];
  const joinRaw = props['strokeJoin'];
  const base: StrokeStyle = {
    width,
    alignment: 0.5,
    cap: capRaw === 'round' || capRaw === 'square' ? capRaw : 'butt',
    join: joinRaw === 'round' || joinRaw === 'bevel' ? joinRaw : 'miter',
  };
  if (typeof paint === 'string') return { ...base, ...colorAlpha(paint) };
  if (isRecord(paint)) {
    const gradient = toGradient(paint, box);
    return gradient === undefined ? undefined : { ...base, fill: gradient };
  }
  return undefined;
}
