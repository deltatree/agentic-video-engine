/**
 * Reine Stil-Berechnung für HTML-Layer: Node-Werte → CSS-Werte.
 *
 * Läuft in der Seite und in Node (Tests), denn sie nutzt nur `@agentic-video/core`.
 */
import { getTransform, isRecord, localMatrix, multiply, revealShape, scale as scaleMatrix, type EvaluatedNode, type Matrix2D } from '@agentic-video/core';

/** CSS-Werte für den Container einer HTML-Node. */
export interface HtmlNodeStyle {
  readonly width: number;
  readonly height: number;
  readonly transform: string;
  readonly opacity: string;
  readonly mixBlendMode: string;
  /** CSS-Filterkette; `url(#…)`-Verweise zeigen auf {@link HtmlNodeStyle.colorMatrices}. */
  readonly filter: string;
  /** Farbmatrizen (je 20 Werte) für SVG-`feColorMatrix`, in Reihenfolge ihrer IDs. */
  readonly colorMatrices: readonly (readonly number[])[];
  readonly clipPath: string;
  readonly background: string;
}

const BLEND_TO_CSS: Readonly<Record<string, string>> = {
  normal: 'normal',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color-dodge': 'color-dodge',
  'color-burn': 'color-burn',
  'hard-light': 'hard-light',
  'soft-light': 'soft-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
  add: 'plus-lighter',
};

/** Formatiert eine Zahl kurz und ohne Exponent-Schreibweise für CSS. */
function num(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? '0' : rounded.toFixed(6).replace(/\.?0+$/u, '');
}

/**
 * CSS-`matrix(...)` aus einer 2D-Matrix.
 *
 * @example
 * ```ts
 * cssMatrix([1, 0, 0, 1, 10, 20]); // 'matrix(1, 0, 0, 1, 10, 20)'
 * ```
 */
export function cssMatrix(m: Matrix2D): string {
  return `matrix(${m.map(num).join(', ')})`;
}

/**
 * CSS-`mix-blend-mode` für einen Blend Mode der IR; unbekannte Werte liefern `undefined`.
 *
 * @example
 * ```ts
 * cssBlendMode('add'); // 'plus-lighter'
 * ```
 */
export function cssBlendMode(mode: unknown): string | undefined {
  if (mode === undefined) return 'normal';
  return typeof mode === 'string' ? BLEND_TO_CSS[mode] : undefined;
}

function numberField(record: Record<string, unknown>, key: string, fallback: number): number {
  const v = record[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * CSS-Filterkette aus `filters` und `shadow` einer Node.
 *
 * @example
 * ```ts
 * cssFilter([{ type: 'blur', radius: 4 }], undefined, (i) => `cm${i}`); // { filter: 'blur(4px)', colorMatrices: [] }
 * ```
 */
export function cssFilter(filters: unknown, shadow: unknown, idFor: (index: number) => string): { filter: string; colorMatrices: number[][] } {
  const parts: string[] = [];
  const colorMatrices: number[][] = [];
  if (Array.isArray(filters)) {
    for (const f of filters) {
      if (!isRecord(f)) continue;
      switch (f['type']) {
        case 'blur':
          parts.push(`blur(${num(numberField(f, 'radius', 0))}px)`);
          break;
        case 'brightness':
        case 'contrast':
        case 'saturate':
        case 'grayscale':
        case 'sepia':
        case 'invert':
          parts.push(`${f['type']}(${num(numberField(f, 'amount', 1))})`);
          break;
        case 'hue-rotate':
          parts.push(`hue-rotate(${num(numberField(f, 'degrees', 0))}deg)`);
          break;
        case 'color-matrix': {
          const m = f['matrix'];
          if (Array.isArray(m) && m.length === 20 && m.every((v) => typeof v === 'number')) {
            parts.push(`url(#${idFor(colorMatrices.length)})`);
            colorMatrices.push(m.filter((v) => typeof v === 'number'));
          }
          break;
        }
        default:
          break;
      }
    }
  }
  if (isRecord(shadow) && typeof shadow['color'] === 'string') {
    parts.push(`drop-shadow(${num(numberField(shadow, 'offsetX', 0))}px ${num(numberField(shadow, 'offsetY', 0))}px ${num(numberField(shadow, 'blur', 0))}px ${shadow['color']})`);
  }
  return { filter: parts.length === 0 ? 'none' : parts.join(' '), colorMatrices };
}

/**
 * Berechnet alle Container-Stile einer `html`-Node für eine Ausgabe-Skalierung.
 *
 * @example
 * ```ts
 * const style = htmlNodeStyle(node, 0.5, (i) => `ov-cm-0-${i}`);
 * container.style.transform = style.transform;
 * ```
 */
export function htmlNodeStyle(node: EvaluatedNode, outputScale: number, idFor: (index: number) => string): HtmlNodeStyle {
  const width = numberField(node.props, 'width', 0);
  const height = numberField(node.props, 'height', 0);
  const m = multiply(scaleMatrix(outputScale, outputScale), localMatrix(node));
  const { filter, colorMatrices } = cssFilter(node.props['filters'], node.props['shadow'], idFor);
  let clipPath = 'none';
  if (node.reveal !== undefined) {
    const r = revealShape(node.reveal, { x: 0, y: 0, width, height });
    clipPath =
      r.shape === 'rect'
        ? `inset(${num(r.y)}px ${num(width - r.x - r.width)}px ${num(height - r.y - r.height)}px ${num(r.x)}px)`
        : `ellipse(${num(r.width / 2)}px ${num(r.height / 2)}px at ${num(r.x + r.width / 2)}px ${num(r.y + r.height / 2)}px)`;
  }
  const background = node.props['background'];
  return {
    width,
    height,
    transform: cssMatrix(m),
    opacity: num(getTransform(node).opacity),
    mixBlendMode: cssBlendMode(node.props['blendMode']) ?? 'normal',
    filter,
    colorMatrices,
    clipPath,
    background: typeof background === 'string' ? background : 'transparent',
  };
}
