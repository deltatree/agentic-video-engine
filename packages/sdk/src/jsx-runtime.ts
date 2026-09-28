/**
 * JSX-Runtime (`jsx: 'automatic'`, `jsxImportSource: '@agentic-video/sdk'`).
 * JSX ist nur Syntax: Jede Element-Komponente liefert ein Datenobjekt.
 */
import type { Child, ElementFactory, SdkElement } from './element.js';

export { Fragment } from './components.js';

/**
 * Erzeugt ein Element aus einer Element-Komponente. Der Schlüssel (`key`) hat keine Bedeutung.
 *
 * @example
 * ```ts
 * jsx(Rect, { width: 100, height: 50 });
 * ```
 */
export function jsx<P>(type: ElementFactory<P>, props: P, _key?: string): SdkElement {
  return type(props);
}

/**
 * Wie {@link jsx}, für statische Kinderlisten.
 *
 * @example
 * ```ts
 * jsxs(Group, { children: [jsx(Rect, { width: 1, height: 1 })] });
 * ```
 */
export function jsxs<P>(type: ElementFactory<P>, props: P, _key?: string): SdkElement {
  return type(props);
}

/** Typen für TypeScript-Prüfung von TSX-Dateien. */
// eslint-disable-next-line @typescript-eslint/no-namespace -- TypeScript sucht JSX-Typen in einem Namespace `JSX`.
export declare namespace JSX {
  type Element = SdkElement;
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Es gibt keine eingebauten Tags; nur Element-Komponenten.
  interface IntrinsicElements {}
  interface ElementChildrenAttribute {
    children: Child;
  }
}
