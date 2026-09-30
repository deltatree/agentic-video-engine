/**
 * Speicherschlüssel für Remote-Jobs (Story 16.2, Entscheidung T8, ADR 0023).
 *
 * - `inputs/sha256-<hex>`: Projekt-IR und Projektdateien, inhaltsadressiert. Worker dürfen sie nur lesen.
 * - `jobs/<jobId>/frames/<hex>`: fertige Frames eines Jobs. Nur hier dürfen Worker schreiben.
 *
 * Jeder Schlüssel trägt den SHA-256 seines Inhalts; Leser prüfen ihn, bevor sie Bytes übernehmen.
 */
import { createHash } from 'node:crypto';
import { OpenVideoError } from '@agentic-video/core';

/**
 * SHA-256 (hex) über `node:crypto` (Story 18.5): gleiche Werte wie `sha256Hex` aus core, aber
 * nativ. Frames im Stream-/Remote-Betrieb sind mehrere MB groß; die JS-Fassung wäre der Engpass.
 *
 * @example
 * ```ts
 * digestHex(new TextEncoder().encode('abc')); // 'ba7816bf…'
 * ```
 */
export function digestHex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const HEX = /^[0-9a-f]{64}$/u;
const JOB_ID = /^[A-Za-z0-9-]{1,64}$/u;

/**
 * Schlüssel einer Eingabedatei (Projekt-IR, Asset) im gemeinsamen Speicher.
 *
 * @example
 * ```ts
 * inputKey(digestHex(bytes)); // 'inputs/sha256-…'
 * ```
 */
export function inputKey(hex: string): string {
  return `inputs/sha256-${hex}`;
}

/**
 * Präfix, unter dem Worker die Frames eines Jobs ablegen.
 *
 * @example
 * ```ts
 * jobFramePrefix('0b6c…'); // 'jobs/0b6c…/frames/'
 * ```
 */
export function jobFramePrefix(jobId: string): string {
  return `jobs/${jobId}/frames/`;
}

/**
 * Schlüssel eines Frames eines Jobs: Präfix des Jobs und SHA-256 der gespeicherten Bytes.
 *
 * @example
 * ```ts
 * jobFrameKey(jobId, digestHex(bytes)); // 'jobs/<jobId>/frames/<hex>'
 * ```
 */
export function jobFrameKey(jobId: string, hex: string): string {
  return `${jobFramePrefix(jobId)}${hex}`;
}

/**
 * Prüft eine Job-ID (UUID des Koordinators); nur solche IDs dürfen in Schlüssel.
 *
 * @example
 * ```ts
 * isJobId('7f0c3f1e-8a0e-4c52-9d8e-2b1f0f7f2a10'); // true
 * ```
 */
export function isJobId(value: string): boolean {
  return JOB_ID.test(value);
}

/**
 * Liefert den SHA-256 (hex) eines Frame-Schlüssels, wenn er genau zum Job gehört, sonst `undefined`.
 *
 * @example
 * ```ts
 * jobFrameDigest('job-1', 'jobs/job-1/frames/ab…'); // 'ab…'
 * jobFrameDigest('job-1', 'jobs/job-2/frames/ab…'); // undefined
 * ```
 */
export function jobFrameDigest(jobId: string, key: string): string | undefined {
  const prefix = jobFramePrefix(jobId);
  if (!key.startsWith(prefix)) return undefined;
  const hex = key.slice(prefix.length);
  return HEX.test(hex) ? hex : undefined;
}

/**
 * Liefert den SHA-256 (hex), den ein inhaltsadressierter Schlüssel trägt (`…sha256-<hex>` oder
 * `…sha256:<hex>`), sonst `undefined`.
 *
 * @example
 * ```ts
 * keyDigest('inputs/sha256-ab…'); // 'ab…'
 * ```
 */
export function keyDigest(key: string): string | undefined {
  const match = /sha256[-:]([0-9a-f]{64})$/u.exec(key);
  return match?.[1];
}

/**
 * Prüft, ob Bytes zum SHA-256 in ihrem Schlüssel passen, und wirft sonst `OV_SCHEDULER_CONTENT_MISMATCH`.
 *
 * @example
 * ```ts
 * assertContentMatches('inputs/sha256-ab…', bytes, 'WorkerError');
 * ```
 */
export function assertContentMatches(key: string, bytes: Uint8Array, errorClass: string): void {
  const want = keyDigest(key) ?? /([0-9a-f]{64})$/u.exec(key)?.[1];
  if (want === undefined || digestHex(bytes) !== want) {
    throw new OpenVideoError({
      code: 'OV_SCHEDULER_CONTENT_MISMATCH',
      errorClass,
      problem: `The content of "${key}" does not match the hash in its key; it was changed or replaced in the shared store.`,
      suggestions: ['Check who can write to the shared store (separate S3 identities for API and workers, ADR 0023).', 'Render again; the job keeps no tampered data.'],
    });
  }
}
