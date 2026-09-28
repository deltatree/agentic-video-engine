/**
 * JSX-Entwicklungs-Runtime (`jsxDev: true`). Speichert die Quellposition jedes
 * Elements; `toIR` legt sie in `meta.source` der Node ab.
 */
import type { ElementFactory, SdkElement } from './element.js';

export { Fragment } from './components.js';
export type { JSX } from './jsx-runtime.js';

/** Quellangabe, die Compiler an `jsxDEV` übergeben. */
export interface JsxDevSource {
  readonly fileName?: string;
  readonly lineNumber?: number;
  readonly columnNumber?: number;
}

/**
 * Erzeugt ein Element und merkt sich die Quellposition.
 * Liefert eine eigene Komponente bereits ein Element mit Quelle, bleibt diese erhalten.
 *
 * @example
 * ```ts
 * jsxDEV(Text, { text: 'Hi' }, undefined, false, { fileName: 'video.tsx', lineNumber: 3, columnNumber: 5 });
 * ```
 */
export function jsxDEV<P>(type: ElementFactory<P>, props: P, _key?: string, _isStaticChildren?: boolean, source?: JsxDevSource, _self?: unknown): SdkElement {
  const element = type(props);
  if (source === undefined || element.source !== undefined || source.fileName === undefined) return element;
  return { ...element, source: { file: source.fileName, line: source.lineNumber ?? 0, column: source.columnNumber ?? 0 } };
}
