/**
 * Validierende Type Guards: ersetzen ungeprüfte Casts (NFR-2).
 */
import { validateValue } from '@agentic-video/schema';
import type { Static, TSchema } from 'typebox';

const cache = new WeakMap<object, WeakMap<object, boolean>>();

/**
 * Prüft einen Wert gegen ein Schema. Ergebnisse für Objekte werden je Schema zwischengespeichert,
 * denn IR-Objekte ändern sich während einer Auswertung nicht.
 *
 * @example
 * ```ts
 * if (conforms(Timing, raw.timing)) computeLocalTime(raw.timing, frame, ctx);
 * ```
 */
export function conforms<S extends TSchema>(schema: S, value: unknown): value is Static<S> {
  if (typeof value !== 'object' || value === null) return validateValue(schema, value).length === 0;
  let perSchema = cache.get(schema);
  if (perSchema === undefined) {
    perSchema = new WeakMap();
    cache.set(schema, perSchema);
  }
  const hit = perSchema.get(value);
  if (hit !== undefined) return hit;
  const ok = validateValue(schema, value).length === 0;
  perSchema.set(value, ok);
  return ok;
}

/** Prüft, ob ein Wert ein einfaches Objekt ist. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
