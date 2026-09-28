/**
 * Regressionstests zu den Review-Befunden A4, A13, A14, A16, A17 und A18 (Gruppe A).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, MemoryStore, S3Store, TieredStore, createCache, storeFromEnv, type ContentStore, type StoreEntry } from '@agentic-video/cache';
import { OpenVideoError, contentHash } from '@agentic-video/core';

const bytes = (s: string) => new TextEncoder().encode(s);

function fileStore(): FileStore {
  return new FileStore(mkdtempSync(join(tmpdir(), 'ov-cache-review-')));
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  return `http://127.0.0.1:${String((address satisfies AddressInfo).port)}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => { resolve(); }));
}

/** Entfernter Speicher, der bei jedem Zugriff scheitert. */
class BrokenStore implements ContentStore {
  readonly name = 'broken';
  private fail(): never {
    throw new OpenVideoError({ code: 'OV_CACHE_REMOTE', errorClass: 'CacheError', problem: 'remote down', suggestions: ['retry'] });
  }
  has(): Promise<boolean> {
    return Promise.resolve().then(() => this.fail());
  }
  get(): Promise<Uint8Array | undefined> {
    return Promise.resolve().then(() => this.fail());
  }
  put(): Promise<void> {
    return Promise.resolve().then(() => this.fail());
  }
  delete(): Promise<void> {
    return Promise.resolve().then(() => this.fail());
  }
  list(): Promise<StoreEntry[]> {
    return Promise.resolve().then(() => this.fail());
  }
}

describe('A13: FileStore liefert Originalschlüssel', () => {
  it('list() gibt die gespeicherten Schlüssel zurück, nicht Shard-Pfade', async () => {
    const store = fileStore();
    const keys = [`frame/${contentHash('a')}`, 'frame/k0', 'asset/meta-abc-png', 'frame/sub/x:y'];
    for (const k of keys) await store.put(k, bytes(k));
    const listed = (await store.list('frame/')).map((e) => e.key).sort();
    expect(listed).toEqual(keys.filter((k) => k.startsWith('frame/')).sort());
    for (const k of listed) expect(new TextDecoder().decode(await store.get(k))).toBe(k);
  });

  it('unterscheidet "sha256:abc" und "abc" (umkehrbare Kodierung)', async () => {
    const store = fileStore();
    await store.put('frame/sha256:abc', bytes('1'));
    await store.put('frame/abc', bytes('2'));
    expect(new TextDecoder().decode(await store.get('frame/sha256:abc'))).toBe('1');
    expect(new TextDecoder().decode(await store.get('frame/abc'))).toBe('2');
  });

  it('clear() und prune() löschen Einträge wirklich', async () => {
    const store = fileStore();
    const cache = createCache(store);
    for (let i = 0; i < 4; i++) await cache.tier('frame').put(`sha256:${String(i).repeat(8)}`, new Uint8Array(100));
    expect(await cache.prune(250)).toBe(2);
    expect((await cache.usage()).frame.entries).toBe(2);
    expect(await cache.clear('frame')).toBe(2);
    expect(await store.list('frame/')).toEqual([]);
  });
});

describe('A14: TieredStore', () => {
  it('list() vereint lokale und entfernte Einträge', async () => {
    const local = new MemoryStore();
    const remote = new MemoryStore();
    await local.put('frame/a', bytes('a'));
    await remote.put('frame/b', bytes('b'));
    await local.put('frame/c', bytes('c'));
    await remote.put('frame/c', bytes('c'));
    const tiered = new TieredStore(local, remote);
    expect((await tiered.list('frame/')).map((e) => e.key).sort()).toEqual(['frame/a', 'frame/b', 'frame/c']);
  });

  it('delete() und prune() löschen nur lokal, außer ausdrücklich gewünscht', async () => {
    const local = new MemoryStore();
    const remote = new MemoryStore();
    const tiered = new TieredStore(local, remote);
    await tiered.put('frame/a', new Uint8Array(100));
    await tiered.put('frame/b', new Uint8Array(100));
    await tiered.delete('frame/a');
    expect(await local.has('frame/a')).toBe(false);
    expect(await remote.has('frame/a')).toBe(true);
    const cache = createCache(tiered);
    expect(await cache.prune(0)).toBe(1);
    expect(await cache.clear()).toBe(0);
    expect((await remote.list()).length).toBe(2);
    const shared = new TieredStore(local, remote, { deleteRemote: true });
    await shared.delete('frame/a');
    expect(await remote.has('frame/a')).toBe(false);
  });

  it('Remote-Fehler werden zu Fehltreffern und Warnungen', async () => {
    const warnings: string[] = [];
    const local = new MemoryStore();
    const tiered = new TieredStore(local, new BrokenStore(), { onRemoteError: (e) => warnings.push(e.diagnostic.code) });
    expect(await tiered.get('frame/x')).toBeUndefined();
    expect(await tiered.has('frame/x')).toBe(false);
    await tiered.put('frame/x', bytes('x'));
    expect(await local.has('frame/x')).toBe(true);
    expect(await tiered.get('frame/x')).toEqual(bytes('x'));
    expect((await tiered.list('frame/')).map((e) => e.key)).toEqual(['frame/x']);
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });
});

describe('A18: gleiche Schlüssel mit und ohne S3', () => {
  it('FileStore allein und gestuft listen dieselben Schlüssel wie der entfernte Speicher', async () => {
    const keys = [`frame/${contentHash('x')}`, 'audio/mix-1'];
    const plain = fileStore();
    const remote = new MemoryStore();
    const tiered = new TieredStore(fileStore(), remote);
    for (const k of keys) {
      await plain.put(k, bytes(k));
      await tiered.put(k, bytes(k));
    }
    const sorted = async (s: ContentStore) => (await s.list()).map((e) => e.key).sort();
    expect(await sorted(plain)).toEqual([...keys].sort());
    expect(await sorted(tiered.local)).toEqual(await sorted(remote));
  });
});

describe('A17: leeres OPENVIDEO_CACHE_DIR', () => {
  it('fällt auf den Projektordner zurück', () => {
    expect(storeFromEnv({ OPENVIDEO_CACHE_DIR: '' }, '/tmp/p').name).toBe('file:/tmp/p/.openvideo/cache');
  });
});

describe('A16: S3-Liste dekodiert XML-Entities', () => {
  it('dekodiert Schlüssel und Fortsetzungs-Token', async () => {
    const tokens: (string | null)[] = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const token = url.searchParams.get('continuation-token');
      tokens.push(token);
      res.writeHead(200, { 'content-type': 'application/xml' });
      if (token === null) {
        res.end('<ListBucketResult><Contents><Key>p/frame/a&amp;b</Key><Size>3</Size></Contents><NextContinuationToken>t&amp;1&#x3D;&#61;</NextContinuationToken></ListBucketResult>');
      } else {
        res.end('<ListBucketResult><Contents><Key>p/frame/&lt;c&gt;</Key><Size>4</Size></Contents></ListBucketResult>');
      }
    });
    const endpoint = await listen(server);
    try {
      const store = new S3Store({ endpoint, bucket: 'b', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's', prefix: 'p/' });
      expect((await store.list('frame/')).map((e) => e.key)).toEqual(['frame/a&b', 'frame/<c>']);
      expect(tokens).toEqual([null, 't&1==']);
    } finally {
      await close(server);
    }
  });
});

describe('A4: S3 get begrenzt die Größe beim Lesen', () => {
  it('bricht einen endlosen Body ab', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 1);
      const pump = () => {
        while (!res.destroyed && res.write(chunk));
        if (!res.destroyed) res.once('drain', pump);
      };
      pump();
    });
    const endpoint = await listen(server);
    try {
      const store = new S3Store({ endpoint, bucket: 'b', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's', maxObjectBytes: 1024 * 1024 });
      await expect(store.get('frame/big')).rejects.toMatchObject({ diagnostic: { code: 'OV_CACHE_TOO_LARGE' } });
    } finally {
      await close(server);
    }
  }, 15_000);
});
