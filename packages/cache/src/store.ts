/**
 * Speicher-Schnittstelle und Implementierungen für Dateisystem und Arbeitsspeicher.
 */
import { mkdir, readFile, rename, rm, stat, utimes, writeFile, readdir } from 'node:fs/promises';
import { existsSync, type Stats } from 'node:fs';
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

/** Kodierung des letzten Schlüsselteils als Dateiname: `:` wird zu `%3A` (umkehrbar, `%` ist in Schlüsseln verboten). */
function encodeName(name: string): string {
  return name.replace(/:/gu, '%3A');
}

function decodeName(name: string): string {
  return name.replace(/%3A/gu, ':');
}

/** Namensteil temporärer Dateien; kann in kodierten Schlüsseln nicht vorkommen. */
const TMP_MARK = '%tmp-';

function keyToRelative(key: string): string {
  assertSafeKey(key);
  const parts = key.split('/');
  const last = parts.pop() ?? '';
  const shard = last.replace(/^sha256:/u, '').slice(0, 2) || '00';
  return join(...parts, shard, encodeName(last));
}

/**
 * Speicher im Dateisystem. Schlüssel werden auf zwei Zeichen geschardet.
 * Der Dateipfad kodiert den Schlüssel umkehrbar: `list()` liefert die Originalschlüssel.
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
  #touchWarned = false;

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
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw storeError(this.name, 'read', key, error);
    }
    const now = new Date();
    // Nutzung vermerken (für LRU). Ein Fehler hier (z. B. schreibgeschütztes Dateisystem)
    // macht den Treffer nicht ungültig; er wird einmal je Speicher als Warnung gemeldet.
    await utimes(path, now, now).catch((error: unknown) => {
      if (this.#touchWarned) return;
      this.#touchWarned = true;
      process.emitWarning(`Cache ${this.name}: cannot update the last-used time (${error instanceof Error ? error.message : String(error)}); LRU pruning may be inaccurate.`);
    });
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.localPath(key);
    const tmp = `${path}${TMP_MARK}${randomUUID()}`;
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
    // Nur der Ordneranteil des Präfixes bestimmt, wo gesucht wird; der Rest filtert die Schlüssel.
    const dirPart = prefix.slice(0, prefix.lastIndexOf('/') + 1);
    if (dirPart !== '') assertSafeKey(dirPart.slice(0, -1));
    const out: StoreEntry[] = [];
    const walk = async (dir: string, rel: readonly string[]): Promise<void> => {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error) {
        if (isNotFound(error)) return;
        throw storeError(this.name, 'list', prefix, error);
      }
      for (const n of names) {
        const full = join(dir, n);
        let s: Stats;
        try {
          s = await stat(full);
        } catch (error) {
          // Gleichzeitig gelöschte Einträge überspringen.
          if (isNotFound(error)) continue;
          throw storeError(this.name, 'list', prefix, error);
        }
        if (s.isDirectory()) {
          await walk(full, [...rel, n]);
          continue;
        }
        // Aufbau: <Schlüsselordner…>/<Shard>/<kodierter Name>; alles andere gehört nicht zum Speicher.
        if (n.includes(TMP_MARK) || rel.length === 0) continue;
        const key = [...rel.slice(0, -1), decodeName(n)].join('/');
        if (key.startsWith(prefix)) out.push({ key, size: s.size, lastUsed: s.mtimeMs });
      }
    };
    await walk(join(this.root, dirPart), dirPart === '' ? [] : dirPart.slice(0, -1).split('/'));
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

/** Optionen für {@link TieredStore}. */
export interface TieredStoreOptions {
  /**
   * `delete` löscht auch im entfernten (gemeinsamen) Speicher. Standard: nein, denn andere
   * Rechner nutzen denselben Speicher; Bereinigung ist eine lokale Entscheidung.
   */
  readonly deleteRemote?: boolean;
  /** Meldet Fehler des entfernten Speichers (Standard: Prozess-Warnung). */
  readonly onRemoteError?: (error: OpenVideoError) => void;
}

function remoteError(store: string, action: string, key: string, cause: unknown): OpenVideoError {
  if (cause instanceof OpenVideoError) return cause;
  return new OpenVideoError({
    code: 'OV_CACHE_REMOTE',
    errorClass: 'CacheError',
    problem: `Remote cache ${action} failed for "${key}" in ${store}.`,
    details: { reason: cause instanceof Error ? cause.message : String(cause) },
    suggestions: ['Check the network access to the remote cache.'],
    cause,
  });
}

/**
 * Gestufter Speicher: liest zuerst lokal, dann entfernt, und legt entfernte Treffer lokal ab.
 * Schreibt in beide Stufen. Fehler der entfernten Stufe gelten als Fehltreffer und werden
 * gemeldet, lassen den Aufruf aber nicht scheitern. `delete` wirkt nur lokal, außer
 * {@link TieredStoreOptions.deleteRemote} ist gesetzt.
 *
 * @example
 * ```ts
 * const store = new TieredStore(new FileStore('/cache'), new S3Store({ … }));
 * ```
 */
export class TieredStore implements ContentStore {
  readonly name: string;
  /** Löscht `delete` auch entfernt? */
  readonly deletesRemote: boolean;
  readonly #onRemoteError: (error: OpenVideoError) => void;

  constructor(
    readonly local: ContentStore,
    readonly remote: ContentStore,
    options: TieredStoreOptions = {},
  ) {
    this.name = `${local.name} → ${remote.name}`;
    this.deletesRemote = options.deleteRemote === true;
    this.#onRemoteError = options.onRemoteError ?? ((error) => { process.emitWarning(`${error.diagnostic.code}: ${error.diagnostic.problem}`); });
  }

  async #remote<T>(action: string, key: string, fallback: T, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      this.#onRemoteError(remoteError(this.remote.name, action, key, error));
      return fallback;
    }
  }

  async has(key: string): Promise<boolean> {
    return (await this.local.has(key)) || (await this.#remote('has', key, false, () => this.remote.has(key)));
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const local = await this.local.get(key);
    if (local !== undefined) return local;
    const remote = await this.#remote<Uint8Array | undefined>('get', key, undefined, () => this.remote.get(key));
    if (remote !== undefined) await this.local.put(key, remote);
    return remote;
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await Promise.all([this.local.put(key, bytes), this.#remote('put', key, undefined, () => this.remote.put(key, bytes))]);
  }

  async delete(key: string): Promise<void> {
    await this.local.delete(key);
    if (this.deletesRemote) await this.remote.delete(key);
  }

  /** Vereinigung beider Stufen; bei doppelten Schlüsseln zählt die jüngste Nutzung. */
  async list(prefix?: string): Promise<StoreEntry[]> {
    const [local, remote] = await Promise.all([this.local.list(prefix), this.#remote<StoreEntry[]>('list', prefix ?? '', [], () => this.remote.list(prefix))]);
    const merged = new Map<string, StoreEntry>();
    for (const e of [...remote, ...local]) {
      const known = merged.get(e.key);
      merged.set(e.key, known === undefined || e.lastUsed > known.lastUsed ? e : known);
    }
    return [...merged.values()];
  }

  localPath(key: string): string | undefined {
    return this.local.localPath?.(key);
  }
}
