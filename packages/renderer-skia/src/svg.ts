/**
 * Kleiner, eigener SVG-Parser (ohne DOM). Er liefert einen reinen Datenbaum,
 * den der Skia-Renderer zeichnet und spätere SVG-Importe weiterverwenden.
 *
 * Unterstützt: `svg`, `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`,
 * `polygon`, einfaches `text`, `linearGradient`, `radialGradient`, `stop`, `defs`, `use`.
 * Attribute: `transform`, `fill`, `stroke`, `stroke-width`, `opacity`, `fill-opacity`,
 * `stroke-opacity`, `fill-rule`, `viewBox`, `style` (und einige verwandte wie `stroke-linecap`).
 */

/** Ein Element des SVG-Baums. `attrs` enthält auch die Werte aus `style`. */
export interface SvgElement {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly SvgElement[];
  /** Direkter Textinhalt (für `text`). */
  readonly text: string;
}

/** Ergebnis von {@link parseSvg}. */
export interface SvgDocument {
  readonly root: SvgElement;
  /** Eigengröße aus `width`/`height`, sonst aus `viewBox`, sonst 300 × 150. */
  readonly width: number;
  readonly height: number;
  readonly viewBox: readonly [number, number, number, number] | undefined;
  /** Elemente mit `id`. */
  readonly ids: ReadonlyMap<string, SvgElement>;
  /** Namen nicht unterstützter Elemente (ohne Duplikate, sortiert). */
  readonly unsupported: readonly string[];
}

/** Elemente, die der Renderer zeichnet oder auswertet. */
export const SUPPORTED_SVG_ELEMENTS: ReadonlySet<string> = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'linearGradient', 'radialGradient', 'stop', 'defs', 'use']);
/** Elemente ohne Darstellung, die still übergangen werden. */
const IGNORED_SVG_ELEMENTS: ReadonlySet<string> = new Set(['title', 'desc', 'metadata']);

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: String.fromCharCode(0xa0) };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/gu, (match, code: string) => {
    if (code.startsWith('#x')) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith('#')) return String.fromCodePoint(parseInt(code.slice(1), 10));
    return ENTITIES[code] ?? match;
  });
}

interface MutableElement {
  name: string;
  attrs: Record<string, string>;
  children: MutableElement[];
  text: string;
}

function parseStyle(style: string, into: Record<string, string>): void {
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const key = decl.slice(0, i).trim();
    const value = decl.slice(i + 1).trim();
    if (key.length > 0 && value.length > 0) into[key] = value;
  }
}

/**
 * Liest eine Längenangabe in Pixeln; Prozent relativ zu `ref`.
 *
 * @example
 * ```ts
 * svgLength('50%', 0, 200); // 100
 * ```
 */
export function svgLength(value: string | undefined, fallback: number, ref = 0): number {
  if (value === undefined) return fallback;
  const m = /^\s*(-?[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?)\s*(px|%|pt|em)?\s*$/u.exec(value);
  if (m === null) return fallback;
  const n = Number(m[1]);
  switch (m[2]) {
    case '%':
      return (n / 100) * ref;
    case 'pt':
      return (n * 4) / 3;
    case 'em':
      return n * 16;
    default:
      return n;
  }
}

/**
 * Liest eine Zahlenliste (Komma oder Leerzeichen getrennt).
 *
 * @example
 * ```ts
 * svgNumbers('0,0 10 5'); // [0, 0, 10, 5]
 * ```
 */
export function svgNumbers(value: string | undefined): number[] {
  if (value === undefined) return [];
  return (value.match(/-?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/gu) ?? []).map(Number);
}

/**
 * Parst SVG-Markup in einen Datenbaum. Wirft nie; kaputtes Markup liefert einen möglichst
 * vollständigen Baum. Nicht unterstützte Elemente stehen in `unsupported`.
 *
 * @example
 * ```ts
 * const doc = parseSvg('<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>');
 * doc.root.children[0]?.name; // 'rect'
 * ```
 */
export function parseSvg(markup: string): SvgDocument {
  const source = markup.replace(/<!--[\s\S]*?-->/gu, '').replace(/<\?[\s\S]*?\?>/gu, '').replace(/<!DOCTYPE[^>]*>/giu, '');
  const top: MutableElement = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: MutableElement[] = [top];
  const unsupported = new Set<string>();
  const ids = new Map<string, SvgElement>();
  const tagRe = /<!\[CDATA\[([\s\S]*?)\]\]>|<\/\s*([A-Za-z_][\w:.-]*)\s*>|<\s*([A-Za-z_][\w:.-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/gu;
  const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/gu;
  let last = 0;
  for (const m of source.matchAll(tagRe)) {
    const current = stack[stack.length - 1] ?? top;
    const between = source.slice(last, m.index);
    last = m.index + m[0].length;
    if (between.trim().length > 0) current.text += decodeEntities(between);
    if (m[1] !== undefined) {
      current.text += m[1];
      continue;
    }
    if (m[2] !== undefined) {
      const name = m[2].replace(/^svg:/u, '');
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i]?.name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const name = (m[3] ?? '').replace(/^svg:/u, '');
    const attrs: Record<string, string> = {};
    for (const a of (m[4] ?? '').matchAll(attrRe)) {
      const key = a[1] ?? '';
      if (key === 'style') continue;
      attrs[key] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
    }
    const style = /(?:^|\s)style\s*=\s*(?:"([^"]*)"|'([^']*)')/u.exec(m[4] ?? '');
    if (style !== null) parseStyle(decodeEntities(style[1] ?? style[2] ?? ''), attrs);
    const el: MutableElement = { name, attrs, children: [], text: '' };
    current.children.push(el);
    if (!SUPPORTED_SVG_ELEMENTS.has(name) && !IGNORED_SVG_ELEMENTS.has(name)) unsupported.add(name);
    if (attrs['id'] !== undefined) ids.set(attrs['id'], el);
    if (m[5] !== '/') stack.push(el);
  }
  const root: SvgElement = top.children.find((c) => c.name === 'svg') ?? { name: 'svg', attrs: {}, children: top.children, text: '' };
  const vb = svgNumbers(root.attrs['viewBox']);
  const viewBox: [number, number, number, number] | undefined = vb.length === 4 && (vb[2] ?? 0) > 0 && (vb[3] ?? 0) > 0 ? [vb[0] ?? 0, vb[1] ?? 0, vb[2] ?? 0, vb[3] ?? 0] : undefined;
  const width = svgLength(root.attrs['width'], viewBox?.[2] ?? 300, viewBox?.[2] ?? 300);
  const height = svgLength(root.attrs['height'], viewBox?.[3] ?? 150, viewBox?.[3] ?? 150);
  return { root, width, height, viewBox, ids, unsupported: [...unsupported].sort() };
}

/** Eine affine Matrix `[a, b, c, d, e, f]` wie in SVG. */
export type SvgMatrix = readonly [number, number, number, number, number, number];

function mul(m: SvgMatrix, n: SvgMatrix): SvgMatrix {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}

/**
 * Parst ein SVG-`transform`-Attribut (matrix, translate, scale, rotate, skewX, skewY).
 *
 * @example
 * ```ts
 * parseSvgTransform('translate(10 20) rotate(45)');
 * ```
 */
export function parseSvgTransform(value: string | undefined): SvgMatrix {
  let m: SvgMatrix = [1, 0, 0, 1, 0, 0];
  if (value === undefined) return m;
  for (const t of value.matchAll(/(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gu)) {
    const a = svgNumbers(t[2]);
    const n0 = a[0] ?? 0;
    switch (t[1]) {
      case 'matrix':
        if (a.length === 6) m = mul(m, [n0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 0, a[4] ?? 0, a[5] ?? 0]);
        break;
      case 'translate':
        m = mul(m, [1, 0, 0, 1, n0, a[1] ?? 0]);
        break;
      case 'scale':
        m = mul(m, [n0, 0, 0, a[1] ?? n0, 0, 0]);
        break;
      case 'rotate': {
        const r = (n0 * Math.PI) / 180;
        const cx = a[1] ?? 0;
        const cy = a[2] ?? 0;
        m = mul(m, [1, 0, 0, 1, cx, cy]);
        m = mul(m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
        m = mul(m, [1, 0, 0, 1, -cx, -cy]);
        break;
      }
      case 'skewX':
        m = mul(m, [1, 0, Math.tan((n0 * Math.PI) / 180), 1, 0, 0]);
        break;
      case 'skewY':
        m = mul(m, [1, Math.tan((n0 * Math.PI) / 180), 0, 1, 0, 0]);
        break;
      default:
        break;
    }
  }
  return m;
}

const NAMED_COLORS: Readonly<Record<string, string>> = {
  black: '#000000', white: '#FFFFFF', red: '#FF0000', green: '#008000', blue: '#0000FF', yellow: '#FFFF00',
  orange: '#FFA500', purple: '#800080', gray: '#808080', grey: '#808080', silver: '#C0C0C0', maroon: '#800000',
  navy: '#000080', teal: '#008080', olive: '#808000', lime: '#00FF00', aqua: '#00FFFF', cyan: '#00FFFF',
  fuchsia: '#FF00FF', magenta: '#FF00FF', pink: '#FFC0CB', brown: '#A52A2A', gold: '#FFD700', indigo: '#4B0082',
  violet: '#EE82EE', coral: '#FF7F50', salmon: '#FA8072', tomato: '#FF6347', crimson: '#DC143C', skyblue: '#87CEEB',
  steelblue: '#4682B4', darkgray: '#A9A9A9', darkgrey: '#A9A9A9', lightgray: '#D3D3D3', lightgrey: '#D3D3D3',
  transparent: '#00000000',
};

function hex2(n: number): string {
  return Math.round(Math.min(Math.max(n, 0), 255)).toString(16).padStart(2, '0').toUpperCase();
}

/**
 * Wandelt eine SVG-Farbe (`#rgb`, `#rrggbb`, `rgb()`, `rgba()`, Farbnamen) in `#RRGGBBAA`; `undefined` wenn unbekannt.
 *
 * @example
 * ```ts
 * svgColor('rgb(255, 0, 0)'); // '#FF0000FF'
 * ```
 */
export function svgColor(value: string): string | undefined {
  const v = value.trim().toLowerCase();
  const named = NAMED_COLORS[v];
  if (named !== undefined) return named.length === 7 ? `${named}FF` : named;
  if (/^#[0-9a-f]{3}$/u.test(v)) return `#${v.slice(1).replace(/./gu, (c) => c + c).toUpperCase()}FF`;
  if (/^#[0-9a-f]{4}$/u.test(v)) return `#${v.slice(1).replace(/./gu, (c) => c + c).toUpperCase()}`;
  if (/^#[0-9a-f]{6}$/u.test(v)) return `${v.toUpperCase()}FF`;
  if (/^#[0-9a-f]{8}$/u.test(v)) return v.toUpperCase();
  const m = /^rgba?\(([^)]*)\)$/u.exec(v);
  if (m !== null) {
    const parts = (m[1] ?? '').split(/[\s,/]+/u).filter((p) => p.length > 0);
    const ch = (p: string | undefined): number => (p === undefined ? 0 : p.endsWith('%') ? (Number(p.slice(0, -1)) / 100) * 255 : Number(p));
    const alphaPart = parts[3];
    const alpha = alphaPart === undefined ? 1 : alphaPart.endsWith('%') ? Number(alphaPart.slice(0, -1)) / 100 : Number(alphaPart);
    return `#${hex2(ch(parts[0]))}${hex2(ch(parts[1]))}${hex2(ch(parts[2]))}${hex2(alpha * 255)}`;
  }
  return undefined;
}
