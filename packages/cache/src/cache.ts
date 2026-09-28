/**
 * Cache-Ebenen mit Statistik (A23, FR-68).
 */
import { OpenVideoError } from '@agentic-video/core';
import { FileStore, TieredStore, type ContentStore, type StoreEntry } from './store.js';
import { S3Store } from './s3.js';

/** Die Cache-Ebenen aus Auftrag A23. */
export const CACHE_TIERS = ['asset', 'font', 'composition', 'frame', 'layer', 'geometry', 'shader', 'audio', 'encoding'] as const;
export type CacheTierName = (typeof CACHE_TIERS)[number];

/** Zähler einer Cache-Ebene. */
export interface TierStats {
  hits: number;
  misses: number;
  writes: number;
  bytesRead: number;
  bytesWritten: number;
}

/** Zugriff auf eine Ebene. Schlüssel sind Inhalts-Hashes. */
export interface CacheTier {
  readonly name: CacheTierName;
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  has(key: string): Promise<boolean>;
  /** Liefert den Wert aus dem Cache oder berechnet und speichert ihn. */
  getOrCreate(key: string, create: () => Promise<Uint8Array>): Promise<Uint8Array>;
  /** Lokaler Pfad eines gespeicherten Eintrags, falls vorhanden. */
  localPath(key: string): string | undefined;
}

/** Ein Cache mit allen Ebenen über einem Speicher. */
export interface Cache {
  readonly store: ContentStore;
  tier(name: CacheTierName): CacheTier;
  /** Momentaufnahme aller Zähler. */
  stats(): Record<CacheTierName, TierStats>;
  /** Trefferquote über alle Ebenen (0..1). */
  hitRatio(): number;
  /** Einträge je Ebene (Anzahl, Bytes). */
  usage(): Promise<Record<CacheTierName, { entries: number; bytes: number }>>;
  /** Löscht eine Ebene oder alles. */
  clear(tier?: CacheTierName): Promise<number>;
  /** Löscht die am längsten ungenutzten Einträge, bis höchstens `maxBytes` belegt sind. */
  prune(maxBytes: number): Promise<number>;
}

/** Baut ein Objekt mit einem Wert je Cache-Ebene. */
export function perTier<T>(f: (tier: CacheTierName) => T): Record<CacheTierName, T> {
  return {
    asset: f('asset'),
    font: f('font'),
    composition: f('composition'),
    frame: f('frame'),
    layer: f('layer'),
    geometry: f('geometry'),
    shader: f('shader'),
    audio: f('audio'),
    encoding: f('encoding'),
  };
}

function emptyStats(): TierStats {
  return { hits: 0, misses: 0, writes: 0, bytesRead: 0, bytesWritten: 0 };
}

/**
 * Erzeugt einen Cache mit den Ebenen aus {@link CACHE_TIERS}.
 *
 * @example
 * ```ts
 * const cache = createCache(new FileStore('.openvideo/cache'));
 * const bytes = await cache.tier('audio').getOrCreate(key, () => mixAudio());
 * ```
 */
export function createCache(store: ContentStore): Cache {
  const counters = perTier(() => emptyStats());
  const tiers = new Map<CacheTierName, CacheTier>();
  const pending = new Map<string, Promise<Uint8Array>>();
  const makeTier = (name: CacheTierName): CacheTier => {
    const k = (key: string) => `${name}/${key}`;
    const c = counters[name];
    const tier: CacheTier = {
      name,
      async get(key) {
        const v = await store.get(k(key));
        if (v === undefined) c.misses++;
        else {
          c.hits++;
          c.bytesRead += v.length;
        }
        return v;
      },
      async put(key, bytes) {
        await store.put(k(key), bytes);
        c.writes++;
        c.bytesWritten += bytes.length;
      },
      has: (key) => store.has(k(key)),
      async getOrCreate(key, create) {
        const hit = await tier.get(key);
        if (hit !== undefined) return hit;
        const running = pending.get(k(key));
        if (running !== undefined) return running;
        const job = (async () => {
          const bytes = await create();
          await tier.put(key, bytes);
          return bytes;
        })();
        pending.set(k(key), job);
        try {
          return await job;
        } finally {
          pending.delete(k(key));
        }
      },
      localPath: (key) => store.localPath?.(k(key)),
    };
    return tier;
  };
  return {
    store,
    tier(name) {
      let t = tiers.get(name);
      if (t === undefined) {
        t = makeTier(name);
        tiers.set(name, t);
      }
      return t;
    },
    stats() {
      return perTier((t) => ({ ...counters[t] }));
    },
    hitRatio() {
      let hits = 0;
      let total = 0;
      for (const t of CACHE_TIERS) {
        hits += counters[t].hits;
        total += counters[t].hits + counters[t].misses;
      }
      return total === 0 ? 0 : hits / total;
    },
    async usage() {
      const out = perTier(() => ({ entries: 0, bytes: 0 }));
      for (const t of CACHE_TIERS) {
        for (const e of await store.list(`${t}/`)) {
          out[t].entries++;
          out[t].bytes += e.size;
        }
      }
      return out;
    },
    async clear(tier) {
      let removed = 0;
      for (const t of tier === undefined ? CACHE_TIERS : [tier]) {
        for (const e of await store.list(`${t}/`)) {
          await store.delete(e.key);
          removed++;
        }
      }
      return removed;
    },
    async prune(maxBytes) {
      const all: StoreEntry[] = [];
      for (const t of CACHE_TIERS) all.push(...(await store.list(`${t}/`)));
      all.sort((a, b) => a.lastUsed - b.lastUsed);
      let total = all.reduce((n, e) => n + e.size, 0);
      let removed = 0;
      for (const e of all) {
        if (total <= maxBytes) break;
        await store.delete(e.key);
        total -= e.size;
        removed++;
      }
      return removed;
    },
  };
}

/**
 * Baut einen Speicher aus Umgebungsvariablen:
 * `OPENVIDEO_CACHE_DIR` (lokal, Standard `<projekt>/.openvideo/cache`) und optional
 * `OPENVIDEO_S3_ENDPOINT`, `OPENVIDEO_S3_BUCKET`, `OPENVIDEO_S3_REGION`,
 * `OPENVIDEO_S3_ACCESS_KEY_ID`, `OPENVIDEO_S3_SECRET_ACCESS_KEY`, `OPENVIDEO_S3_PREFIX`.
 *
 * @example
 * ```ts
 * const store = storeFromEnv(process.env, '/work/project');
 * ```
 */
export function storeFromEnv(env: Readonly<Record<string, string | undefined>>, projectDir: string): ContentStore {
  const local = new FileStore(env['OPENVIDEO_CACHE_DIR'] ?? `${projectDir}/.openvideo/cache`);
  const endpoint = env['OPENVIDEO_S3_ENDPOINT'];
  if (endpoint === undefined || endpoint === '') return local;
  const need = (name: string): string => {
    const v = env[name];
    if (v === undefined || v === '') {
      throw new OpenVideoError({ code: 'OV_CACHE_CONFIG', errorClass: 'CacheError', problem: `${name} is required when OPENVIDEO_S3_ENDPOINT is set.`, suggestions: [`Set ${name}.`] });
    }
    return v;
  };
  const remote = new S3Store({
    endpoint,
    bucket: need('OPENVIDEO_S3_BUCKET'),
    region: env['OPENVIDEO_S3_REGION'] ?? 'us-east-1',
    accessKeyId: need('OPENVIDEO_S3_ACCESS_KEY_ID'),
    secretAccessKey: need('OPENVIDEO_S3_SECRET_ACCESS_KEY'),
    ...(env['OPENVIDEO_S3_PREFIX'] !== undefined ? { prefix: env['OPENVIDEO_S3_PREFIX'] } : {}),
  });
  return new TieredStore(local, remote);
}
