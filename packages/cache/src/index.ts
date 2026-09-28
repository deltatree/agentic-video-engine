/**
 * @packageDocumentation
 * Inhaltsadressierter Speicher und Cache-Ebenen (AD-7, FR-50, FR-68).
 *
 * Schlüssel sind Inhalts-Hashes (`sha256:<hex>`) oder daraus abgeleitete Texte.
 * Speicher: Dateisystem (lokal), S3-kompatibel (Cluster), Arbeitsspeicher (Tests),
 * gestuft (lokal vor entfernt).
 *
 * @example
 * ```ts
 * import { createCache, FileStore } from '@agentic-video/cache';
 * const cache = createCache(new FileStore('.openvideo/cache'));
 * await cache.tier('frame').put(key, bytes);
 * ```
 */
export * from './store.js';
export * from './s3.js';
export * from './cache.js';
