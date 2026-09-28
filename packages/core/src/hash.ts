/**
 * Inhalts-Hashes (AD-7): SHA-256 über kanonisches JSON oder Bytes.
 * Plattformunabhängig (Node und Browser), synchron.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * Serialisiert einen Wert als kanonisches JSON: Objektschlüssel sortiert, keine Leerzeichen.
 * `undefined` in Objekten wird ausgelassen, in Arrays wird es zu `null` (wie JSON.stringify).
 *
 * @example
 * ```ts
 * canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }); // '{"a":[2,{"c":4,"d":3}],"b":1}'
 * ```
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Cannot hash non-finite number ${String(value)}`);
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
  throw new TypeError(`Cannot hash value of type ${typeof value}`);
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
