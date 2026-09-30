/**
 * Referenz für Story 18.1/18.2: Stand vor der Optimierung (unverändert bis auf Importpfade).
 * Die Tests vergleichen das optimierte Ergebnis Byte für Byte damit.
 */
/**
 * Layer-Effekte (FR-46). Eingebaute Effekte rechnen auf Float-Bildern in **linearem Licht,
 * vormultipliziert**. Ausnahmen: `lut` arbeitet auf sRGB-kodierten geraden Farben (übliche
 * Konvention für `.cube`-Dateien), Plugin-Effekte erhalten ein 8-Bit-sRGB-{@link RgbaImage}.
 */
import { isRecord, OpenVideoError, random, type EffectDefinition, type RgbaImage } from '@agentic-video/core';
import { clamp01, floatToRgba, linearToSrgb, rgbaToFloat, srgbToLinear, type FloatImage } from '../../src/color.js';
import { sampleLut, type Lut } from '../../src/lut.js';

/** Umgebung, die Effekte brauchen. */
export interface EffectContext {
  /** Vorschau-Skalierung; Radien und Beträge in Pixeln werden damit multipliziert. */
  readonly scale: number;
  /** Composition-Frame (für `grain`). */
  readonly frame: number;
  /** Standard-Seed (für `grain` ohne eigenen `seed`). */
  readonly seed: number;
  readonly resolveLut?: (assetId: string) => Lut | undefined;
  readonly effects?: ReadonlyMap<string, EffectDefinition>;
}

const BUILT_IN = new Set(['blur', 'color-grade', 'lut', 'glow', 'vignette', 'grain', 'chromatic-aberration', 'color-matrix']);

function invalid(type: string, problem: string, suggestion: string): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_EFFECT_INVALID',
    errorClass: 'CompositorError',
    problem: `Effect "${type}": ${problem}`,
    suggestions: [suggestion],
  });
}

function num(e: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const v = e[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function required(e: Readonly<Record<string, unknown>>, type: string, key: string): number {
  const v = e[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid(type, `"${key}" must be a finite number.`, `Set ${key}, e.g. { type: '${type}', ${key}: 1 }.`);
  return v;
}

// ---------------------------------------------------------------------------
// Gauß-Weichzeichner
// ---------------------------------------------------------------------------

/** Kleinstes Rechteck (inklusive Grenzen), das alle Pixel mit einem Kanal ungleich 0 enthält. */
function nonZeroBounds(data: Float32Array, w: number, h: number): { x0: number; y0: number; x1: number; y1: number } | undefined {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    let first = -1;
    for (let i = row; i < row + w * 4; i++) {
      if (data[i] !== 0) {
        first = (i - row) >> 2;
        break;
      }
    }
    if (first < 0) continue;
    let last = first;
    for (let i = row + w * 4 - 1; i >= row + first * 4; i--) {
      if (data[i] !== 0) {
        last = (i - row) >> 2;
        break;
      }
    }
    if (y0 === h) y0 = y;
    y1 = y;
    if (first < x0) x0 = first;
    if (last > x1) x1 = last;
  }
  return x1 < 0 ? undefined : { x0, y0, x1, y1 };
}

/**
 * Separabler Gauß-Weichzeichner auf einem vormultiplizierten Float-Bild.
 * `sigma` ist die Standardabweichung in Pixeln; der Kernel reicht über ±3σ.
 * Pixel außerhalb des Bildes gelten als transparent (keine Renormierung am Rand).
 *
 * @example
 * ```ts
 * const soft = gaussianBlur(rgbaToFloat(layer, 'linear'), 4);
 * ```
 */
export function gaussianBlur(image: FloatImage, sigma: number): FloatImage {
  const { width: w, height: h } = image;
  if (!(sigma > 0.01) || w === 0 || h === 0) return { width: w, height: h, data: image.data.slice() };
  const r = Math.ceil(3 * sigma);
  const kernel = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] = (kernel[i] ?? 0) / sum;
  const src = image.data;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  // Nur der Bereich mit Inhalt (plus Kernel-Radius) wird gerechnet. Außerhalb sind alle Pixel 0;
  // ihre Summanden (0 · Gewicht) ändern eine Float-Summe nicht. Das Ergebnis bleibt bitgleich,
  // kostet bei kleinen Inhalten auf großen Layern aber nur einen Bruchteil.
  const content = nonZeroBounds(src, w, h);
  if (content === undefined) return { width: w, height: h, data: out };
  const { x0, y0, x1, y1 } = content;
  const cx0 = Math.max(0, x0 - r);
  const cx1 = Math.min(w - 1, x1 + r);
  for (let y = y0; y <= y1; y++) {
    const row = y * w;
    for (let x = cx0; x <= cx1; x++) {
      let a0 = 0;
      let a1 = 0;
      let a2 = 0;
      let a3 = 0;
      const k0 = Math.max(-r, x0 - x);
      const k1 = Math.min(r, x1 - x);
      for (let k = k0; k <= k1; k++) {
        const wt = kernel[k + r] ?? 0;
        const j = (row + x + k) * 4;
        a0 += (src[j] ?? 0) * wt;
        a1 += (src[j + 1] ?? 0) * wt;
        a2 += (src[j + 2] ?? 0) * wt;
        a3 += (src[j + 3] ?? 0) * wt;
      }
      const o = (row + x) * 4;
      tmp[o] = a0;
      tmp[o + 1] = a1;
      tmp[o + 2] = a2;
      tmp[o + 3] = a3;
    }
  }
  const cy0 = Math.max(0, y0 - r);
  const cy1 = Math.min(h - 1, y1 + r);
  for (let y = cy0; y <= cy1; y++) {
    const k0 = Math.max(-r, y0 - y);
    const k1 = Math.min(r, y1 - y);
    for (let x = cx0; x <= cx1; x++) {
      let a0 = 0;
      let a1 = 0;
      let a2 = 0;
      let a3 = 0;
      for (let k = k0; k <= k1; k++) {
        const wt = kernel[k + r] ?? 0;
        const j = ((y + k) * w + x) * 4;
        a0 += (tmp[j] ?? 0) * wt;
        a1 += (tmp[j + 1] ?? 0) * wt;
        a2 += (tmp[j + 2] ?? 0) * wt;
        a3 += (tmp[j + 3] ?? 0) * wt;
      }
      const o = (y * w + x) * 4;
      out[o] = a0;
      out[o + 1] = a1;
      out[o + 2] = a2;
      out[o + 3] = a3;
    }
  }
  return { width: w, height: h, data: out };
}

// ---------------------------------------------------------------------------
// Farbkorrektur
// ---------------------------------------------------------------------------

/** Parameter von `color-grade`; alle optional. */
export interface ColorGrade {
  readonly exposure: number;
  readonly contrast: number;
  readonly saturation: number;
  readonly temperature: number;
  readonly tint: number;
  readonly lift: number;
  readonly gamma: number;
  readonly gain: number;
}

/**
 * Farbkorrektur einer geraden, linearen Farbe. Reihenfolge und Formeln (`c` je Kanal):
 *
 * 1. Belichtung: `c = c · 2^exposure` (Blenden).
 * 2. Weißabgleich: `r = r · (1 + 0.2·temperature)`, `b = b · (1 − 0.2·temperature)`,
 *    `g = g · (1 − 0.2·tint)` (positiver Tint = Richtung Magenta).
 * 3. Kontrast um Mittelgrau 0.18 (linear): `c = 0.18 · (c / 0.18)^contrast`.
 * 4. Sättigung: `L = 0.2126·r + 0.7152·g + 0.0722·b`, `c = L + (c − L) · saturation`.
 * 5. Lift/Gamma/Gain (ASC-CDL-artig: Slope = gain, Offset = lift, Power = 1/gamma):
 *    `c = max(0, c · gain + lift)^(1 / gamma)`.
 *
 * Standardwerte: exposure 0, contrast 1, saturation 1, temperature 0, tint 0, lift 0, gamma 1, gain 1.
 * Negative Zwischenwerte werden auf 0 begrenzt.
 *
 * @example
 * ```ts
 * gradeColor([0.18, 0.18, 0.18], { ...NEUTRAL_GRADE, exposure: 1 }); // [0.36, 0.36, 0.36]
 * ```
 */
export function gradeColor(rgb: readonly [number, number, number], g: ColorGrade): [number, number, number] {
  const ex = Math.pow(2, g.exposure);
  let r = rgb[0] * ex * (1 + 0.2 * g.temperature);
  let gr = rgb[1] * ex * (1 - 0.2 * g.tint);
  let b = rgb[2] * ex * (1 - 0.2 * g.temperature);
  if (g.contrast !== 1) {
    const k = (v: number): number => (v <= 0 ? 0 : 0.18 * Math.pow(v / 0.18, g.contrast));
    r = k(r);
    gr = k(gr);
    b = k(b);
  }
  if (g.saturation !== 1) {
    const l = 0.2126 * r + 0.7152 * gr + 0.0722 * b;
    r = l + (r - l) * g.saturation;
    gr = l + (gr - l) * g.saturation;
    b = l + (b - l) * g.saturation;
  }
  const inv = 1 / g.gamma;
  const cdl = (v: number): number => {
    const x = v * g.gain + g.lift;
    return x <= 0 ? 0 : inv === 1 ? x : Math.pow(x, inv);
  };
  return [cdl(r), cdl(gr), cdl(b)];
}

/**
 * Neutrale Farbkorrektur (verändert nichts).
 *
 * @example
 * ```ts
 * gradeColor([0.2, 0.2, 0.2], { ...NEUTRAL_GRADE, saturation: 0 });
 * ```
 */
export const NEUTRAL_GRADE: ColorGrade = { exposure: 0, contrast: 1, saturation: 1, temperature: 0, tint: 0, lift: 0, gamma: 1, gain: 1 };

function mapStraight(image: FloatImage, fn: (rgb: [number, number, number], alpha: number) => [number, number, number]): void {
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] ?? 0;
    if (a <= 0) continue;
    const out = fn([(d[i] ?? 0) / a, (d[i + 1] ?? 0) / a, (d[i + 2] ?? 0) / a], a);
    d[i] = Math.max(0, out[0]) * a;
    d[i + 1] = Math.max(0, out[1]) * a;
    d[i + 2] = Math.max(0, out[2]) * a;
  }
}

// ---------------------------------------------------------------------------
// Einzelne Effekte
// ---------------------------------------------------------------------------

function applyLut(image: FloatImage, e: Readonly<Record<string, unknown>>, ctx: EffectContext): void {
  const asset = e['asset'];
  if (typeof asset !== 'string') throw invalid('lut', '"asset" must be an asset id.', "Set asset, e.g. { type: 'lut', asset: 'film-look' }.");
  const lut = ctx.resolveLut?.(asset);
  if (lut === undefined) {
    throw new OpenVideoError({
      code: 'OV_LUT_MISSING',
      errorClass: 'CompositorError',
      problem: `LUT asset "${asset}" could not be resolved.`,
      details: { asset },
      suggestions: ['Import the .cube file as an asset.', 'Pass resolveLut to compositeFrame and return parseCubeLut(text) for this asset id.'],
    });
  }
  const k = clamp01(num(e, 'intensity', 1));
  mapStraight(image, (rgb) => {
    const s0 = linearToSrgb(clamp01(rgb[0]));
    const s1 = linearToSrgb(clamp01(rgb[1]));
    const s2 = linearToSrgb(clamp01(rgb[2]));
    const m = sampleLut(lut, s0, s1, s2);
    return [srgbToLinear(clamp01(s0 + (m[0] - s0) * k)), srgbToLinear(clamp01(s1 + (m[1] - s1) * k)), srgbToLinear(clamp01(s2 + (m[2] - s2) * k))];
  });
}

/**
 * Glow: Pixel mit Luminanz ≥ `threshold` (Standard 0.8, linear) werden mit σ = `radius`
 * weichgezeichnet und mit `intensity` addiert. Alpha: `a + intensity · a_glow · (1 − a)`.
 */
function applyGlow(image: FloatImage, e: Readonly<Record<string, unknown>>, ctx: EffectContext): FloatImage {
  const radius = required(e, 'glow', 'radius');
  const intensity = required(e, 'glow', 'intensity');
  const threshold = num(e, 'threshold', 0.8);
  const d = image.data;
  const bright = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] ?? 0;
    if (a <= 0) continue;
    const l = (0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0)) / a;
    if (l >= threshold) for (let c = 0; c < 4; c++) bright[i + c] = d[i + c] ?? 0;
  }
  const glow = gaussianBlur({ width: image.width, height: image.height, data: bright }, radius * ctx.scale).data;
  const out = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] ?? 0;
    out[i] = (d[i] ?? 0) + intensity * (glow[i] ?? 0);
    out[i + 1] = (d[i + 1] ?? 0) + intensity * (glow[i + 1] ?? 0);
    out[i + 2] = (d[i + 2] ?? 0) + intensity * (glow[i + 2] ?? 0);
    out[i + 3] = clamp01(a + intensity * (glow[i + 3] ?? 0) * (1 - a));
  }
  return { width: image.width, height: image.height, data: out };
}

/**
 * Vignette: `d` = Abstand zur Bildmitte, normiert auf 1 in den Ecken.
 * Faktor `f = 1 − amount · smoothstep(1 − softness, 1, d)` (Standard softness 0.5) auf RGB.
 */
function applyVignette(image: FloatImage, e: Readonly<Record<string, unknown>>): void {
  const amount = clamp01(required(e, 'vignette', 'amount'));
  const softness = clamp01(num(e, 'softness', 0.5));
  const { width: w, height: h, data: d } = image;
  const cx = w / 2;
  const cy = h / 2;
  const e0 = 1 - softness;
  for (let y = 0; y < h; y++) {
    const ny = cy > 0 ? (y + 0.5 - cy) / cy : 0;
    for (let x = 0; x < w; x++) {
      const nx = cx > 0 ? (x + 0.5 - cx) / cx : 0;
      const dist = Math.sqrt(nx * nx + ny * ny) / Math.SQRT2;
      let t: number;
      if (softness === 0) t = dist >= 1 ? 1 : 0;
      else {
        const u = clamp01((dist - e0) / softness);
        t = u * u * (3 - 2 * u);
      }
      const f = 1 - amount * t;
      const i = (y * w + x) * 4;
      d[i] = (d[i] ?? 0) * f;
      d[i + 1] = (d[i + 1] ?? 0) * f;
      d[i + 2] = (d[i + 2] ?? 0) * f;
    }
  }
}

/**
 * Filmkorn: `n = random(seed, frame, x, y) · 2 − 1`, `rgb += amount · n · a` (einfarbig),
 * begrenzt auf `0..a`. `seed` aus dem Effekt, sonst aus der Composition.
 */
function applyGrain(image: FloatImage, e: Readonly<Record<string, unknown>>, ctx: EffectContext): void {
  const amount = required(e, 'grain', 'amount');
  const seed = num(e, 'seed', ctx.seed);
  const { width: w, height: h, data: d } = image;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = d[i + 3] ?? 0;
      if (a <= 0) continue;
      const n = (random(seed, ctx.frame, x, y) * 2 - 1) * amount * a;
      for (let c = 0; c < 3; c++) d[i + c] = Math.min(a, Math.max(0, (d[i + c] ?? 0) + n));
    }
  }
}

function sampleBilinear(src: Float32Array, w: number, h: number, x: number, y: number, c: number): number {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const at = (xi: number, yi: number): number => (xi < 0 || yi < 0 || xi >= w || yi >= h ? 0 : (src[(yi * w + xi) * 4 + c] ?? 0));
  return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
}

/**
 * Chromatische Aberration: Rot wird radial nach außen, Blau nach innen verschoben.
 * In den Ecken beträgt die Verschiebung `amount` Pixel; zur Mitte hin nimmt sie linear ab.
 */
function applyChromaticAberration(image: FloatImage, e: Readonly<Record<string, unknown>>, ctx: EffectContext): FloatImage {
  const amount = required(e, 'chromatic-aberration', 'amount') * ctx.scale;
  const { width: w, height: h, data: d } = image;
  const cx = w / 2;
  const cy = h / 2;
  const half = Math.sqrt(cx * cx + cy * cy);
  if (amount === 0 || half === 0) return { width: w, height: h, data: d.slice() };
  const k = amount / half;
  const out = new Float32Array(d.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5 - cx;
      const py = y + 0.5 - cy;
      const i = (y * w + x) * 4;
      // Rot kommt von weiter innen (Bild wird nach außen gezogen), Blau von weiter außen.
      const rx = cx + px * (1 - k);
      const ry = cy + py * (1 - k);
      const bx = cx + px * (1 + k);
      const by = cy + py * (1 + k);
      const r = sampleBilinear(d, w, h, rx, ry, 0);
      const ar = sampleBilinear(d, w, h, rx, ry, 3);
      const b = sampleBilinear(d, w, h, bx, by, 2);
      const ab = sampleBilinear(d, w, h, bx, by, 3);
      out[i] = r;
      out[i + 1] = d[i + 1] ?? 0;
      out[i + 2] = b;
      out[i + 3] = Math.max(ar, d[i + 3] ?? 0, ab);
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Farbmatrix 4×5 wie SVG `feColorMatrix` (zeilenweise), auf geraden, linearen RGBA-Werten:
 * `R' = m0·R + m1·G + m2·B + m3·A + m4` usw.; Ergebnis auf 0..1 begrenzt.
 */
function applyColorMatrix(image: FloatImage, e: Readonly<Record<string, unknown>>): void {
  const m = e['matrix'];
  if (!Array.isArray(m) || m.length !== 20 || !m.every((v): v is number => typeof v === 'number' && Number.isFinite(v))) {
    throw invalid('color-matrix', '"matrix" must contain exactly 20 finite numbers.', 'Use a 4x5 row-major matrix, e.g. the identity [1,0,0,0,0, 0,1,0,0,0, 0,0,1,0,0, 0,0,0,1,0].');
  }
  const k = Float64Array.from(m);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] ?? 0;
    const r = a > 0 ? (d[i] ?? 0) / a : 0;
    const g = a > 0 ? (d[i + 1] ?? 0) / a : 0;
    const b = a > 0 ? (d[i + 2] ?? 0) / a : 0;
    const row = (o: number): number => clamp01((k[o] ?? 0) * r + (k[o + 1] ?? 0) * g + (k[o + 2] ?? 0) * b + (k[o + 3] ?? 0) * a + (k[o + 4] ?? 0));
    const na = row(15);
    d[i] = row(0) * na;
    d[i + 1] = row(5) * na;
    d[i + 2] = row(10) * na;
    d[i + 3] = na;
  }
}

function applyPlugin(image: FloatImage, def: EffectDefinition, e: Readonly<Record<string, unknown>>): FloatImage {
  const input = floatToRgba(image, 'linear', 'srgb');
  const result = def.apply(input, e);
  if (result.width !== image.width || result.height !== image.height || result.data.length !== image.width * image.height * 4) {
    throw new OpenVideoError({
      code: 'OV_EFFECT_OUTPUT',
      errorClass: 'CompositorError',
      problem: `Plugin effect "${def.type}" returned ${String(result.width)}x${String(result.height)}, expected ${String(image.width)}x${String(image.height)}.`,
      suggestions: ['Return an RgbaImage with the same size as the input from EffectDefinition.apply.'],
    });
  }
  return rgbaToFloat(result, 'linear');
}

/**
 * Wendet Layer-Effekte in Reihenfolge auf ein Float-Bild in linearem Licht an (vormultipliziert).
 * Unbekannte Typen ohne Plugin-Definition werfen `OV_EFFECT_UNKNOWN`.
 *
 * @example
 * ```ts
 * const out = applyEffectsLinear(img, [{ type: 'blur', radius: 2 }], { scale: 1, frame: 0, seed: 1 });
 * ```
 */
export function applyEffectsLinear(image: FloatImage, effects: readonly unknown[], ctx: EffectContext): FloatImage {
  let img = image;
  effects.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw['type'] !== 'string') {
      throw new OpenVideoError({
        code: 'OV_EFFECT_INVALID',
        errorClass: 'CompositorError',
        problem: `Effect at index ${String(index)} has no "type".`,
        suggestions: ["Give every effect a type, e.g. { type: 'blur', radius: 4 }."],
      });
    }
    const type = raw['type'];
    switch (type) {
      case 'blur':
        img = gaussianBlur(img, required(raw, 'blur', 'radius') * ctx.scale);
        return;
      case 'color-grade': {
        const grade: ColorGrade = {
          exposure: num(raw, 'exposure', 0),
          contrast: num(raw, 'contrast', 1),
          saturation: num(raw, 'saturation', 1),
          temperature: num(raw, 'temperature', 0),
          tint: num(raw, 'tint', 0),
          lift: num(raw, 'lift', 0),
          gamma: Math.max(0.01, num(raw, 'gamma', 1)),
          gain: num(raw, 'gain', 1),
        };
        mapStraight(img, (rgb) => gradeColor(rgb, grade));
        return;
      }
      case 'lut':
        applyLut(img, raw, ctx);
        return;
      case 'glow':
        img = applyGlow(img, raw, ctx);
        return;
      case 'vignette':
        applyVignette(img, raw);
        return;
      case 'grain':
        applyGrain(img, raw, ctx);
        return;
      case 'chromatic-aberration':
        img = applyChromaticAberration(img, raw, ctx);
        return;
      case 'color-matrix':
        applyColorMatrix(img, raw);
        return;
      default: {
        const def = ctx.effects?.get(type);
        if (def === undefined) {
          throw new OpenVideoError({
            code: 'OV_EFFECT_UNKNOWN',
            errorClass: 'CompositorError',
            problem: `Unknown effect type "${type}".`,
            expected: [...BUILT_IN].join(', '),
            received: JSON.stringify(type),
            suggestions: [`Use one of: ${[...BUILT_IN].join(', ')}.`, `Register a plugin effect with registerEffect({ type: '${type}', ... }) and pass registry.effects to compositeFrame.`],
          });
        }
        img = applyPlugin(img, def, raw);
      }
    }
  });
  return img;
}

/**
 * Wendet Layer-Effekte auf ein 8-Bit-Bild (sRGB, vormultipliziert) an und liefert ein neues Bild.
 * Intern rechnet die Funktion in linearem Licht (siehe Modulbeschreibung).
 *
 * @example
 * ```ts
 * const soft = applyLayerEffects(image, [{ type: 'blur', radius: 4 }, { type: 'vignette', amount: 0.5 }], { scale: 1, frame: 0, seed: 1 });
 * ```
 */
export function applyLayerEffects(image: RgbaImage, effects: readonly unknown[], ctx: EffectContext): RgbaImage {
  return floatToRgba(applyEffectsLinear(rgbaToFloat(image, 'linear'), effects, ctx), 'linear', 'srgb');
}
