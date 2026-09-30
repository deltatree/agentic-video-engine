/**
 * `openvideo cache clear`: genutzte Ebenen und alte Ebenen-Verzeichnisse (ADR 0021, Politur P1).
 */
import { CACHE_TIERS, TieredStore, type Cache, type CacheTierName, type ContentStore } from '@agentic-video/cache';

/**
 * Frühere Cache-Ebenen, die OpenVideo nicht mehr schreibt (ADR 0021): Fonts liegen in `asset`,
 * Geometrie und Shader im Browser-Prozess, `composition` wurde nie genutzt.
 */
export const LEGACY_CACHE_TIERS = ['font', 'geometry', 'shader', 'composition'] as const;
export type LegacyCacheTierName = (typeof LEGACY_CACHE_TIERS)[number];

/** Ergebnis von {@link clearCache}. */
export interface ClearCacheResult {
  /** Gelöschte Einträge insgesamt. */
  readonly removed: number;
  /** Davon aus alten Ebenen ({@link LEGACY_CACHE_TIERS}). */
  readonly legacyRemoved: number;
}

/**
 * Ebene aus `--tier`: genutzte oder alte Ebene, sonst `undefined`.
 *
 * @example
 * ```ts
 * cacheTierByName('frame'); // 'frame'
 * cacheTierByName('shader'); // 'shader' (alte Ebene, nur für clear)
 * ```
 */
export function cacheTierByName(name: string): CacheTierName | LegacyCacheTierName | undefined {
  return CACHE_TIERS.find((t) => t === name) ?? LEGACY_CACHE_TIERS.find((t) => t === name);
}

/**
 * Löscht eine Ebene oder alles. Ohne `tier` auch die alten Ebenen-Verzeichnisse `font/`,
 * `geometry/`, `shader/` und `composition/`. Wie `Cache.clear` nur die lokale Stufe eines
 * gestuften Speichers, außer er löscht ausdrücklich auch entfernt (`deleteRemote`).
 *
 * @example
 * ```ts
 * const { removed, legacyRemoved } = await clearCache(cache); // alles, auch alte Ebenen
 * await clearCache(cache, 'shader'); // nur die alte Ebene shader
 * ```
 */
export async function clearCache(cache: Cache, tier?: CacheTierName | LegacyCacheTierName): Promise<ClearCacheResult> {
  const legacy = LEGACY_CACHE_TIERS.find((t) => t === tier);
  const current = CACHE_TIERS.find((t) => t === tier);
  const removedCurrent = legacy !== undefined ? 0 : await cache.clear(current);
  const housekeeping: ContentStore = cache.store instanceof TieredStore && !cache.store.deletesRemote ? cache.store.local : cache.store;
  let legacyRemoved = 0;
  for (const t of tier === undefined ? LEGACY_CACHE_TIERS : legacy !== undefined ? [legacy] : []) {
    for (const e of await housekeeping.list(`${t}/`)) {
      await housekeeping.delete(e.key);
      legacyRemoved++;
    }
  }
  return { removed: removedCurrent + legacyRemoved, legacyRemoved };
}
