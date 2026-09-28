/**
 * CSS-Bausteine für den SVG-Import: Farben, Deklarationen, einfache Stylesheets.
 */
import { formatColor } from '@agentic-video/core';

const NAMED =
  'aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff ' +
  'blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc ' +
  'crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b ' +
  'darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b ' +
  'darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 ' +
  'dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 ' +
  'gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c ' +
  'lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff lightgoldenrodyellow:fafad2 ' +
  'lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 ' +
  'lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 ' +
  'mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a ' +
  'mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 ' +
  'oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee ' +
  'palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 rebeccapurple:663399 ' +
  'red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d ' +
  'silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 ' +
  'thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32';

const NAMED_COLORS: ReadonlyMap<string, string> = new Map(
  NAMED.split(' ').map((pair) => {
    const [name, hex] = pair.split(':');
    return [name ?? '', `#${hex ?? '000000'}`];
  }),
);

/** Farbe mit Kanälen 0..1. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

function channel(text: string, max: number): number {
  const t = text.trim();
  const v = t.endsWith('%') ? (Number(t.slice(0, -1)) / 100) * max : Number(t);
  return Number.isFinite(v) ? Math.min(Math.max(v / max, 0), 1) : 0;
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: f(0), g: f(8), b: f(4) };
}

/**
 * Parst eine CSS-Farbe: Hex, `rgb()`, `rgba()`, `hsl()`, `hsla()`, Namen, `transparent`.
 * Liefert `undefined` für Unbekanntes.
 *
 * @example
 * ```ts
 * parseCssColor('rgb(255, 0, 0)'); // { r: 1, g: 0, b: 0, a: 1 }
 * ```
 */
export function parseCssColor(input: string): Rgba | undefined {
  const text = input.trim().toLowerCase();
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  const named = NAMED_COLORS.get(text);
  const hexText = named ?? text;
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/u.exec(hexText)?.[1];
  if (hex !== undefined) {
    const full = hex.length <= 4 ? hex.split('').map((c) => c + c).join('') : hex;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) : 1 };
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/u.exec(text);
  if (fn === null) return undefined;
  const parts = (fn[2] ?? '').split(/[\s,/]+/u).filter((p) => p.length > 0);
  if (parts.length < 3) return undefined;
  const alpha = parts[3] !== undefined ? channel(parts[3], 1) : 1;
  if ((fn[1] ?? '').startsWith('rgb')) {
    return { r: channel(parts[0] ?? '0', 255), g: channel(parts[1] ?? '0', 255), b: channel(parts[2] ?? '0', 255), a: alpha };
  }
  const h = Number((parts[0] ?? '0').replace(/deg$/u, ''));
  const rgb = hslToRgb(((h % 360) + 360) % 360, channel(parts[1] ?? '0', 1), channel(parts[2] ?? '0', 1));
  return { ...rgb, a: alpha };
}

/** Formatiert eine Farbe als IR-Farbe (`#RRGGBB` oder `#RRGGBBAA`); Deckkraft wird multipliziert. */
export function irColor(c: Rgba, opacity = 1): string {
  return formatColor({ r: c.r, g: c.g, b: c.b, a: Math.min(Math.max(c.a * opacity, 0), 1) });
}

/**
 * Zerlegt einen `style`-Attributtext in Deklarationen.
 *
 * @example
 * ```ts
 * parseDeclarations('fill: red; stroke-width: 2'); // { fill: 'red', 'stroke-width': '2' }
 * ```
 */
export function parseDeclarations(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const key = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).replace(/!important/giu, '').trim();
    if (key.length > 0 && value.length > 0) out[key] = value;
  }
  return out;
}

/** Eine einfache CSS-Regel. */
export interface CssRule {
  /** Element-Name, falls angegeben. */
  readonly tag?: string;
  readonly id?: string;
  readonly classes: readonly string[];
  readonly specificity: number;
  readonly order: number;
  readonly declarations: Readonly<Record<string, string>>;
}

/** Ergebnis von {@link parseStylesheet}. */
export interface Stylesheet {
  readonly rules: readonly CssRule[];
  /** Selektoren und At-Regeln, die nicht unterstützt werden. */
  readonly unsupported: readonly string[];
}

const SIMPLE_SELECTOR = /^([A-Za-z][\w-]*|\*)?((?:[.#][\w-]+)*)$/u;

/**
 * Parst ein einfaches Stylesheet: Selektoren aus Tag, `.klasse` und `#id` (auch kombiniert).
 * Nachfahren-Selektoren, Pseudoklassen und At-Regeln landen in `unsupported`.
 *
 * @example
 * ```ts
 * parseStylesheet('.a, rect#b { fill: red }').rules.length; // 2
 * ```
 */
export function parseStylesheet(css: string, orderStart = 0): Stylesheet {
  const rules: CssRule[] = [];
  const unsupported: string[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  let order = orderStart;
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const prelude = text.slice(i, open).trim();
    // Passende schließende Klammer finden (At-Regeln können verschachtelt sein)
    let depth = 1;
    let j = open + 1;
    for (; j < text.length && depth > 0; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
    }
    const body = text.slice(open + 1, j - 1);
    i = j;
    if (prelude.startsWith('@')) {
      unsupported.push(prelude);
      continue;
    }
    const declarations = parseDeclarations(body);
    for (const raw of prelude.split(',')) {
      const selector = raw.trim();
      const m = SIMPLE_SELECTOR.exec(selector);
      if (selector.length === 0) continue;
      if (m === null) {
        unsupported.push(selector);
        continue;
      }
      const tag = m[1] !== undefined && m[1] !== '*' ? m[1] : undefined;
      const parts = (m[2] ?? '').match(/[.#][\w-]+/gu) ?? [];
      const classes = parts.filter((p) => p.startsWith('.')).map((p) => p.slice(1));
      const ids = parts.filter((p) => p.startsWith('#')).map((p) => p.slice(1));
      if (ids.length > 1) {
        unsupported.push(selector);
        continue;
      }
      rules.push({
        ...(tag !== undefined ? { tag } : {}),
        ...(ids[0] !== undefined ? { id: ids[0] } : {}),
        classes,
        specificity: ids.length * 100 + classes.length * 10 + (tag !== undefined ? 1 : 0),
        order: order++,
        declarations,
      });
    }
  }
  return { rules, unsupported };
}

/** Deklarationen aller passenden Regeln, nach Spezifität und Reihenfolge zusammengeführt. */
export function matchRules(rules: readonly CssRule[], tag: string, id: string | undefined, classes: readonly string[]): Record<string, string> {
  const hits = rules
    .filter((r) => (r.tag === undefined || r.tag === tag) && (r.id === undefined || r.id === id) && r.classes.every((c) => classes.includes(c)))
    .sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  const out: Record<string, string> = {};
  for (const r of hits) Object.assign(out, r.declarations);
  return out;
}
