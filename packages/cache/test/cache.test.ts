import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, MemoryStore, S3Store, TieredStore, createCache, storeFromEnv } from '@agentic-video/cache';
import { contentHash } from '@agentic-video/core';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('FileStore', () => {
  it('speichert atomar, listet und löscht', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'ov-cache-')));
    const key = `frame/${contentHash('a')}`;
    expect(await store.get(key)).toBeUndefined();
    await store.put(key, bytes('hello'));
    expect(new TextDecoder().decode(await store.get(key))).toBe('hello');
    expect(await store.has(key)).toBe(true);
    const list = await store.list('frame/');
    expect(list).toHaveLength(1);
    expect(list[0]?.size).toBe(5);
    await store.delete(key);
    expect(await store.has(key)).toBe(false);
  });

  it('lehnt Pfad-Ausbrüche ab', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'ov-cache-')));
    await expect(store.put('frame/../../etc/passwd', bytes('x'))).rejects.toThrow(/Invalid cache key/u);
  });
});

describe('Cache-Ebenen (FR-68)', () => {
  it('zählt Treffer und berechnet nur einmal', async () => {
    const cache = createCache(new MemoryStore());
    let calls = 0;
    const make = () => {
      calls++;
      return Promise.resolve(bytes('v'));
    };
    await Promise.all([cache.tier('audio').getOrCreate('k', make), cache.tier('audio').getOrCreate('k', make)]);
    await cache.tier('audio').getOrCreate('k', make);
    expect(calls).toBe(1);
    expect(cache.stats().audio.hits).toBeGreaterThanOrEqual(1);
    expect(cache.hitRatio()).toBeGreaterThan(0);
  });

  it('bereinigt nach LRU und löscht Ebenen', async () => {
    const cache = createCache(new MemoryStore());
    for (let i = 0; i < 5; i++) await cache.tier('frame').put(`k${String(i)}`, new Uint8Array(100));
    await cache.tier('frame').get('k0');
    expect(await cache.prune(250)).toBe(3);
    expect(await cache.tier('frame').has('k0')).toBe(true);
    expect(await cache.clear('frame')).toBe(2);
    expect((await cache.usage()).frame.entries).toBe(0);
  });

  it('gestufter Speicher legt entfernte Treffer lokal ab', async () => {
    const local = new MemoryStore();
    const remote = new MemoryStore();
    await remote.put('frame/x', bytes('r'));
    const tiered = new TieredStore(local, remote);
    expect(new TextDecoder().decode(await tiered.get('frame/x'))).toBe('r');
    expect(await local.has('frame/x')).toBe(true);
  });

  it('meldet fehlende S3-Konfiguration', () => {
    expect(() => storeFromEnv({ OPENVIDEO_S3_ENDPOINT: 'http://x' }, '/tmp/p')).toThrow(/OPENVIDEO_S3_BUCKET/u);
    expect(storeFromEnv({}, '/tmp/p').name).toBe('file:/tmp/p/.openvideo/cache');
  });
});

const dockerOk = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;

describe('S3Store gegen SeaweedFS (S3-kompatibel)', () => {
  it.skipIf(!dockerOk)('liest, schreibt, listet und löscht (braucht Docker)', async () => {
    const name = `ov-s3-test-${String(process.pid)}`;
    execFileSync('docker', ['run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::8333', 'chrislusf/seaweedfs@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882', 'server', '-s3', '-s3.port=8333'], { stdio: 'ignore' });
    try {
      const port = execFileSync('docker', ['port', name, '8333']).toString().trim().split(':').pop() ?? '';
      const endpoint = `http://127.0.0.1:${port}`;
      const options = { endpoint, bucket: 'openvideo', region: 'us-east-1', accessKeyId: 'ovtest', secretAccessKey: 'ovtest-secret' };
      let ready = false;
      for (let i = 0; i < 60 && !ready; i++) {
        try {
          const r = await fetch(`${endpoint}/`);
          ready = r.status < 500;
        } catch (error) {
          ready = !(error instanceof Error);
        }
        if (!ready) await new Promise((r) => setTimeout(r, 500));
      }
      // Bucket anlegen (PUT auf den Bucket-Pfad)
      const { signV4 } = await import('@agentic-video/cache');
      const url = new URL(`${endpoint}/openvideo`);
      const res = await fetch(url, { method: 'PUT', headers: signV4({ method: 'PUT', url, region: 'us-east-1', accessKeyId: 'ovtest', secretAccessKey: 'ovtest-secret', body: new Uint8Array(), now: new Date() }) });
      expect(res.ok).toBe(true);
      const store = new S3Store({ ...options, prefix: 'test/' });
      await store.put('frame/abc', bytes('remote'));
      expect(await store.has('frame/abc')).toBe(true);
      expect(new TextDecoder().decode(await store.get('frame/abc'))).toBe('remote');
      expect((await store.list('frame/')).map((e) => e.key)).toEqual(['frame/abc']);
      await store.delete('frame/abc');
      expect(await store.get('frame/abc')).toBeUndefined();
    } finally {
      execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    }
  });
});
