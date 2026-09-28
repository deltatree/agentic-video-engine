/**
 * JSON-Export (FR-17a): Jede TSX-Composition ist als JSON ohne Code darstellbar.
 */
import { OpenVideoError, isRecord, type IrProject } from '@agentic-video/core';

function notJson(path: string, what: string): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_EXPORT_NOT_JSON',
    errorClass: 'ExportError',
    problem: `${path} is ${what}; the exported JSON would lose it.`,
    path,
    suggestions: ['Compile the TSX with compileTsx() first; its IR contains only data.'],
  });
}

function check(value: unknown, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw notJson(path, String(value));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v: unknown, i) => {
      check(v, `${path}[${String(i)}]`);
    });
    return;
  }
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) check(v, `${path}.${k}`);
    return;
  }
  throw notJson(path, `a ${typeof value}`);
}

/**
 * Serialisiert ein IR-Project als formatiertes JSON (2 Leerzeichen, Zeilenende am Schluss).
 * Funktionen, `undefined` und nicht endliche Zahlen sind ein Fehler statt still zu verschwinden.
 *
 * @example
 * ```ts
 * await writeFile('video.json', exportJson(project));
 * ```
 */
export function exportJson(project: IrProject): string {
  check(project, 'project');
  return `${JSON.stringify(project, null, 2)}\n`;
}
