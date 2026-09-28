/**
 * Farben, Verläufe, Konturen, Filter und Blend Modes als CanvasKit-Objekte
 * (Semantik: docs/reference/node-semantics.md, Abschnitte 1.4 und 1.5).
 */
import type { BlendMode, CanvasKit, Color, ColorFilter, ImageFilter, Paint, Shader } from 'canvaskit-wasm';
import { isRecord, parseColor, type EvaluatedNode } from '@agentic-video/core';
import type { Scope } from './scope.js';

/** Achsenparallele Box in lokalen Koordinaten. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Wandelt eine Farbe (`#RRGGBB`, `#RRGGBBAA`, `transparent`) in eine CanvasKit-Farbe.
 *
 * @example
 * ```ts
 * paint.setColor(toColor(ck, '#FF000080'));
 * ```
 */
export function toColor(ck: CanvasKit, color: string, alpha = 1): Color {
  const c = parseColor(color);
  return ck.Color4f(c.r, c.g, c.b, c.a * alpha);
}

/** Liest einen Punkt `{ x, y }`. */
function vec(value: unknown, fallback: { x: number; y: number }): { x: number; y: number } {
  if (!isRecord(value)) return fallback;
  return { x: typeof value['x'] === 'number' ? value['x'] : fallback.x, y: typeof value['y'] === 'number' ? value['y'] : fallback.y };
}

/**
 * Baut einen Verlaufs-Shader aus einem IR-Verlauf in der gegebenen Box.
 * Relative Koordinaten (Standard) sind Anteile 0..1 der Box.
 *
 * @example
 * ```ts
 * const shader = gradientShader(ck, scope, { type: 'linear', stops: [...] }, { x: 0, y: 0, width: 100, height: 50 });
 * ```
 */
export function gradientShader(ck: CanvasKit, scope: Scope, gradient: Readonly<Record<string, unknown>>, box: Box): Shader | undefined {
  const rawStops = gradient['stops'];
  if (!Array.isArray(rawStops)) return undefined;
  const colors: Color[] = [];
  const positions: number[] = [];
  for (const s of rawStops) {
    if (!isRecord(s) || typeof s['color'] !== 'string') continue;
    colors.push(toColor(ck, s['color']));
    positions.push(typeof s['offset'] === 'number' ? Math.min(Math.max(s['offset'], 0), 1) : 0);
  }
  if (colors.length < 2) return undefined;
  const relative = gradient['units'] !== 'pixels';
  const px = (p: { x: number; y: number }): [number, number] => (relative ? [box.x + p.x * box.width, box.y + p.y * box.height] : [p.x, p.y]);
  const clamp = ck.TileMode.Clamp;
  switch (gradient['type']) {
    case 'linear':
      return scope.add(ck.Shader.MakeLinearGradient(px(vec(gradient['start'], { x: 0, y: 0 })), px(vec(gradient['end'], { x: 1, y: 0 })), colors, positions, clamp));
    case 'radial': {
      const r = typeof gradient['radius'] === 'number' ? gradient['radius'] : 0.5;
      const radius = relative ? r * Math.max(box.width, box.height) : r;
      return scope.add(ck.Shader.MakeRadialGradient(px(vec(gradient['center'], { x: 0.5, y: 0.5 })), Math.max(radius, 1e-6), colors, positions, clamp));
    }
    case 'conic': {
      const [cx, cy] = px(vec(gradient['center'], { x: 0.5, y: 0.5 }));
      const angle = typeof gradient['angle'] === 'number' ? gradient['angle'] : 0;
      const rotation = ck.Matrix.rotated((angle * Math.PI) / 180, cx, cy);
      return scope.add(ck.Shader.MakeSweepGradient(cx, cy, colors, positions, clamp, rotation));
    }
    default:
      return undefined;
  }
}

/**
 * Erzeugt einen Paint für eine IR-Füllung oder -Kontur (Farbe oder Verlauf); `undefined` ohne Wert.
 *
 * @example
 * ```ts
 * const fill = paintFor(ck, scope, node.props['fill'], box);
 * if (fill !== undefined) canvas.drawPath(path, fill);
 * ```
 */
export function paintFor(ck: CanvasKit, scope: Scope, value: unknown, box: Box): Paint | undefined {
  if (value === undefined || value === null) return undefined;
  const paint = scope.add(new ck.Paint());
  paint.setAntiAlias(true);
  if (typeof value === 'string') {
    paint.setColor(toColor(ck, value));
    return paint;
  }
  if (isRecord(value)) {
    const shader = gradientShader(ck, scope, value, box);
    if (shader === undefined) return undefined;
    paint.setColor(ck.BLACK);
    paint.setShader(shader);
    return paint;
  }
  return undefined;
}

/**
 * Stellt einen Paint auf Kontur um: Breite, Enden, Ecken und Strichmuster der Node.
 *
 * @example
 * ```ts
 * applyStroke(ck, scope, paint, node, 1);
 * ```
 */
export function applyStroke(ck: CanvasKit, scope: Scope, paint: Paint, node: EvaluatedNode, defaultWidth: number): void {
  paint.setStyle(ck.PaintStyle.Stroke);
  const w = node.props['strokeWidth'];
  paint.setStrokeWidth(typeof w === 'number' ? w : defaultWidth);
  const cap = node.props['strokeCap'];
  paint.setStrokeCap(cap === 'round' ? ck.StrokeCap.Round : cap === 'square' ? ck.StrokeCap.Square : ck.StrokeCap.Butt);
  const join = node.props['strokeJoin'];
  paint.setStrokeJoin(join === 'round' ? ck.StrokeJoin.Round : join === 'bevel' ? ck.StrokeJoin.Bevel : ck.StrokeJoin.Miter);
  const dash = node.props['strokeDash'];
  if (Array.isArray(dash)) {
    const intervals = dash.filter((d): d is number => typeof d === 'number' && d >= 0);
    // Ungerade Listen werden wie in SVG verdoppelt.
    const even = intervals.length % 2 === 1 ? [...intervals, ...intervals] : intervals;
    if (even.length >= 2 && even.some((d) => d > 0)) paint.setPathEffect(scope.add(ck.PathEffect.MakeDash(even, 0)));
  }
}

/**
 * Die 17 Blend Modes der IR in Skia-Modi.
 *
 * @example
 * ```ts
 * layerPaint.setBlendMode(blendModeOf(ck, 'multiply'));
 * ```
 */
export function blendModeOf(ck: CanvasKit, mode: unknown): BlendMode {
  const map: Record<string, BlendMode> = {
    normal: ck.BlendMode.SrcOver,
    multiply: ck.BlendMode.Multiply,
    screen: ck.BlendMode.Screen,
    overlay: ck.BlendMode.Overlay,
    darken: ck.BlendMode.Darken,
    lighten: ck.BlendMode.Lighten,
    'color-dodge': ck.BlendMode.ColorDodge,
    'color-burn': ck.BlendMode.ColorBurn,
    'hard-light': ck.BlendMode.HardLight,
    'soft-light': ck.BlendMode.SoftLight,
    difference: ck.BlendMode.Difference,
    exclusion: ck.BlendMode.Exclusion,
    hue: ck.BlendMode.Hue,
    saturation: ck.BlendMode.Saturation,
    color: ck.BlendMode.Color,
    luminosity: ck.BlendMode.Luminosity,
    add: ck.BlendMode.Plus,
  };
  return (typeof mode === 'string' ? map[mode] : undefined) ?? ck.BlendMode.SrcOver;
}

// ---------------------------------------------------------------------------
// Filter (CSS-Semantik)
// ---------------------------------------------------------------------------

const LUMA = [0.2126, 0.7152, 0.0722] as const;

function saturateMatrix(s: number): number[] {
  return [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0, 0,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0, 0,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

function hueRotateMatrix(degrees: number): number[] {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0, 0,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283, 0, 0,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072, 0, 0,
    0, 0, 0, 1, 0,
  ];
}

/**
 * 4×5-Farbmatrix eines CSS-Farbfilters (Verschiebung in 0..1) oder `undefined` für andere Filter.
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

/**
 * Baut die Bildfilter-Kette einer Node: `filters` in Reihenfolge, danach `shadow`.
 *
 * @example
 * ```ts
 * const filter = nodeImageFilter(ck, scope, node);
 * if (filter !== null) layerPaint.setImageFilter(filter);
 * ```
 */
export function nodeImageFilter(ck: CanvasKit, scope: Scope, node: EvaluatedNode): ImageFilter | null {
  let chain: ImageFilter | null = null;
  const filters = node.props['filters'];
  if (Array.isArray(filters)) {
    for (const f of filters) {
      if (!isRecord(f)) continue;
      if (f['type'] === 'blur') {
        const sigma = typeof f['radius'] === 'number' ? f['radius'] : 0;
        if (sigma > 0) chain = scope.add(ck.ImageFilter.MakeBlur(sigma, sigma, ck.TileMode.Decal, chain));
        continue;
      }
      const matrix = filterMatrix(f);
      if (matrix === undefined) continue;
      const cf = scope.add(ck.ColorFilter.MakeMatrix(matrix));
      chain = scope.add(ck.ImageFilter.MakeColorFilter(cf, chain));
    }
  }
  const shadow = node.props['shadow'];
  if (isRecord(shadow) && typeof shadow['color'] === 'string') {
    const blur = typeof shadow['blur'] === 'number' ? shadow['blur'] : 0;
    const dx = typeof shadow['offsetX'] === 'number' ? shadow['offsetX'] : 0;
    const dy = typeof shadow['offsetY'] === 'number' ? shadow['offsetY'] : 0;
    chain = scope.add(ck.ImageFilter.MakeDropShadow(dx, dy, blur, blur, toColor(ck, shadow['color']), chain));
  }
  return chain;
}

/**
 * Farbfilter für Masken: `alpha` nutzt die Deckkraft, `luminance` die Helligkeit
 * (der Maskeninhalt liegt dafür auf opakem Schwarz, also Helligkeit × Alpha); `invert` kehrt um.
 *
 * @example
 * ```ts
 * maskPaint.setColorFilter(maskColorFilter(ck, scope, 'luminance', false));
 * ```
 */
export function maskColorFilter(ck: CanvasKit, scope: Scope, mode: 'alpha' | 'luminance', invert: boolean): ColorFilter | null {
  const zero = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  if (mode === 'luminance') {
    const s = invert ? -1 : 1;
    return scope.add(ck.ColorFilter.MakeMatrix([...zero, s * LUMA[0], s * LUMA[1], s * LUMA[2], 0, invert ? 1 : 0]));
  }
  if (!invert) return null;
  return scope.add(ck.ColorFilter.MakeMatrix([...zero, 0, 0, 0, -1, 1]));
}
