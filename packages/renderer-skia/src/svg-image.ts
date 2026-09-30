/**
 * `<image>` in SVG (Story 17.6): Bildquellen auflösen, vorab dekodieren und prüfen.
 *
 * Erlaubte Quellen:
 * - `data:`-URIs mit Rasterbildern (`image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/bmp`),
 *   Base64 oder URL-kodiert.
 * - `asset:<id>`: ein Bild-Asset des Projects.
 * - Relative Pfade: aufgelöst gegen den Ordner der SVG-Datei (bei Inline-Markup gegen die
 *   Project-Wurzel). Sie müssen innerhalb des Projects bleiben und auf ein registriertes
 *   Bild-Asset zeigen (gleicher `src`). Es wird nie direkt vom Dateisystem oder Netz gelesen.
 *
 * Alles andere (absolute Pfade, `..` über die Wurzel, `http:`, `file:`, SVG-in-SVG) wird nicht
 * geladen und als `OV_SVG_IMAGE_BLOCKED` gemeldet.
 */
import type { CanvasKit, Image } from 'canvaskit-wasm';
import type { AssetRecord, AssetResolver, Diagnostic } from '@agentic-video/core';
import { nullable } from './scope.js';
import type { SvgDocument, SvgElement } from './svg.js';

/** Aufgelöste Quelle eines `<image>`. */
export type SvgImageSource =
  | { readonly kind: 'data'; readonly bytes: Uint8Array }
  | { readonly kind: 'asset'; readonly id: string }
  | { readonly kind: 'blocked'; readonly reason: string }
  /** Asset-Verweis, der ohne Asset-Liste nicht geprüft werden kann. */
  | { readonly kind: 'unverified' };

const RASTER_MIME: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/bmp']);

/** Normalisiert einen relativen POSIX-Pfad; `undefined`, wenn er über die Wurzel hinausgeht. */
function normalizePath(path: string): string | undefined {
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

function decodeDataUri(href: string): SvgImageSource {
  const comma = href.indexOf(',');
  if (comma < 0) return { kind: 'blocked', reason: 'The data URI has no data.' };
  const meta = href.slice(5, comma).split(';').map((p) => p.trim().toLowerCase());
  const mime = meta[0] ?? '';
  if (!RASTER_MIME.has(mime)) return { kind: 'blocked', reason: `Data URIs of type "${mime || 'text/plain'}" are not supported; use PNG, JPEG, WebP, GIF or BMP.` };
  const payload = href.slice(comma + 1);
  try {
    if (meta.includes('base64')) {
      const binary = atob(payload.replace(/\s+/gu, ''));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return { kind: 'data', bytes };
    }
    const text = decodeURIComponent(payload);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    return { kind: 'data', bytes };
  } catch (error: unknown) {
    return { kind: 'blocked', reason: `The data URI cannot be decoded: ${error instanceof Error ? error.message : String(error)}.` };
  }
}

/**
 * Löst die Quelle eines `<image>` auf, ohne sie zu laden.
 *
 * @param baseDir Ordner der SVG-Datei relativ zur Project-Wurzel (`''` für Inline-Markup).
 * @param assets Assets des Projects (für `asset:` und relative Pfade). Ohne sie bleiben solche
 *   Verweise ungeprüft (`unverified`).
 *
 * @example
 * ```ts
 * resolveSvgImageHref('../img/logo.png', 'assets/icons', assets); // { kind: 'asset', id: 'logo' }
 * ```
 */
export function resolveSvgImageHref(href: string, baseDir: string, assets: Pick<AssetResolver, 'all' | 'get'> | undefined): SvgImageSource {
  const h = href.trim();
  if (h.startsWith('data:')) return decodeDataUri(h);
  const isImage = (r: AssetRecord): boolean => r.type === 'image';
  if (h.startsWith('asset:')) {
    const id = h.slice('asset:'.length);
    if (assets === undefined) return { kind: 'unverified' };
    const rec = assets.get(id);
    if (rec === undefined) return { kind: 'blocked', reason: `Asset "${id}" is not part of the project.` };
    if (!isImage(rec)) return { kind: 'blocked', reason: `Asset "${id}" is a ${rec.type}, not a raster image.` };
    return { kind: 'asset', id };
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(h)) return { kind: 'blocked', reason: `"${h.slice(0, 40)}" is a URL; SVG images must be data URIs or project assets.` };
  if (h.startsWith('/') || h.startsWith('\\')) return { kind: 'blocked', reason: `"${h}" is an absolute path; use a path relative to the SVG inside the project.` };
  const path = normalizePath(`${baseDir}/${h.split(/[?#]/u)[0] ?? ''}`);
  if (path === undefined) return { kind: 'blocked', reason: `"${h}" points outside the project.` };
  if (assets === undefined) return { kind: 'unverified' };
  const rec = assets.all().find((a) => normalizePath(a.src) === path);
  if (rec === undefined) return { kind: 'blocked', reason: `"${h}" (${path}) is not a registered project asset.` };
  if (!isImage(rec)) return { kind: 'blocked', reason: `"${h}" is a ${rec.type} asset, not a raster image.` };
  return { kind: 'asset', id: rec.id };
}

/** Alle `href`s von `<image>`-Elementen (ohne Duplikate). */
function imageHrefs(doc: SvgDocument): string[] {
  const out = new Set<string>();
  const visit = (el: SvgElement): void => {
    if (el.name === 'image') {
      const href = el.attrs['href'] ?? el.attrs['xlink:href'];
      if (href !== undefined) out.add(href);
    }
    for (const c of el.children) visit(c);
  };
  visit(doc.root);
  return [...out];
}

/**
 * Prüft die Bilder eines SVG-Dokuments und meldet nicht ladbare Quellen als Warnung.
 *
 * @example
 * ```ts
 * const warnings = checkSvgImages(parseSvg(markup), '', assets);
 * ```
 */
export function checkSvgImages(doc: SvgDocument, baseDir: string, assets: Pick<AssetResolver, 'all' | 'get'> | undefined): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const href of imageHrefs(doc)) {
    const source = resolveSvgImageHref(href, baseDir, assets);
    if (source.kind !== 'blocked') continue;
    out.push({
      code: 'OV_SVG_IMAGE_BLOCKED',
      severity: 'warning',
      errorClass: 'SkiaRendererError',
      problem: `An SVG <image> is skipped: ${source.reason}`,
      received: JSON.stringify(href.length > 80 ? `${href.slice(0, 80)}…` : href),
      suggestions: ['Embed the image as a data URI (PNG, JPEG, WebP).', 'Import the image as a project asset and reference it as asset:<id> or by its path relative to the SVG.'],
    });
  }
  return out;
}

const LOADED = new WeakMap<SvgDocument, Map<string, Image>>();

/**
 * Lädt und dekodiert alle Bilder eines SVG-Dokuments (einmal je Dokument). Nicht ladbare Quellen
 * werden übersprungen (siehe {@link checkSvgImages}).
 *
 * @example
 * ```ts
 * await loadSvgImages(ck, doc, request.assets, 'assets/icons');
 * ```
 */
export async function loadSvgImages(ck: CanvasKit, doc: SvgDocument, assets: AssetResolver, baseDir: string): Promise<void> {
  if (LOADED.has(doc)) return;
  const images = new Map<string, Image>();
  for (const href of imageHrefs(doc)) {
    const source = resolveSvgImageHref(href, baseDir, assets);
    if (source.kind === 'blocked' || source.kind === 'unverified') continue;
    const bytes = source.kind === 'data' ? source.bytes : await assets.bytes(source.id);
    const image = nullable(ck.MakeImageFromEncoded(bytes));
    if (image !== null) images.set(href, image);
  }
  LOADED.set(doc, images);
}

/**
 * Dekodierte Bilder eines Dokuments nach `href` (leer, wenn nicht geladen).
 *
 * @example
 * ```ts
 * svgImagesOf(doc).get('data:image/png;base64,…');
 * ```
 */
export function svgImagesOf(doc: SvgDocument): ReadonlyMap<string, Image> {
  return LOADED.get(doc) ?? new Map<string, Image>();
}

/**
 * Gibt die dekodierten Bilder eines Dokuments frei.
 *
 * @example
 * ```ts
 * disposeSvgImages(doc);
 * ```
 */
export function disposeSvgImages(doc: SvgDocument): void {
  const images = LOADED.get(doc);
  if (images === undefined) return;
  for (const image of images.values()) image.delete();
  LOADED.delete(doc);
}

/**
 * Vollständige Prüfung eines SVG-Dokuments: nicht unterstützte Elemente (`OV_SVG_UNSUPPORTED`)
 * und nicht ladbare Bilder (`OV_SVG_IMAGE_BLOCKED`), beides als Warnung. Gilt für Inline-Markup
 * und für SVG-Assets.
 *
 * @example
 * ```ts
 * const diagnostics = checkSvgDocument(parseSvg(markup), '', assets);
 * ```
 */
export function checkSvgDocument(doc: SvgDocument, baseDir: string, assets: Pick<AssetResolver, 'all' | 'get'> | undefined): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (doc.unsupported.length > 0) {
    out.push({
      code: 'OV_SVG_UNSUPPORTED',
      severity: 'warning',
      errorClass: 'SkiaRendererError',
      problem: `SVG elements are not supported and are skipped: ${doc.unsupported.join(', ')}.`,
      details: { elements: doc.unsupported.join(',') },
      suggestions: ['Convert these elements to paths, e.g. with `svgo --config` or by flattening in the design tool.', 'Render the SVG as an image asset instead.'],
    });
  }
  out.push(...checkSvgImages(doc, baseDir, assets));
  return out;
}
