/**
 * Strukturierte Fehler und Diagnosen (AD-10).
 *
 * Jede Meldung ist für Menschen und Agents lesbar: Sie nennt Problem,
 * Ort (Node, Frame, Pfad) und konkrete Lösungsvorschläge.
 */

/** Schweregrad einer Diagnose. */
export type Severity = 'error' | 'warning' | 'info';

/**
 * Eine strukturierte Meldung zu einer Composition, einem Frame oder einem Renderer.
 *
 * @example
 * ```ts
 * const d: Diagnostic = {
 *   code: 'OV_SCHEMA_TYPE',
 *   severity: 'error',
 *   errorClass: 'ValidationError',
 *   problem: 'Expected number >= 0',
 *   path: 'composition.hero.nodes.logo.scale.x',
 *   received: '"large"',
 *   suggestions: ['scale: { x: 1.2, y: 1.2 }'],
 * };
 * ```
 */
export interface Diagnostic {
  /** Stabiler Code der Form `OV_<BEREICH>_<NAME>`. */
  readonly code: string;
  readonly severity: Severity;
  /** Fehlerklasse, z. B. `ValidationError` oder `ThreeRendererError`. */
  readonly errorClass: string;
  /** Kurze Beschreibung des Problems in einem Satz. */
  readonly problem: string;
  /** Lesbarer Pfad, z. B. `composition.hero.nodes.logo.scale.x`. */
  readonly path?: string;
  /** JSON Pointer in die IR, z. B. `/compositions/0/nodes/1/scale/x`. */
  readonly pointer?: string;
  readonly nodeId?: string;
  readonly compositionId?: string;
  readonly frame?: number;
  /** Erwarteter Wert oder Typ. */
  readonly expected?: string;
  /** Erhaltener Wert, als JSON-Text. */
  readonly received?: string;
  /** Zusätzliche Fakten, z. B. Asset-Maße und GPU-Grenzen. */
  readonly details?: Readonly<Record<string, string | number | boolean>>;
  /** Konkrete, nummerierbare Lösungsvorschläge. */
  readonly suggestions: readonly string[];
}

/** Optionen zum Erzeugen eines {@link OpenVideoError}. */
export type OpenVideoErrorInit = Omit<Diagnostic, 'severity'> & { readonly severity?: Severity; readonly cause?: unknown };

/**
 * Ausnahme mit Diagnose-Inhalt. Alle Pakete werfen nur diese Fehlerart.
 *
 * @example
 * ```ts
 * throw new OpenVideoError({
 *   code: 'OV_ASSET_MISSING',
 *   errorClass: 'AssetError',
 *   problem: 'Asset file not found.',
 *   details: { asset: 'logo.svg' },
 *   suggestions: ['Import the file with `openvideo assets import logo.svg`.'],
 * });
 * ```
 */
export class OpenVideoError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(init: OpenVideoErrorInit) {
    const { cause, severity, ...rest } = init;
    super(`${init.errorClass}: ${init.problem}`, cause === undefined ? undefined : { cause });
    this.name = init.errorClass;
    this.diagnostic = { ...rest, severity: severity ?? 'error' };
  }

  /** Gibt die Diagnose als JSON-fähiges Objekt zurück. */
  toJSON(): Diagnostic {
    return this.diagnostic;
  }
}

/** Prüft, ob ein unbekannter Wert ein {@link OpenVideoError} ist. */
export function isOpenVideoError(value: unknown): value is OpenVideoError {
  return value instanceof OpenVideoError;
}

/**
 * Formatiert eine Diagnose als Textblock (Format aus Auftrag A40).
 *
 * @example
 * ```ts
 * console.log(formatDiagnostic(error.diagnostic));
 * // ThreeRendererError
 * //
 * // Node:
 * // product-model
 * // ...
 * ```
 */
export function formatDiagnostic(d: Diagnostic): string {
  const blocks: string[] = [];
  if (d.path !== undefined && d.errorClass === 'ValidationError') {
    blocks.push(d.path);
    const lines = [d.expected !== undefined ? `Expected ${d.expected}` : d.problem];
    if (d.received !== undefined) lines.push(`Received: ${d.received}`);
    blocks.push(lines.join('\n'));
  } else {
    blocks.push(d.errorClass);
    if (d.nodeId !== undefined) blocks.push(`Node:\n${d.nodeId}`);
    if (d.frame !== undefined) blocks.push(`Frame:\n${String(d.frame)}`);
    if (d.path !== undefined) blocks.push(`Path:\n${d.path}`);
    blocks.push(`Problem:\n${d.problem}`);
    if (d.received !== undefined) blocks.push(`Received:\n${d.received}`);
    if (d.details !== undefined) {
      for (const [key, value] of Object.entries(d.details)) {
        blocks.push(`${key}:\n${String(value)}`);
      }
    }
  }
  if (d.suggestions.length === 1) {
    blocks.push(`Suggested fix:\n${d.suggestions[0] ?? ''}`);
  } else if (d.suggestions.length > 1) {
    blocks.push(`Suggested actions:\n${d.suggestions.map((s, i) => `${String(i + 1)}. ${s}`).join('\n')}`);
  }
  return blocks.join('\n\n');
}

/** Zählt Diagnosen mit Schweregrad `error`. */
export function countErrors(diagnostics: readonly Diagnostic[]): number {
  return diagnostics.filter((d) => d.severity === 'error').length;
}
