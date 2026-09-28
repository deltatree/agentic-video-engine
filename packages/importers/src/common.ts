/**
 * Gemeinsame Bausteine aller Importer: Ergebnis-Typen, Diagnosen, IDs, Zahlen, Assets.
 */
import { contentHash, OpenVideoError, type Asset, type AssetType, type Diagnostic } from '@agentic-video/core';

/** Eine Node der IR als JSON-Objekt (wird mit `validateProject` geprüft). */
export type JsonNode = Record<string, unknown>;

/** Ein importiertes Asset: IR-Eintrag plus Bytes, die unter `asset.src` abgelegt werden. */
export interface ImportedAsset {
  readonly asset: Asset;
  readonly bytes: Uint8Array;
}

/** Ergebnis eines Imports, der Nodes erzeugt. */
export interface NodeImportResult {
  readonly nodes: JsonNode[];
  readonly assets: ImportedAsset[];
  readonly diagnostics: Diagnostic[];
}

/** Code jeder Diagnose, die einen Informationsverlust meldet. */
export const LOSSY_CODE = 'OV_IMPORT_LOSSY';

/**
 * Erzeugt eine Verlust-Diagnose (`OV_IMPORT_LOSSY`, Schweregrad `warning`).
 *
 * @example
 * ```ts
 * lossy('svg > filter#blur', 'SVG filters are not supported.', 'Rebuild the effect with `filters` on the node.');
 * ```
 */
export function lossy(path: string, problem: string, suggestion: string, nodeId?: string): Diagnostic {
  return {
    code: LOSSY_CODE,
    severity: 'warning',
    errorClass: 'ImportError',
    problem,
    path,
    ...(nodeId !== undefined ? { nodeId } : {}),
    suggestions: [suggestion],
  };
}

/**
 * Erzeugt einen Importfehler für Eingaben, die gar nicht lesbar sind.
 *
 * @example
 * ```ts
 * throw importError('OV_IMPORT_PARSE', 'The SVG markup has no <svg> root.', 'Pass a complete SVG document.');
 * ```
 */
export function importError(code: string, problem: string, suggestion: string): OpenVideoError {
  return new OpenVideoError({ code, errorClass: 'ImportError', problem, suggestions: [suggestion] });
}

/**
 * Vergibt eindeutige, schema-gültige IDs.
 *
 * @example
 * ```ts
 * const ids = new IdAllocator('logo');
 * ids.next('rect'); // "logo-rect-1"
 * ids.claim('Header Bar'); // "logo-Header_Bar"
 * ```
 */
export class IdAllocator {
  private readonly used = new Set<string>();
  private readonly counters = new Map<string, number>();

  constructor(private readonly prefix: string) {}

  /** Reserviert eine exakte ID (für Wurzel-Nodes); bei Kollision eine neue. */
  exact(id: string, kind: string): string {
    if (this.used.has(id)) return this.next(kind);
    this.used.add(id);
    return id;
  }

  /** Neue ID der Form `<prefix>-<kind>-<n>`. */
  next(kind: string): string {
    let n = this.counters.get(kind) ?? 0;
    let id: string;
    do {
      n += 1;
      id = `${this.prefix}-${kind}-${String(n)}`;
    } while (this.used.has(id));
    this.counters.set(kind, n);
    this.used.add(id);
    return id;
  }

  /** Übernimmt eine Wunsch-ID (bereinigt, mit Präfix); bei Kollision eine neue. */
  claim(wish: string | undefined, kind: string): string {
    if (wish === undefined || wish.length === 0) return this.next(kind);
    const clean = wish.replace(/[^A-Za-z0-9_-]/gu, '_');
    const id = `${this.prefix}-${clean}`;
    if (this.used.has(id)) return this.next(kind);
    this.used.add(id);
    return id;
  }
}

/** Rundet auf 6 Nachkommastellen und entfernt `-0`. */
export function round(n: number, digits = 6): number {
  const f = 10 ** digits;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

/** Formatiert eine Zahl ohne Exponentenschreibweise (für Easing- und Zeit-Texte). */
export function plain(n: number, digits = 6): string {
  const r = round(n, digits);
  const text = String(r);
  if (!/e/iu.test(text)) return text;
  return r.toFixed(digits).replace(/\.?0+$/u, '');
}

/** Sekunden als IR-Zeitwert, z. B. `"1.5s"`. */
export function seconds(s: number): string {
  return `${plain(s)}s`;
}

const MIME_TYPES: Readonly<Record<string, { type: AssetType; ext: string }>> = {
  'image/png': { type: 'image', ext: 'png' },
  'image/jpeg': { type: 'image', ext: 'jpg' },
  'image/jpg': { type: 'image', ext: 'jpg' },
  'image/gif': { type: 'image', ext: 'gif' },
  'image/webp': { type: 'image', ext: 'webp' },
  'image/avif': { type: 'image', ext: 'avif' },
  'image/svg+xml': { type: 'svg', ext: 'svg' },
  'font/woff2': { type: 'font', ext: 'woff2' },
  'font/woff': { type: 'font', ext: 'woff' },
  'font/ttf': { type: 'font', ext: 'ttf' },
  'font/otf': { type: 'font', ext: 'otf' },
  'application/json': { type: 'data', ext: 'json' },
};

/** Eine zerlegte `data:`-URI. */
export interface DataUri {
  readonly mime: string;
  readonly bytes: Uint8Array;
}

/**
 * Zerlegt eine `data:`-URI (Base64 oder Prozent-kodiert).
 *
 * @example
 * ```ts
 * parseDataUri('data:text/plain;base64,SGk='); // { mime: 'text/plain', bytes: Uint8Array [72, 105] }
 * ```
 */
export function parseDataUri(uri: string): DataUri | undefined {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/su.exec(uri.trim());
  if (m === null) return undefined;
  const mime = (m[1] ?? '').toLowerCase() || 'text/plain';
  const params = m[2] ?? '';
  const payload = m[3] ?? '';
  if (/;base64/iu.test(params)) return { mime, bytes: decodeBase64(payload) };
  return { mime, bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Dekodiert Base64 (auch URL-sicher, mit oder ohne Auffüllung). Plattformunabhängig.
 *
 * @example
 * ```ts
 * decodeBase64('SGk='); // Uint8Array [72, 105]
 * ```
 */
export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[\s=]+/gu, '').replace(/-/gu, '+').replace(/_/gu, '/');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let n = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    value = (value << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (value >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}

/** Asset-Typ und Dateiendung zu einem MIME-Typ, falls bekannt. */
export function mimeInfo(mime: string): { type: AssetType; ext: string } | undefined {
  return MIME_TYPES[mime];
}

/**
 * Baut ein Asset aus Bytes: Pfad `assets/<id>.<ext>` und Inhalts-Hash.
 *
 * @example
 * ```ts
 * makeAsset('logo', 'image', 'png', bytes).asset.src; // "assets/logo.png"
 * ```
 */
export function makeAsset(id: string, type: AssetType, ext: string, bytes: Uint8Array, metadata?: Record<string, unknown>): ImportedAsset {
  return {
    asset: { id, type, src: `assets/${id}.${ext}`, hash: contentHash(bytes), ...(metadata !== undefined ? { metadata } : {}) },
    bytes,
  };
}

/** Prüft, ob eine URL auf eine externe Quelle zeigt (http, https, protokoll-relativ). */
export function isExternalUrl(url: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//iu.test(url.trim()) && !/^file:/iu.test(url.trim());
}
