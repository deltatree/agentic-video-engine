/**
 * Laden, Prüfen und Hashen von Schriften (FR-32).
 * Es gibt keine automatische Suche nach Systemschriften: Nur gebündelte und
 * im Project registrierte Schriften zählen (Determinismus).
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMOJI_FONT_FAMILY, OpenVideoError, contentHash, isOpenVideoError, type Diagnostic, type Font, type FontFace, type FontResolver } from '@agentic-video/core';
import { parseFontInfo, type FontAxis } from './sfnt.js';
import { toSfnt } from './woff.js';

/** Schrift-Registrierung aus der IR (`project.fonts[]`). */
export type IrFont = Font;

/** Eine geladene Schrift mit zusätzlichen Metadaten. */
export interface LoadedFontFace extends FontFace {
  /** Familienname aus der Datei (kann vom registrierten Namen abweichen). */
  readonly sourceFamily: string;
  readonly postscriptName: string;
  readonly axes: readonly FontAxis[];
  /** `true` für die mit OpenVideo gebündelten Standardschriften. */
  readonly bundled: boolean;
}

/** Optionen für {@link loadFontSet}. */
export interface LoadFontSetOptions {
  /** Basisordner für relative `src`-Pfade. Standard: aktuelles Arbeitsverzeichnis. */
  readonly projectDir?: string;
  /** Schriften aus `project.fonts`. */
  readonly fonts?: readonly IrFont[];
  /** Löst `font.asset` auf (z. B. über den Asset Store). */
  readonly resolveAsset?: (id: string) => Promise<{ path: string; bytes: Uint8Array }>;
  /** Gebündelte Standardschriften laden (Inter, JetBrains Mono, Noto Color Emoji). Standard: `true`. */
  readonly includeDefaults?: boolean;
}

/** Eine gebündelte Standardschrift. */
interface BundledFont {
  readonly family: string;
  readonly file: string;
}

/**
 * Gebündelte Standardschriften in fester Reihenfolge (SIL OFL 1.1, Lizenzen in `assets/`).
 *
 * @example
 * ```ts
 * BUNDLED_FONTS.map((f) => f.family); // ['Inter', 'Inter', 'JetBrains Mono', 'JetBrains Mono', 'Noto Color Emoji']
 * ```
 */
export const BUNDLED_FONTS: readonly BundledFont[] = [
  { family: 'Inter', file: 'inter/InterVariable.ttf' },
  { family: 'Inter', file: 'inter/InterVariable-Italic.ttf' },
  { family: 'JetBrains Mono', file: 'jetbrains-mono/JetBrainsMono-Variable.ttf' },
  { family: 'JetBrains Mono', file: 'jetbrains-mono/JetBrainsMono-Italic-Variable.ttf' },
  { family: EMOJI_FONT_FAMILY, file: 'noto-color-emoji/NotoColorEmoji.ttf' },
];

/**
 * Absoluter Pfad einer gebündelten Schriftdatei.
 *
 * @example
 * ```ts
 * bundledFontPath('inter/InterVariable.ttf'); // '/…/packages/fonts/assets/inter/InterVariable.ttf'
 * ```
 */
export function bundledFontPath(file: string): string {
  return fileURLToPath(new URL(`../assets/${file}`, import.meta.url));
}

function parseWeight(weight: IrFont['weight']): number | readonly [number, number] | undefined {
  if (typeof weight === 'number') return weight;
  if (typeof weight === 'string') {
    const [a, b] = weight.split(' ').map(Number);
    if (a !== undefined && b !== undefined && Number.isFinite(a) && Number.isFinite(b)) return [a, b];
  }
  return undefined;
}

/**
 * Menge geladener Schriften. Implementiert `FontResolver` aus `@agentic-video/core`.
 *
 * @example
 * ```ts
 * const set = await loadFontSet({ projectDir: '.', fonts: project.fonts });
 * set.has('Inter'); // true
 * set.fallbacks(); // ['Noto Color Emoji', …]
 * ```
 */
export class FontSet implements FontResolver {
  readonly diagnostics: readonly Diagnostic[];
  readonly #faces: readonly LoadedFontFace[];

  constructor(faces: readonly LoadedFontFace[], diagnostics: readonly Diagnostic[] = []) {
    this.#faces = faces;
    this.diagnostics = diagnostics;
  }

  /** Alle geladenen Schriften in Ladereihenfolge. */
  all(): readonly LoadedFontFace[] {
    return this.#faces;
  }

  /** Alle geladenen Schriften mit Metadaten. */
  faces(): readonly LoadedFontFace[] {
    return this.#faces;
  }

  /** Familiennamen ohne Duplikate in Ladereihenfolge. */
  families(): string[] {
    return [...new Set(this.#faces.map((f) => f.family))];
  }

  /** Prüft, ob eine Familie geladen ist (Groß-/Kleinschreibung egal). */
  has(family: string): boolean {
    const key = family.toLowerCase();
    return this.#faces.some((f) => f.family.toLowerCase() === key);
  }

  /** Ersatzfamilien für fehlende Glyphen: zuerst Emoji, dann alle übrigen Familien in Ladereihenfolge. */
  fallbacks(): readonly string[] {
    const families = this.families();
    const emoji = families.filter((f) => f === EMOJI_FONT_FAMILY);
    return [...emoji, ...families.filter((f) => f !== EMOJI_FONT_FAMILY)];
  }
}

function faceFrom(original: Uint8Array, path: string, family: string, bundled: boolean, override?: IrFont): LoadedFontFace {
  // WOFF/WOFF2 und Sammlungen werden zu einer SFNT-Datei (Story 17.9); Skia bekommt nur SFNT.
  // Der Hash gilt der umgewandelten Schrift, damit jedes Face einer Sammlung einen eigenen hat.
  const bytes = toSfnt(original, override?.faceIndex ?? 0);
  const info = parseFontInfo(bytes);
  const wght = info.axes.find((a) => a.tag === 'wght');
  const weight = parseWeight(override?.weight) ?? (wght !== undefined ? ([wght.min, wght.max] as const) : info.weight);
  return {
    family,
    weight,
    style: override?.style ?? (info.italic ? 'italic' : 'normal'),
    hash: contentHash(bytes),
    path,
    bytes,
    variable: info.axes.length > 0,
    sourceFamily: info.family,
    postscriptName: info.postscriptName,
    axes: info.axes,
    bundled,
  };
}

function diagnosticOf(error: unknown, family: string, source: string, pointer: string | undefined): Diagnostic {
  const base = isOpenVideoError(error)
    ? error.diagnostic
    : {
        code: 'OV_FONT_INVALID',
        severity: 'error' as const,
        errorClass: 'FontError',
        problem: error instanceof Error ? error.message : String(error),
        suggestions: ['Provide a valid .ttf, .otf, .ttc, .woff or .woff2 file.'],
      };
  return { ...base, problem: `Font "${family}" (${source}): ${base.problem}`, details: { family, source }, ...(pointer !== undefined ? { pointer } : {}) };
}

function missing(family: string, source: string, problem: string, suggestions: string[], pointer: string): Diagnostic {
  return { code: 'OV_FONT_MISSING', severity: 'error', errorClass: 'FontError', problem: `Font "${family}": ${problem}`, pointer, details: { family, source }, suggestions };
}

/**
 * Lädt gebündelte und im Project registrierte Schriften, prüft und hasht sie.
 * Fehler landen als Diagnosen in `diagnostics`; die Funktion wirft nicht für einzelne Schriften.
 *
 * @example
 * ```ts
 * const fonts = await loadFontSet({ projectDir: '/work/demo', fonts: [{ family: 'Brand', src: 'fonts/Brand.ttf' }] });
 * for (const d of fonts.diagnostics) console.warn(d.problem);
 * ```
 */
export async function loadFontSet(options: LoadFontSetOptions = {}): Promise<FontSet> {
  const faces: LoadedFontFace[] = [];
  const diagnostics: Diagnostic[] = [];
  if (options.includeDefaults !== false) {
    for (const b of BUNDLED_FONTS) {
      const path = bundledFontPath(b.file);
      try {
        faces.push(faceFrom(new Uint8Array(await readFile(path)), path, b.family, true));
      } catch (error: unknown) {
        diagnostics.push(diagnosticOf(error, b.family, path, undefined));
      }
    }
  }
  const list = options.fonts ?? [];
  for (let i = 0; i < list.length; i++) {
    const font = list[i];
    if (font === undefined) continue;
    const pointer = `/fonts/${String(i)}`;
    let bytes: Uint8Array;
    let path: string;
    if (font.asset !== undefined) {
      if (options.resolveAsset === undefined) {
        diagnostics.push(missing(font.family, font.asset, `asset "${font.asset}" cannot be resolved without an asset resolver.`, ['Pass `resolveAsset` to loadFontSet().', `Use \`src\` with a file path instead of \`asset\`.`], pointer));
        continue;
      }
      try {
        const resolved = await options.resolveAsset(font.asset);
        bytes = resolved.bytes;
        path = resolved.path;
      } catch (error: unknown) {
        diagnostics.push(missing(font.family, font.asset, `asset "${font.asset}" could not be loaded (${error instanceof Error ? error.message : String(error)}).`, [`Import the font with \`openvideo assets import <file>\` as asset "${font.asset}".`], pointer));
        continue;
      }
    } else if (font.src !== undefined) {
      path = isAbsolute(font.src) ? font.src : resolve(options.projectDir ?? '.', font.src);
      try {
        bytes = new Uint8Array(await readFile(path));
      } catch {
        diagnostics.push(missing(font.family, font.src, `file not found at ${path}.`, [`Check the path "${font.src}" relative to the project directory.`, 'Remove the entry from project.fonts to use the default font.'], pointer));
        continue;
      }
    } else {
      diagnostics.push(missing(font.family, '(none)', 'neither `src` nor `asset` is set.', [`Add \`src: "fonts/${font.family.replace(/\s+/gu, '')}.ttf"\` to the font entry.`], pointer));
      continue;
    }
    let face: LoadedFontFace;
    try {
      face = faceFrom(bytes, path, font.family, false, font);
    } catch (error: unknown) {
      diagnostics.push(diagnosticOf(error, font.family, path, pointer));
      continue;
    }
    if (font.hash !== undefined && font.hash !== face.hash) {
      diagnostics.push({
        code: 'OV_FONT_HASH_MISMATCH',
        severity: 'error',
        errorClass: 'FontError',
        problem: `Font "${font.family}" has changed: its content hash does not match project.fonts.`,
        pointer: `${pointer}/hash`,
        expected: font.hash,
        received: face.hash,
        suggestions: [`Set hash to "${face.hash}" if the change is intended.`, 'Restore the original font file.'],
      });
    }
    faces.push(face);
  }
  return new FontSet(faces, diagnostics);
}

/**
 * Erzeugt eine FontSet direkt aus Bytes (z. B. im Browser oder in Tests).
 *
 * @example
 * ```ts
 * const set = fontSetFromBytes([{ family: 'Inter', bytes, path: 'Inter.ttf' }]);
 * ```
 */
export function fontSetFromBytes(entries: readonly { readonly family: string; readonly bytes: Uint8Array; readonly path: string; readonly faceIndex?: number }[]): FontSet {
  const faces: LoadedFontFace[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const e of entries) {
    try {
      faces.push(faceFrom(e.bytes, e.path, e.family, false, e.faceIndex !== undefined ? { family: e.family, faceIndex: e.faceIndex } : undefined));
    } catch (error: unknown) {
      diagnostics.push(diagnosticOf(error, e.family, e.path, undefined));
    }
  }
  return new FontSet(faces, diagnostics);
}

/**
 * Wirft den ersten Fehler einer FontSet als {@link OpenVideoError}.
 *
 * @example
 * ```ts
 * const fonts = assertFontSet(await loadFontSet({ fonts: project.fonts }));
 * ```
 */
export function assertFontSet(set: FontSet): FontSet {
  const first = set.diagnostics.find((d) => d.severity === 'error');
  if (first !== undefined) throw new OpenVideoError(first);
  return set;
}
