/**
 * Kleine Lesehilfen für JSON-Antworten der Agent API.
 * Alles, was vom Server kommt, ist `unknown`; diese Funktionen prüfen es ohne Casts.
 */
import { isRecord, type Diagnostic } from '@agentic-video/core';

/** Ein JSON-Objekt. */
export type Rec = Record<string, unknown>;

/** Ein Patch für `composition.patch` (Form wie in `@agentic-video/core`). */
export type PatchJson = Readonly<Rec>;

/**
 * Liest eine Zahl oder liefert den Standard.
 *
 * @example
 * ```ts
 * num({ x: 4 }['x'], 0); // 4
 * ```
 */
export function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Liest einen Text oder liefert den Standard.
 *
 * @example
 * ```ts
 * str(undefined, 'x'); // 'x'
 * ```
 */
export function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Liest eine Liste von Objekten (andere Einträge fallen weg).
 *
 * @example
 * ```ts
 * records([{ a: 1 }, 2]); // [{ a: 1 }]
 * ```
 */
export function records(value: unknown): Rec[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/**
 * Liest ein Objekt oder liefert ein leeres.
 *
 * @example
 * ```ts
 * rec(null); // {}
 * ```
 */
export function rec(value: unknown): Rec {
  return isRecord(value) ? value : {};
}

/**
 * Macht aus einer Server-Antwort eine Diagnose.
 *
 * @example
 * ```ts
 * toDiagnostic({ code: 'OV_X', problem: 'Broken.' }).severity; // 'error'
 * ```
 */
export function toDiagnostic(value: unknown): Diagnostic {
  const d = rec(value);
  const severity = d['severity'] === 'warning' || d['severity'] === 'info' ? d['severity'] : 'error';
  const suggestions = Array.isArray(d['suggestions']) ? d['suggestions'].map(String) : [];
  return {
    code: str(d['code'], 'OV_UNKNOWN'),
    severity,
    errorClass: str(d['errorClass'], 'ApiError'),
    problem: str(d['problem'], 'Unknown problem.'),
    suggestions,
    ...(typeof d['path'] === 'string' ? { path: d['path'] } : {}),
    ...(typeof d['pointer'] === 'string' ? { pointer: d['pointer'] } : {}),
    ...(typeof d['nodeId'] === 'string' ? { nodeId: d['nodeId'] } : {}),
    ...(typeof d['frame'] === 'number' ? { frame: d['frame'] } : {}),
    ...(typeof d['compositionId'] === 'string' ? { compositionId: d['compositionId'] } : {}),
  };
}

/**
 * Liest eine Liste von Diagnosen.
 *
 * @example
 * ```ts
 * toDiagnostics([{ code: 'OV_X', problem: 'p' }]).length; // 1
 * ```
 */
export function toDiagnostics(value: unknown): Diagnostic[] {
  return Array.isArray(value) ? value.map(toDiagnostic) : [];
}
