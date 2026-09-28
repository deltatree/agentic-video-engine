/**
 * Regressionstests zu den Review-Befunden A1–A12 (Gruppe A, Asset-Pipeline und Fetcher).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { contentHash } from '@agentic-video/core';
import { fetchAsset, importAsset, isBlockedAddress, resolveProjectAssets, type ResolvedAddress } from '@agentic-video/assets';

const ffmpeg = process.env['OPENVIDEO_FFMPEG'] ?? join(process.env['HOME'] ?? '', '.local/bin/ffmpeg');
const ID = /^[A-Za-z][A-Za-z0-9_-]*$/u;
const svg = (w: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${String(w)}" height="10"/>`;
let media: string;

beforeAll(() => {
  media = mkdtempSync(join(tmpdir(), 'ov-assets-review-'));
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=32x24:r=10:d=0.5', join(media, 'anim.gif')]);
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=d=0.3', join(media, 'tone.wav')]);
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=32x24:r=10:d=1', '-f', 'mpegts', join(media, 'outside.ts')]);
});

function project(): string {
  return mkdtempSync(join(tmpdir(), 'ov-proj-review-'));
}

async function listen(server: Server, host = '127.0.0.1'): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('server has no port');
  return (address satisfies AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => { resolve(); }));
}

/** Prüfregel für Tests: genau 127.0.0.1 ist erlaubt, sonst gilt die normale Sperrliste. */
const only127 = (ip: string) => ip !== '127.0.0.1' && isBlockedAddress(ip);

describe('A1: IPv6-Formen mit eingebetteter IPv4-Adresse', () => {
  it('blockiert mapped, kompatible, NAT64, 6to4 und lokale IPv6-Bereiche', () => {
    const blocked = [
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      '::ffff:127.0.0.1',
      '0:0:0:0:0:ffff:7f00:0001',
      '::127.0.0.1',
      '::7f00:1',
      '::ffff:0:a00:1',
      '64:ff9b::7f00:1',
      '64:ff9b::a9fe:a9fe',
      '64:ff9b:1::1',
      '2002:7f00:1::',
      '2002:a9fe:a9fe::1',
      '2002:0a00:0001:ffff::1',
      'fe80::1',
      'fe80::1%eth0',
      'febf::1',
      'fec0::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '::',
      '::1',
      '0:0:0:0:0:0:0:1',
      '2001::1',
      'not-an-ip',
    ];
    for (const ip of blocked) expect(isBlockedAddress(ip), ip).toBe(true);
    for (const ip of ['2606:4700:4700::1111', '::ffff:93.184.216.34', '2002:5db8:d822::1', '64:ff9b::5db8:d822', '1.1.1.1']) expect(isBlockedAddress(ip), ip).toBe(false);
  });

  it('blockiert IPv6-Literale in URLs', async () => {
    await expect(fetchAsset('http://[::ffff:127.0.0.1]/')).rejects.toMatchObject({ diagnostic: { code: 'OV_FETCH_BLOCKED' } });
    await expect(fetchAsset('http://[::ffff:a9fe:a9fe]/latest/meta-data')).rejects.toMatchObject({ diagnostic: { code: 'OV_FETCH_BLOCKED' } });
  });
});

describe('A2: DNS-Rebinding', () => {
  it('prüft genau die Adresse, mit der verbunden wird', async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.end(svg(1));
    });
    const port = await listen(server);
    const answers = ['127.0.0.1', '10.0.0.1'];
    let calls = 0;
    const resolve = (): Promise<readonly ResolvedAddress[]> => Promise.resolve([{ address: answers[calls++] ?? '10.0.0.1', family: 4 }]);
    try {
      const r = await fetchAsset(`http://rebind.test:${String(port)}/a.svg`, { resolve, isBlocked: only127 });
      expect(new TextDecoder().decode(r.bytes)).toBe(svg(1));
      // Eine Auflösung je Verbindung: Prüfung und Verbindung nutzen dieselbe Antwort.
      expect(calls).toBe(1);
      await expect(fetchAsset(`http://rebind.test:${String(port)}/a.svg`, { resolve, isBlocked: only127 })).rejects.toMatchObject({ diagnostic: { code: 'OV_FETCH_BLOCKED' } });
      expect(calls).toBe(2);
      expect(hits).toBe(1);
    } finally {
      await close(server);
    }
  });

  it('blockiert Hostnamen, die auf interne Adressen zeigen', async () => {
    await expect(fetchAsset('http://internal.test/x', { resolve: () => Promise.resolve([{ address: '169.254.169.254', family: 4 }]) })).rejects.toMatchObject({ diagnostic: { code: 'OV_FETCH_BLOCKED' } });
  });
});

describe('A3: Weiterleitungen', () => {
  it('blockiert eine Weiterleitung auf eine interne Adresse; erlaubt wäre sie erreichbar', async () => {
    let secret = 0;
    let port = 0;
    const server = createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `http://127.0.0.2:${String(port)}/secret` });
        res.end();
      } else if (req.url === '/nolocation') {
        res.writeHead(302);
        res.end();
      } else {
        secret++;
        res.end(svg(2));
      }
    });
    port = await listen(server, '0.0.0.0');
    try {
      await expect(fetchAsset(`http://127.0.0.1:${String(port)}/redirect`, { isBlocked: only127 })).rejects.toMatchObject({ diagnostic: { code: 'OV_FETCH_BLOCKED' } });
      expect(secret).toBe(0);
      // Gegenprobe: mit freigegebenem Ziel folgt der Fetcher der Weiterleitung wirklich.
      const r = await fetchAsset(`http://127.0.0.1:${String(port)}/redirect`, { isBlocked: (ip) => !ip.startsWith('127.0.0.') && isBlockedAddress(ip) });
      expect(r.finalUrl).toBe(`http://127.0.0.2:${String(port)}/secret`);
      expect(secret).toBe(1);
      await expect(fetchAsset(`http://127.0.0.1:${String(port)}/nolocation`, { isBlocked: only127 })).rejects.toMatchObject({ diagnostic: { code: 'OV_FETCH_REDIRECT_LOCATION' } });
    } finally {
      await close(server);
    }
  });
});

describe('A4: Größengrenze beim Lesen', () => {
  it('bricht einen endlosen Body ab, statt ihn ganz zu puffern', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const chunk = Buffer.alloc(64 * 1024, 1);
      const pump = () => {
        while (!res.destroyed && res.write(chunk));
        if (!res.destroyed) res.once('drain', pump);
      };
      pump();
    });
    const port = await listen(server);
    try {
      await expect(fetchAsset(`http://127.0.0.1:${String(port)}/big`, { isBlocked: only127, maxBytes: 1024 * 1024 })).rejects.toMatchObject({ diagnostic: { code: 'OV_FETCH_TOO_LARGE' } });
    } finally {
      await close(server);
    }
  }, 15_000);
});

describe('A5: Symlinks und Pfadgrenze', () => {
  it('lehnt Symlinks aus dem Projekt heraus ab', async () => {
    const outside = join(media, 'secret.svg');
    writeFileSync(outside, svg(3));
    const dir = project();
    mkdirSync(join(dir, 'assets'));
    symlinkSync(outside, join(dir, 'assets', 'link.svg'));
    await expect(importAsset(dir, { path: 'assets/link.svg' }, { cache: createCache(new MemoryStore()) })).rejects.toMatchObject({ diagnostic: { code: 'OV_PATH_OUTSIDE' } });
    const resolved = await resolveProjectAssets(dir, { assets: [{ id: 'l', type: 'svg', src: 'assets/link.svg' }] }, { cache: createCache(new MemoryStore()) });
    expect(resolved.diagnostics.map((d) => d.code)).toEqual(['OV_PATH_OUTSIDE']);
    await resolved.close();
  });

  it('schreibt nicht durch einen Symlink-Ordner "assets" hinaus', async () => {
    const dir = project();
    const target = mkdtempSync(join(tmpdir(), 'ov-outside-'));
    symlinkSync(target, join(dir, 'assets'));
    await expect(importAsset(dir, { base64: Buffer.from(svg(4)).toString('base64'), fileName: 'x.svg' }, { cache: createCache(new MemoryStore()) })).rejects.toMatchObject({ diagnostic: { code: 'OV_PATH_OUTSIDE' } });
  });
});

describe('A6: ffmpeg nur für echte Mediendateien', () => {
  it('lehnt Playlists und concat-Listen mit Medien-Endung ab', async () => {
    const dir = project();
    const cache = createCache(new MemoryStore());
    const hls = '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nfile:///etc/hostname\n#EXT-X-ENDLIST\n';
    await expect(importAsset(dir, { base64: Buffer.from(hls).toString('base64'), fileName: 'clip.mp4' }, { cache })).rejects.toMatchObject({ diagnostic: { code: 'OV_ASSET_UNSAFE_MEDIA' } });
    const concat = 'ffconcat version 1.0\nfile /etc/hostname\n';
    await expect(importAsset(dir, { base64: Buffer.from(concat).toString('base64'), fileName: 'song.mp3' }, { cache })).rejects.toMatchObject({ diagnostic: { code: 'OV_ASSET_UNSAFE_MEDIA' } });
  });

  it('liest über eine HLS-Playlist keine Mediendatei außerhalb des Projekts', async () => {
    const dir = project();
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'x.m3u8'), `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${join(media, 'outside.ts')}\n#EXT-X-ENDLIST\n`);
    // Ohne Sperre liest ffprobe die fremde Datei und meldet deren Dauer als Metadaten.
    const resolved = await resolveProjectAssets(dir, { assets: [{ id: 'v', type: 'video', src: 'assets/x.m3u8' }] }, { cache: createCache(new MemoryStore()) });
    expect(resolved.get('v')).toBeUndefined();
    expect(resolved.diagnostics.map((d) => d.code)).toEqual(['OV_ASSET_UNSAFE_MEDIA']);
    await resolved.close();
  });
});

describe('A7/A12: Asset-IDs und gleichzeitige Importe', () => {
  it('leitet für Namen ohne Buchstaben unterschiedliche, gültige IDs ab', async () => {
    const dir = project();
    const cache = createCache(new MemoryStore());
    const a = await importAsset(dir, { base64: Buffer.from(svg(5)).toString('base64'), fileName: '123.svg' }, { cache });
    const b = await importAsset(dir, { base64: Buffer.from(svg(6)).toString('base64'), fileName: '456.svg' }, { cache });
    const c = await importAsset(dir, { base64: Buffer.from(svg(7)).toString('base64'), fileName: '___.svg' }, { cache });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    for (const id of [a.id, b.id, c.id]) expect(id).toMatch(ID);
  });

  it('gleichzeitige Importe mit gleichem Dateinamen überschreiben sich nicht', async () => {
    const dir = project();
    const cache = createCache(new MemoryStore());
    const inputs = [8, 9, 10, 11].map((w) => ({ base64: Buffer.from(svg(w)).toString('base64'), fileName: 'same.svg' }));
    const results = await Promise.all(inputs.map((i) => importAsset(dir, i, { cache })));
    expect(new Set(results.map((r) => r.src)).size).toBe(4);
    for (const r of results) expect(contentHash(new Uint8Array(readFileSync(join(dir, r.src))))).toBe(r.hash);
  });
});

describe('A8: Offline-Modus beim Import', () => {
  it('lädt keine URL, wenn offline', async () => {
    await expect(importAsset(project(), { url: 'http://127.0.0.1:1/x.svg' }, { cache: createCache(new MemoryStore()), offline: true })).rejects.toMatchObject({ diagnostic: { code: 'OV_ASSET_OFFLINE' } });
  });
});

describe('A9: kaputter Metadaten-Eintrag', () => {
  it('wird neu berechnet statt den Import dauerhaft zu blockieren', async () => {
    const cache = createCache(new MemoryStore());
    const bytes = new TextEncoder().encode(svg(12));
    await cache.tier('asset').put(`meta-${contentHash(bytes).replace('sha256:', '')}-svg`, new TextEncoder().encode('{kaputt'));
    const r = await importAsset(project(), { base64: Buffer.from(bytes).toString('base64'), fileName: 'ok.svg' }, { cache });
    expect(r.metadata['dimensions']).toEqual({ width: 12, height: 10 });
  });
});

describe('A10/A11: Resolver', () => {
  it('meldet doppelte und fehlende IDs', async () => {
    const dir = project();
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'a.svg'), svg(13));
    const resolved = await resolveProjectAssets(dir, { assets: [{ id: 'a', type: 'svg', src: 'assets/a.svg' }, { id: 'a', type: 'svg', src: 'assets/a.svg' }, { type: 'svg', src: 'assets/a.svg' }] }, { cache: createCache(new MemoryStore()) });
    expect(resolved.diagnostics.map((d) => d.code).sort()).toEqual(['OV_ASSET_DUPLICATE_ID', 'OV_ASSET_ID_MISSING']);
    expect(resolved.all()).toHaveLength(1);
    await resolved.close();
  });

  it('ein gescheitertes Öffnen bleibt nicht im Cache und bricht close() nicht ab', async () => {
    const dir = project();
    const cache = createCache(new MemoryStore());
    const gif = await importAsset(dir, { path: join(media, 'anim.gif'), id: 'anim' }, { cache, allowOutsidePaths: true });
    const wav = await importAsset(dir, { path: join(media, 'tone.wav'), id: 'tone' }, { cache, allowOutsidePaths: true });
    const resolved = await resolveProjectAssets(dir, { assets: [{ id: 'anim', type: 'image', src: gif.src }, { id: 'tone', type: 'audio', src: wav.src }] }, { cache });
    await expect(resolved.videoFrame('tone', 0)).rejects.toThrow();
    await expect(resolved.videoFrame('tone', 0)).rejects.toMatchObject({ diagnostic: { code: 'OV_FFMPEG_PROBE' } });
    expect((await resolved.videoFrame('anim', 0)).width).toBe(32);
    await expect(resolved.close()).resolves.toBeUndefined();
  });
});
