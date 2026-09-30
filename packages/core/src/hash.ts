/**
 * Inhalts-Hashes (AD-7): SHA-256 über kanonisches JSON oder Bytes.
 * Plattformunabhängig (Node und Browser), synchron.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { OpenVideoError } from '@agentic-video/schema';

/**
 * Serialisiert einen Wert als kanonisches JSON: Objektschlüssel sortiert, keine Leerzeichen.
 * `undefined` in Objekten wird ausgelassen, in Arrays wird es zu `null` (wie JSON.stringify).
 * Nicht-endliche Zahlen (`OV_HASH_NON_FINITE`) und Funktionen, Symbole, BigInt
 * (`OV_HASH_UNSUPPORTED`) ergeben einen {@link OpenVideoError}.
 *
 * @example
 * ```ts
 * canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }); // '{"a":[2,{"c":4,"d":3}],"b":1}'
 * ```
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    // Erreichbar über berechnete Werte (Ausdrücke, Plugins, TSX): strukturierter Fehler statt TypeError.
    if (!Number.isFinite(value)) {
      throw new OpenVideoError({
        code: 'OV_HASH_NON_FINITE',
        errorClass: 'ValidationError',
        problem: `Cannot hash the non-finite number ${String(value)}; cache keys and content hashes need finite numbers.`,
        received: String(value),
        expected: 'a finite number',
        suggestions: ['Check expressions and computed values for division by zero or overflow (NaN, Infinity).', 'Clamp or replace the value before it reaches the project, e.g. Number.isFinite(v) ? v : 0.'],
      });
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map((v: unknown) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (value instanceof Uint8Array) return JSON.stringify(`bytes:${sha256Hex(value)}`);
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  // Funktionen, Symbole und BigInt kommen z. B. aus Plugins oder TSX-Props; sie sind keine Daten.
  throw new OpenVideoError({
    code: 'OV_HASH_UNSUPPORTED',
    errorClass: 'ValidationError',
    problem: `Cannot hash a value of type ${typeof value}; only JSON data and bytes can be hashed.`,
    received: typeof value,
    expected: 'null, boolean, number, string, array, object or Uint8Array',
    suggestions: ['Pass plain JSON data (no functions, symbols or bigint values) in props, plugin results and cache inputs.', typeof value === 'bigint' ? 'Convert the bigint to a number or string first.' : 'Replace the value with data that describes it, e.g. a name or an id.'],
  });
}

/** SHA-256 als Hex-Text. */
export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data));
}

/**
 * Inhalts-Hash der Form `sha256:<64 hex>`.
 *
 * @example
 * ```ts
 * contentHash({ a: 1 }) === contentHash({ a: 1 }); // true
 * contentHash(new Uint8Array([1, 2, 3]));
 * ```
 */
export function contentHash(value: unknown): string {
  return `sha256:${value instanceof Uint8Array ? sha256Hex(value) : sha256Hex(canonicalJson(value))}`;
}
