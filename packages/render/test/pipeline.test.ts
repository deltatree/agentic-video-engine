import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { Registry, SCHEMA_VERSION, getNumber, parseColor, type RenderBackend, type RgbaImage } from '@agentic-video/core';
import { createTelemetry } from '@agentic-video/telemetry';
import { inspectTimeline, missingFrames, renderFrame, renderVideo, validateManifest, type RenderEnvironment } from '@agentic-video/render';

/** Test-Backend: zeichnet Rechtecke achsenparallel mit ihrer Füllfarbe. */
function rectBackend(counter: { calls: number }): RenderBackend {
  return {
    id: 'skia',
    nodeTypes: ['rect'],
    capabilities: [],
    fusable: true,
    versions: () => ({ 'test-backend': '1' }),
    check: () => ({ supported: true, diagnostics: [] }),
    renderLayer: (req) => {
      counter.calls++;
      const data = new Uint8Array(req.width * req.height * 4);
      for (const n of req.nodes) {
        const c = parseColor(typeof n.props['fill'] === 'string' ? n.props['fill'] : '#FFFFFF');
        const x0 = Math.round(getNumber(n, 'x', 0) * req.scale);
        const y0 = Math.round(getNumber(n, 'y', 0) * req.scale);
        const x1 = Math.min(req.width, x0 + Math.round(getNumber(n, 'width', 0) * req.scale));
        const y1 = Math.min(req.height, y0 + Math.round(getNumber(n, 'height', 0) * req.scale));
        for (let y = Math.max(0, y0); y < y1; y++)
          for (let x = Math.max(0, x0); x < x1; x++) {
            const o = (y * req.width + x) * 4;
            data[o] = Math.round(c.r * c.a * 255);
            data[o + 1] = Math.round(c.g * c.a * 255);
            data[o + 2] = Math.round(c.b * c.a * 255);
            data[o + 3] = Math.round(c.a * 255);
          }
      }
      return Promise.resolve({ width: req.width, height: req.height, data });
    },
    dispose: () => Promise.resolve(),
  };
}

function over(images: readonly RgbaImage[], width: number, height: number, background: string): RgbaImage {
  const out = new Uint8Array(width * height * 4);
  const bg = parseColor(background);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = Math.round(bg.r * bg.a * 255);
    out[i + 1] = Math.round(bg.g * bg.a * 255);
    out[i + 2] = Math.round(bg.b * bg.a * 255);
    out[i + 3] = Math.round(bg.a * 255);
  }
  for (const img of images) {
    for (let i = 0; i < out.length; i += 4) {
      const a = (img.data[i + 3] ?? 0) / 255;
      for (let c = 0; c < 4; c++) out[i + c] = Math.round((img.data[i + c] ?? 0) + (out[i + c] ?? 0) * (1 - a));
    }
  }
  return { width, height, data: out };
}

function makeEnv(counter: { calls: number }, frames: RgbaImage[]): RenderEnvironment {
  const registry = new Registry();
  registry.registerBackend(rectBackend(counter));
  return {
    registry,
    assets: { get: () => undefined, bytes: () => Promise.reject(new Error('no assets')), videoFrame: () => Promise.reject(new Error('no video')), all: () => [] },
    fonts: { all: () => [], has: () => true, fallbacks: () => [] },
    cache: createCache(new MemoryStore()),
    telemetry: createTelemetry({ serviceName: 'test', exporter: 'memory', logSink: () => undefined }),
    composite: (req) => over(req.layers.map((l) => (l.kind === 'image' ? l.image : { width: req.width, height: req.height, data: new Uint8Array(req.width * req.height * 4) })), req.width, req.height, req.background),
    accumulate: (images) => images[0] ?? { width: 0, height: 0, data: new Uint8Array() },
    media: {
      createEncoder: (o) =>
        Promise.resolve({
          write: (img: RgbaImage) => {
            frames.push(img);
            return Promise.resolve();
          },
          finish: async () => {
            const { writeFile } = await import('node:fs/promises');
            await writeFile(o.outPath, new Uint8Array([1, 2, 3]));
            return { outputs: [o.outPath], frames: frames.length, encoder: 'test', args: [] };
          },
          abort: () => Promise.resolve(),
        }),
      info: () => Promise.resolve({ version: 'test-ffmpeg', license: 'LGPL-2.1-or-later', configuration: '', codecLicenses: { h264: 'GPL-2.0-or-later' } }),
    },
    versions: { 'backend:skia': '1', 'canvaskit-wasm': 'test' },
    trusted: false,
    platform: { os: 'linux' },
  };
}

const project = (tweak: boolean) => ({
  schemaVersion: SCHEMA_VERSION,
  compositions: [
    {
      id: 'main',
      width: 64,
      height: 36,
      fps: 30,
      duration: 1000,
      background: '#000000',
      markers: [{ id: 'scene2', time: 800 }],
      nodes: [
        { id: 'box', type: 'rect', width: 10, height: 10, fill: '#FF0000', x: { $keyframes: [{ t: 0, v: 0 }, { t: 60, v: 50 }] } },
        { id: 'late', type: 'rect', width: 5, height: 5, y: 20, fill: tweak ? '#00FF00' : '#0000FF', timing: { from: 800, duration: 100 } },
      ],
    },
  ],
});

describe('Render-Pipeline', () => {
  it('rendert einen Frame und nutzt danach den Cache', async () => {
    const counter = { calls: 0 };
    const env = makeEnv(counter, []);
    const a = await renderFrame(env, project(false), { frame: 30 });
    expect(a.cached).toBe(false);
    expect(Array.from(a.image.data.subarray((0 * 64 + 25) * 4, (0 * 64 + 25) * 4 + 4))).toEqual([255, 0, 0, 255]);
    const b = await renderFrame(env, project(false), { frame: 30 });
    expect(b.cached).toBe(true);
    expect(b.image.data).toEqual(a.image.data);
    expect(a.timings['compositor']).toBeGreaterThanOrEqual(0);
  });

  it('rendert nur die geänderten Frames 800–900 neu (FR-69)', async () => {
    const counter = { calls: 0 };
    const env = makeEnv(counter, []);
    const frames = Array.from({ length: 1000 }, (_, i) => i).filter((f) => f % 10 === 0);
    for (const f of frames) await renderFrame(env, project(false), { frame: f });
    const missing = await missingFrames(env, project(true), 'main', frames);
    expect(missing).toEqual(frames.filter((f) => f >= 800 && f < 900));
  });

  it('erzeugt Video und gültiges Manifest mit Frame-Hashes', async () => {
    const counter = { calls: 0 };
    const written: RgbaImage[] = [];
    const env = makeEnv(counter, written);
    const dir = mkdtempSync(join(tmpdir(), 'ov-render-'));
    const r = await renderVideo(env, project(false), { outPath: join(dir, 'out.mp4'), profile: { format: 'mp4', codec: 'h264' }, range: { start: 0, end: 90 }, chunkSize: 30 });
    expect(written).toHaveLength(90);
    expect(r.manifest.frameHashes).toHaveLength(90);
    expect(r.manifest.chunks).toHaveLength(3);
    expect(validateManifest(JSON.parse(readFileSync(r.manifestPath, 'utf8')))).toEqual([]);
    // Zweiter Lauf: alle Frames aus dem Cache, gleiche Hashes (FR-9)
    const again = await renderVideo(env, project(false), { outPath: join(dir, 'out2.mp4'), profile: { format: 'mp4' }, range: { start: 0, end: 90 }, chunkSize: 45 });
    expect(again.manifest.frameHashes).toEqual(r.manifest.frameHashes);
    expect(again.manifest.cache.framesFromCache).toBe(90);
  });

  it('rechnet Ausgabe-fps und Auflösung um', async () => {
    const written: RgbaImage[] = [];
    const env = makeEnv({ calls: 0 }, written);
    const dir = mkdtempSync(join(tmpdir(), 'ov-render-'));
    await renderVideo(env, project(false), { outPath: join(dir, 'o.mp4'), profile: { format: 'mp4', fps: 60, width: 32 }, range: { start: 0, end: 30 } });
    expect(written).toHaveLength(60);
    expect(written[0]?.width).toBe(32);
    await expect(renderVideo(env, project(false), { outPath: join(dir, 'x.mp4'), profile: { format: 'mp4', width: 32, height: 32 } })).rejects.toThrow(/aspect ratio/u);
  });

  it('beschreibt die Timeline', () => {
    const t = inspectTimeline(project(false), 'main');
    expect(t.durationSmpte).toBe('00:00:33:10');
    expect(t.nodes.find((n) => n.id === 'late')).toMatchObject({ start: 800, end: 900 });
    expect(t.nodes.find((n) => n.id === 'box')?.animated[0]).toEqual({ property: 'x', kind: 'keyframes', keyframes: [0, 60] });
  });
});
