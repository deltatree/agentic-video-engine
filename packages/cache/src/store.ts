/**
 * Speicher-Schnittstelle und Implementierungen für Dateisystem und Arbeitsspeicher.
 */
import { mkdir, readFile, rename, rm, stat, utimes, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OpenVideoError } from '@agentic-video/core';

/** Eintrag bei der Auflistung eines Speichers. */
export interface StoreEntry {
  readonly key: string;
  readonly size: number;
  /** Letzte Nutzung in Millisekunden seit 1970 (für LRU-Bereinigung). */
  readonly lastUsed: number;
}

/**
 * Einfacher Schlüssel-Wert-Speicher für Bytes.
 * Implementierungen sind sicher bei parallelem Schreiben desselben Schlüssels
 * (Inhalte sind inhaltsadressiert und damit gleich).
 */
export interface ContentStore {
  /** Name für Diagnosen, z. B. `file:/path` oder `s3://bucket/prefix`. */
  readonly name: string;
  has(key: string): Promise<boolean>;
  get(key: string): Promise<Uint8Array | undefined>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<StoreEntry[]>;
  /** Lokaler Dateipfad, falls der Speicher lokal ist (für FFmpeg, Blender, Browser). */
  localPath?(key: string): string | undefined;
}

const SAFE_KEY = /^[A-Za-z0-9:._/-]+$/u;

/** Prüft einen Schlüssel gegen Pfad-Ausbrüche (`..`) und ungültige Zeichen. */
export function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.split('/').some((p) => p === '..' || p === '.' || p === '') ) {
    throw new OpenVideoError({
      code: 'OV_CACHE_KEY_INVALID',
      errorClass: 'CacheError',
      problem: `Invalid cache key "${key}".`,
      suggestions: ['Use content hashes such as "sha256:<hex>" as keys.'],
    });
  }
}

function keyToRelative(key: string): string {
  assertSafeKey(key);
  const parts = key.split('/');
  const last = parts.pop() ?? '';
  const clean = last.replace(/^sha256:/u, '');
  const shard = clean.slice(0, 2) || '00';
  return join(...parts, shard, clean.replace(/:/gu, '_'));
}

/**
 * Speicher im Dateisystem. Schlüssel werden auf zwei Zeichen geschardet.
 * Schreiben ist atomar (temporäre Datei, dann umbenennen).
 *
 * @example
 * ```ts
 * const store = new FileStore('/tmp/ov-cache');
 * await store.put('frame/sha256:ab…', bytes);
 * ```
 */
export class FileStore implements ContentStore {
  readonly name: string;

  constructor(readonly root: string) {
    this.name = `file:${root}`;
  }

  localPath(key: string): string {
    return join(this.root, keyToRelative(key));
  }

  has(key: string): Promise<boolean> {
    return Promise.resolve(existsSync(this.localPath(key)));
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const path = this.localPath(key);
    try {
      const bytes = await readFile(path);
      const now = new Date();
      // Nutzung vermerken (für LRU); Fehler hier sind unkritisch, werden aber nicht verschluckt.
      await utimes(path, now, now);
      return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw storeError(this.name, 'read', key, error);
    }
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.localPath(key);
    const tmp = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, bytes);
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true });
      throw storeError(this.name, 'write', key, error);
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.localPath(key), { force: true });
  }

  async list(prefix = ''): Promise<StoreEntry[]> {
    const base = join(this.root, prefix);
    const out: StoreEntry[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if (isNotFound(error)) return;
        throw storeError(this.name, 'list', prefix, error);
      }
      for (const n of names) {
        const full = join(dir, n);
        const s = await stat(full);
        if (s.isDirectory()) await walk(full, rel === '' ? n : `${rel}/${n}`);
        else if (!n.endsWith('.tmp')) out.push({ key: `${prefix}${prefix === '' || prefix.endsWith('/') ? '' : '/'}${rel === '' ? n : `${rel}/${n}`}`, size: s.size, lastUsed: s.mtimeMs });
      }
    };
    await walk(base, '');
    return out;
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function storeError(store: string, action: string, key: string, cause: unknown): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_CACHE_IO',
    errorClass: 'CacheError',
    problem: `Cache ${action} failed for "${key}" in ${store}.`,
    details: { reason: cause instanceof Error ? cause.message : String(cause) },
    suggestions: ['Check disk space and permissions of the cache directory.', 'Run `openvideo cache clear` if the cache is corrupt.'],
    cause,
  });
}

/**
 * Speicher im Arbeitsspeicher (für Tests und Vorschau).
 *
 * @example
 * ```ts
 * const store = new MemoryStore();
 * ```
 */
export class MemoryStore implements ContentStore {
  readonly name = 'memory';
  private readonly map = new Map<string, { bytes: Uint8Array; lastUsed: number }>();
  private clock = 0;

  has(key: string): Promise<boolean> {
    return Promise.resolve(this.map.has(key));
  }

  get(key: string): Promise<Uint8Array | undefined> {
    const hit = this.map.get(key);
    if (hit !== undefined) hit.lastUsed = ++this.clock;
    return Promise.resolve(hit?.bytes);
  }

  put(key: string, bytes: Uint8Array): Promise<void> {
    assertSafeKey(key);
    this.map.set(key, { bytes, lastUsed: ++this.clock });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.map.delete(key);
    return Promise.resolve();
  }

  list(prefix = ''): Promise<StoreEntry[]> {
    return Promise.resolve([...this.map].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, size: v.bytes.length, lastUsed: v.lastUsed })));
  }
}

/**
 * Gestufter Speicher: liest zuerst lokal, dann entfernt, und legt entfernte Treffer lokal ab.
 * Schreibt in beide Stufen.
 *
 * @example
 * ```ts
 * const store = new TieredStore(new FileStore('/cache'), new S3Store({ … }));
 * ```
 */
export class TieredStore implements ContentStore {
  readonly name: string;

  constructor(
    readonly local: ContentStore,
    readonly remote: ContentStore,
  ) {
    this.name = `${local.name} → ${remote.name}`;
  }

  async has(key: string): Promise<boolean> {
    return (await this.local.has(key)) || (await this.remote.has(key));
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const local = await this.local.get(key);
    if (local !== undefined) return local;
    const remote = await this.remote.get(key);
    if (remote !== undefined) await this.local.put(key, remote);
    return remote;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await Promise.all([this.local.put(key, bytes), this.remote.put(key, bytes)]);
  }

  async delete(key: string): Promise<void> {
    await Promise.all([this.local.delete(key), this.remote.delete(key)]);
  }

  list(prefix?: string): Promise<StoreEntry[]> {
    return this.remote.list(prefix);
  }

  localPath(key: string): string | undefined {
    return this.local.localPath?.(key);
  }
}
