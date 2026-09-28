import { beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { bundledFontPath } from '@agentic-video/fonts';
import { detectFormat, fetchAsset, importAsset, isBlockedAddress, resolveProjectAssets, type PipelineStats } from '@agentic-video/assets';

const ffmpeg = process.env['OPENVIDEO_FFMPEG'] ?? join(process.env['HOME'] ?? '', '.local/bin/ffmpeg');
let dir: string;

function ff(args: string[]): void {
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', ...args]);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ov-assets-'));
  const m = (name: string) => join(dir, 'media', name);
  mkdirSync(join(dir, 'media'));
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=64x48:d=1', '-frames:v', '1', m('a.png')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=64x48:d=1', '-frames:v', '1', m('a.jpg')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=64x48:d=1', '-frames:v', '1', m('a.webp')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=64x48:d=1', '-frames:v', '1', '-c:v', 'libaom-av1', '-still-picture', '1', m('a.avif')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=64x48:r=10:d=1', m('anim.gif')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=64x48:r=25:d=1', '-f', 'lavfi', '-i', 'sine=d=1', '-shortest', '-pix_fmt', 'yuv420p', m('a.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=64x48:r=25:d=1', '-c:v', 'libvpx-vp9', m('a.webm')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=64x48:r=25:d=1', '-c:v', 'prores_ks', m('a.mov')]);
  for (const [name, args] of [['a.wav', []], ['a.flac', []], ['a.mp3', []], ['a.m4a', ['-c:a', 'aac']], ['a.ogg', ['-c:a', 'libvorbis']]] as const) ff(['-f', 'lavfi', '-i', 'sine=d=0.5', ...args, m(name)]);
  writeFileSync(m('a.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect width="120" height="40" fill="#f50"/></svg>');
  writeFileSync(m('a.json'), JSON.stringify({ v: '5.7.0', fr: 30, ip: 0, op: 60, w: 100, h: 50, layers: [] }));
  writeFileSync(m('a.gltf'), JSON.stringify({ asset: { version: '2.0', generator: 'test' }, scenes: [{ nodes: [] }], animations: [{ name: 'spin', channels: [], samplers: [] }] }));
  const json = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' } }).padEnd(28, ' '));
  const glb = new Uint8Array(12 + 8 + json.length);
  const v = new DataView(glb.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, glb.length, true);
  v.setUint32(12, json.length, true);
  v.setUint32(16, 0x4e4f534a, true);
  glb.set(json, 20);
  writeFileSync(m('a.glb'), glb);
  writeFileSync(m('a.srt'), '1\n00:00:00,000 --> 00:00:01,000\nHello\n');
  copyFileSync(bundledFontPath('inter/InterVariable.ttf'), m('a.ttf'));
});

describe('Import aller Formate (FR-48, FR-49)', () => {
  const cases: [string, string, string][] = [
    ['a.png', 'image', 'png'],
    ['a.jpg', 'image', 'jpeg'],
    ['a.webp', 'image', 'webp'],
    ['a.avif', 'image', 'avif'],
    ['anim.gif', 'image', 'gif'],
    ['a.svg', 'svg', 'svg'],
    ['a.mp4', 'video', 'mp4'],
    ['a.webm', 'video', 'webm'],
    ['a.mov', 'video', 'mov'],
    ['a.wav', 'audio', 'wav'],
    ['a.flac', 'audio', 'flac'],
    ['a.mp3', 'audio', 'mp3'],
    ['a.m4a', 'audio', 'm4a'],
    ['a.ogg', 'audio', 'ogg'],
    ['a.gltf', 'model', 'gltf'],
    ['a.glb', 'model', 'glb'],
    ['a.ttf', 'font', 'ttf'],
    ['a.json', 'lottie', 'lottie'],
    ['a.srt', 'subtitle', 'srt'],
  ];
  for (const [file, type, format] of cases) {
    it(`importiert ${file}`, async () => {
      const project = mkdtempSync(join(tmpdir(), 'ov-proj-'));
      const r = await importAsset(project, { path: join(dir, 'media', file) }, { cache: createCache(new MemoryStore()), allowOutsidePaths: true });
      expect(r.type).toBe(type);
      expect(r.metadata['format']).toBe(format);
      expect(r.hash).toMatch(/^sha256:/u);
      expect(r.src.startsWith('assets/')).toBe(true);
      if (type === 'image' || type === 'video') expect(r.metadata['dimensions']).toEqual({ width: 64, height: 48 });
      if (type === 'video' || type === 'audio') expect(Number(r.metadata['duration'])).toBeGreaterThan(0.4);
    });
  }

  it('verarbeitet ein identisches Asset nie zweimal (FR-50)', async () => {
    const cache = createCache(new MemoryStore());
    const stats: PipelineStats = { inspected: 0, normalized: 0, fetched: 0 };
    const p1 = mkdtempSync(join(tmpdir(), 'ov-proj-'));
    const p2 = mkdtempSync(join(tmpdir(), 'ov-proj-'));
    await importAsset(p1, { path: join(dir, 'media', 'anim.gif') }, { cache, allowOutsidePaths: true, stats });
    await importAsset(p2, { path: join(dir, 'media', 'anim.gif'), fileName: 'other.gif' }, { cache, allowOutsidePaths: true, stats });
    expect(stats).toEqual({ inspected: 1, normalized: 1, fetched: 0 });
  });

  it('verbietet Pfade außerhalb des Projekts ohne Freigabe', async () => {
    const project = mkdtempSync(join(tmpdir(), 'ov-proj-'));
    await expect(importAsset(project, { path: '../../etc/passwd' }, { cache: createCache(new MemoryStore()) })).rejects.toThrow(/outside the project/u);
  });
});

describe('Resolver', () => {
  it('liefert Datensätze und frame-genaue Frames animierter GIFs', async () => {
    const project = mkdtempSync(join(tmpdir(), 'ov-proj-'));
    const cache = createCache(new MemoryStore());
    const gif = await importAsset(project, { path: join(dir, 'media', 'anim.gif'), id: 'anim' }, { cache, allowOutsidePaths: true });
    const png = await importAsset(project, { path: join(dir, 'media', 'a.png'), id: 'pic' }, { cache, allowOutsidePaths: true });
    const assets = await resolveProjectAssets(
      project,
      { assets: [{ id: gif.id, type: gif.type, src: gif.src, hash: gif.hash }, { id: png.id, type: 'image', src: png.src }, { id: 'gone', type: 'image', src: 'assets/missing.png' }] },
      { cache },
    );
    expect(assets.get('anim')?.metadata['animated']).toBe(true);
    expect(assets.get('anim')?.path.endsWith('.mkv')).toBe(true);
    const f0 = await assets.videoFrame('anim', 0);
    const f5 = await assets.videoFrame('anim', 0.5);
    expect(f0.width).toBe(64);
    expect(Buffer.from(f0.data).equals(Buffer.from(f5.data))).toBe(false);
    expect(assets.get('pic')?.dimensions).toEqual({ width: 64, height: 48 });
    expect(assets.diagnostics.map((d) => d.code)).toEqual(['OV_ASSET_MISSING']);
    await assets.close();
  });
});

describe('Kontrollierter Fetcher (FR-51, A24)', () => {
  it('blockiert interne Adressen', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) expect(isBlockedAddress(ip), ip).toBe(true);
    expect(isBlockedAddress('93.184.216.34')).toBe(false);
    await expect(fetchAsset('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/blocked/u);
    await expect(fetchAsset('http://localhost:1/x')).rejects.toThrow(/blocked/u);
    await expect(fetchAsset('file:///etc/passwd')).rejects.toThrow(/Protocol/u);
  });

  // Weiterleitungen prüft review-fixes.test.ts (A3) mit einem Server, dessen erster Hop erlaubt ist.
  it('lädt erlaubte Quellen', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    }).listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetchAsset(`http://127.0.0.1:${String(port)}/logo.svg`, { allowPrivate: true });
      expect(detectFormat('logo.svg', r.bytes)?.type).toBe('svg');
    } finally {
      server.close();
    }
  });
});
