/**
 * Gemeinsame Render-Semantik aller Backends: Standardwerte, Partikel, Text-Animation,
 * Aufdeck-Clips. Diese reinen Funktionen stellen sicher, dass Skia, PixiJS und Three.js
 * dasselbe zeichnen (AD-5). Die Referenz steht in docs/reference/node-semantics.md.
 */
import { easing, hash32, interpolate, parseColor, random, toFrames } from '@agentic-video/timeline';
import type { EvaluatedNode, Reveal } from './contracts.js';
import { isRecord } from './guards.js';
import { getNumber, getString } from './props.js';

/** Standardfarbe für Formen ohne `fill` und ohne `stroke`, und für Text. */
export const DEFAULT_FILL = '#FFFFFF';
/** Standardschrift, wenn weder Node noch Project eine nennen. */
export const DEFAULT_FONT_FAMILY = 'Inter';
/** Ersatzschrift für Emoji. */
export const EMOJI_FONT_FAMILY = 'Noto Color Emoji';
/** Standardschriftgröße in Pixeln. */
export const DEFAULT_FONT_SIZE = 48;
/** Standardzeilenhöhe als Vielfaches der Schriftgröße. */
export const DEFAULT_LINE_HEIGHT = 1.2;

/**
 * Wählt die Füllung einer Form: explizites `fill`, sonst `#FFFFFF`, außer eine Kontur ist gesetzt.
 */
export function effectiveFill(node: EvaluatedNode): unknown {
  const fill = node.props['fill'];
  if (fill !== undefined) return fill;
  return node.props['stroke'] === undefined ? DEFAULT_FILL : undefined;
}

// ---------------------------------------------------------------------------
// Aufdeck-Clips (Wipe, Iris)
// ---------------------------------------------------------------------------

/** Clip-Rechteck oder -Ellipse eines Reveals in lokalen Box-Koordinaten. */
export function revealShape(reveal: Reveal, box: { x: number; y: number; width: number; height: number }): { shape: 'rect' | 'ellipse'; x: number; y: number; width: number; height: number } {
  const p = Math.min(Math.max(reveal.progress, 0), 1);
  const { x, y, width: w, height: h } = box;
  switch (reveal.direction) {
    case 'left':
      return { shape: 'rect', x, y, width: w * p, height: h };
    case 'right':
      return { shape: 'rect', x: x + w * (1 - p), y, width: w * p, height: h };
    case 'up':
      return { shape: 'rect', x, y, width: w, height: h * p };
    case 'down':
      return { shape: 'rect', x, y: y + h * (1 - p), width: w, height: h * p };
    case 'center': {
      // Iris: Ellipse, die bei p = 1 die ganze Box umschließt (Faktor √2).
      const rw = w * Math.SQRT2 * p;
      const rh = h * Math.SQRT2 * p;
      return { shape: reveal.shape, x: x + (w - rw) / 2, y: y + (h - rh) / 2, width: rw, height: rh };
    }
  }
}

// ---------------------------------------------------------------------------
// 2D-Partikel (zustandslos)
// ---------------------------------------------------------------------------

/** Zustand eines lebenden 2D-Partikels. */
export interface Particle2D {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly color: string;
  readonly opacity: number;
  readonly rotation: number;
}

function range(node: EvaluatedNode, key: string, fallback: { min: number; max: number }): { min: number; max: number } {
  const v = node.props[key];
  if (!isRecord(v)) return fallback;
  return { min: typeof v['min'] === 'number' ? v['min'] : fallback.min, max: typeof v['max'] === 'number' ? v['max'] : fallback.max };
}

function startEnd(node: EvaluatedNode, key: string, fallback: { start: number; end: number }): { start: number; end: number } {
  const v = node.props[key];
  if (!isRecord(v)) return fallback;
  return { start: typeof v['start'] === 'number' ? v['start'] : fallback.start, end: typeof v['end'] === 'number' ? v['end'] : fallback.end };
}

/**
 * Berechnet alle lebenden Partikel einer `particles`-Node zur lokalen Zeit.
 *
 * Formel (pro Partikel i, Zufall aus Seed und i):
 * - Geburt `b_i = i / count · emitDuration`, Alter `a = t − b_i`, lebendig für `0 ≤ a < life_i`.
 * - Position `emitter + v_i · a + ½ · gravity · a²` (Pixel, Sekunden).
 * - Größe, Farbe linear von `start` nach `end` über das Leben; Opacity mit Ein-/Ausblendung `fade`.
 *
 * @example
 * ```ts
 * const alive = particles2d(node, 1.5, 30);
 * ```
 */
export function particles2d(node: EvaluatedNode, timeSeconds: number, fps: number): Particle2D[] {
  const count = Math.max(0, Math.floor(getNumber(node, 'count', 100)));
  const seed = getNumber(node, 'seed', 0);
  const emitterRaw = node.props['emitter'];
  const emitter = isRecord(emitterRaw) ? emitterRaw : {};
  const ex = typeof emitter['x'] === 'number' ? emitter['x'] : getNumber(node, 'width', 0) / 2;
  const ey = typeof emitter['y'] === 'number' ? emitter['y'] : getNumber(node, 'height', 0) / 2;
  const radius = typeof emitter['radius'] === 'number' ? emitter['radius'] : 0;
  const shape = typeof emitter['shape'] === 'string' ? emitter['shape'] : 'point';
  const lifetime = range(node, 'lifetime', { min: 1, max: 2 });
  const speed = range(node, 'speed', { min: 50, max: 150 });
  const angle = range(node, 'angle', { min: 0, max: 360 });
  const gravityRaw = node.props['gravity'];
  const gx = isRecord(gravityRaw) && typeof gravityRaw['x'] === 'number' ? gravityRaw['x'] : 0;
  const gy = isRecord(gravityRaw) && typeof gravityRaw['y'] === 'number' ? gravityRaw['y'] : 0;
  const size = startEnd(node, 'size', { start: 6, end: 0 });
  const fade = startEnd(node, 'fade', { start: 0.1, end: 0.3 });
  const colorRaw = node.props['color'];
  const colorStart = isRecord(colorRaw) && typeof colorRaw['start'] === 'string' ? colorRaw['start'] : DEFAULT_FILL;
  const colorEnd = isRecord(colorRaw) && typeof colorRaw['end'] === 'string' ? colorRaw['end'] : colorStart;
  const emitDurationRaw = node.props['emitDuration'];
  const emitDuration = typeof emitDurationRaw === 'number' || typeof emitDurationRaw === 'string' ? toFrames(emitDurationRaw, { fps }) / fps : node.time.durationFrames / fps;
  const out: Particle2D[] = [];
  for (let i = 0; i < count; i++) {
    const birth = (i / Math.max(1, count)) * emitDuration;
    const life = lifetime.min + (lifetime.max - lifetime.min) * random(seed, 'life', i);
    const age = timeSeconds - birth;
    if (age < 0 || age >= life) continue;
    const a = ((angle.min + (angle.max - angle.min) * random(seed, 'angle', i)) * Math.PI) / 180;
    const v = speed.min + (speed.max - speed.min) * random(seed, 'speed', i);
    let ox = 0;
    let oy = 0;
    if (shape === 'circle' && radius > 0) {
      const r = radius * Math.sqrt(random(seed, 'r', i));
      const t = random(seed, 'theta', i) * Math.PI * 2;
      ox = Math.cos(t) * r;
      oy = Math.sin(t) * r;
    } else if ((shape === 'rect' || shape === 'box') && radius > 0) {
      ox = (random(seed, 'rx', i) * 2 - 1) * radius;
      oy = (random(seed, 'ry', i) * 2 - 1) * radius;
    }
    const k = age / life;
    const fadeIn = fade.start > 0 ? Math.min(1, k / fade.start) : 1;
    const fadeOut = fade.end > 0 ? Math.min(1, (1 - k) / fade.end) : 1;
    const c = interpolate(colorStart, colorEnd, k);
    out.push({
      index: i,
      x: ex + ox + Math.cos(a) * v * age + 0.5 * gx * age * age,
      y: ey + oy + Math.sin(a) * v * age + 0.5 * gy * age * age,
      size: size.start + (size.end - size.start) * k,
      color: typeof c === 'string' ? c : colorStart,
      opacity: Math.max(0, Math.min(fadeIn, fadeOut)),
      rotation: (hash32(seed, 'rot', i) % 360) + age * 90,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text-Animation pro Zeichen, Wort, Zeile (FR-35)
// ---------------------------------------------------------------------------

/** Zustand einer Text-Einheit (Zeichen, Wort oder Zeile). */
export interface TextUnitState {
  /** Fortschritt 0..1 nach Easing (1 = Endzustand). */
  readonly progress: number;
  readonly opacity: number;
  readonly dx: number;
  readonly dy: number;
  readonly scale: number;
  readonly rotation: number;
  readonly blur: number;
  /** Farbe am Anfang der Animation, falls animiert. */
  readonly color?: { readonly from: string; readonly mix: number };
}

/**
 * Zustand der Einheit `index` von `count` einer `textAnimation` zur lokalen Zeit (Frames).
 * Die Einheit bewegt sich von den `from`-Werten zum Normalzustand.
 *
 * @example
 * ```ts
 * textUnitState(node, 2, 10, 30); // dritte Einheit bei lokalem Frame 30
 * ```
 */
export function textUnitState(node: EvaluatedNode, index: number, count: number, frame: number, fps: number): TextUnitState {
  const spec = node.props['textAnimation'];
  if (!isRecord(spec)) return { progress: 1, opacity: 1, dx: 0, dy: 0, scale: 1, rotation: 0, blur: 0 };
  const tf = (v: unknown, fallback: number): number => (typeof v === 'number' || typeof v === 'string' ? toFrames(v, { fps }) : fallback);
  const start = tf(spec['start'], 0);
  const stagger = tf(spec['stagger'], 2);
  const duration = Math.max(1e-6, tf(spec['duration'], 15));
  const order = typeof spec['order'] === 'string' ? spec['order'] : 'forward';
  let position = index;
  if (order === 'backward') position = count - 1 - index;
  else if (order === 'center') position = Math.abs(index - (count - 1) / 2);
  else if (order === 'random') position = Math.floor(random(getNumber(node, 'seed', 0), 'text-order', index) * count);
  const raw = (frame - start - position * stagger) / duration;
  const p = easing(typeof spec['ease'] === 'string' ? spec['ease'] : 'easeOutCubic')(Math.min(Math.max(raw, 0), 1));
  const from = isRecord(spec['from']) ? spec['from'] : {};
  const q = 1 - p;
  const val = (key: string, rest: number): number => (typeof from[key] === 'number' ? from[key] * q + rest * p : rest);
  const color = typeof from['color'] === 'string' ? { from: from['color'], mix: q } : undefined;
  return {
    progress: p,
    opacity: val('opacity', 1),
    dx: val('x', 0),
    dy: val('y', 0),
    scale: val('scale', 1),
    rotation: val('rotation', 0),
    blur: val('blur', 0),
    ...(color !== undefined ? { color } : {}),
  };
}

/** Zerlegt Text in Einheiten; Leerzeichen gehören zur vorigen Einheit. */
export function splitTextUnits(text: string, unit: 'char' | 'word' | 'line'): string[] {
  if (unit === 'line') return text.split('\n');
  if (unit === 'word') return text.match(/\S+\s*/gu) ?? [];
  // Feste Locale `und` (Story 18.9): Grapheme hängen nicht von der Systemsprache ab.
  return Array.from(new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(text), (s) => s.segment);
}

/** Liefert die Schriftfamilie einer Text-Node mit Standardwert. */
export function fontFamilyOf(node: EvaluatedNode, projectDefault?: string): string {
  return getString(node, 'fontFamily', projectDefault ?? DEFAULT_FONT_FAMILY);
}

/** Parst eine Farbe in 0..255-Kanäle (nicht vormultipliziert). */
export function colorBytes(color: string): [number, number, number, number] {
  const c = parseColor(color);
  return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255), Math.round(c.a * 255)];
}
