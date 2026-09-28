/**
 * JSX-Elemente als reine Daten (FR-17).
 *
 * Ein Element ist `{ type, props, source? }`. Es gibt keinen Lebenszyklus,
 * keinen Zustand und kein React. `toIR` übersetzt Elemente in Nodes der IR.
 */
import { isRecord } from '@agentic-video/core';

/** Quellposition eines Elements in der TSX-Datei (aus `jsxDEV`). */
export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/** Ein JSX-Element: Name der Element-Komponente, Props und optionale Quellposition. */
export interface SdkElement {
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly source?: SourceLocation;
}

/** Erlaubte Kinder in JSX: Elemente, Listen davon und leere Werte aus Bedingungen. */
export type Child = SdkElement | readonly Child[] | null | undefined | boolean;

/** Eine Element-Komponente: Funktion von Props auf ein Element. */
export type ElementFactory<P> = (props: P) => SdkElement;

/**
 * Prüft, ob ein Wert ein SDK-Element ist.
 *
 * @example
 * ```ts
 * isElement(Rect({ width: 10, height: 10 })); // true
 * ```
 */
export function isElement(value: unknown): value is SdkElement {
  return isRecord(value) && typeof value['type'] === 'string' && isRecord(value['props']) && Object.keys(value).every((k) => k === 'type' || k === 'props' || k === 'source');
}

/**
 * Kopiert die eigenen Felder eines Objekts in einen einfachen Datensatz.
 *
 * @example
 * ```ts
 * toRecord({ a: 1 }); // { a: 1 }
 * ```
 */
export function toRecord(value: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const v: unknown = Reflect.get(value, key);
    out[key] = v;
  }
  return out;
}

/**
 * Erzeugt ein Element.
 *
 * @example
 * ```ts
 * createElement('Rect', { width: 100, height: 50 });
 * ```
 */
export function createElement(type: string, props: object, source?: SourceLocation): SdkElement {
  return source === undefined ? { type, props: toRecord(props) } : { type, props: toRecord(props), source };
}

/**
 * Macht aus verschachtelten Kindern eine flache Liste. `null`, `undefined` und
 * Wahrheitswerte (aus `cond && <X/>`) fallen weg.
 *
 * @example
 * ```ts
 * flattenChildren([a, [b, null], false]); // [a, b]
 * ```
 */
export function flattenChildren(children: unknown): unknown[] {
  if (children === null || children === undefined || typeof children === 'boolean') return [];
  if (Array.isArray(children)) return children.flatMap((c: unknown) => flattenChildren(c));
  return [children];
}
