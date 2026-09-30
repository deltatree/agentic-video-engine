/**
 * Epic 18 in der Render-Pipeline: native Frame-Hashes (18.5), Layer-Cache nur für zeitinvariante
 * Layer (18.3), Encoding parallel zum Rendern in Reihenfolge (18.6), Abbruch (18.8), Cache-Budget
 * und `missingFrames` mit animierten Bildern (18.9).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { skipUnless } from '@agentic-video/testing';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { OpenVideoError, Registry, SCHEMA_VERSION, contentHash, getNumber, parseColor, type EvaluatedNode, type RenderBackend, type RgbaImage } from '@agentic-video/core';
import { locateFfmpeg } from '@agentic-video/ffmpeg';
import { createTelemetry } from '@agentic-video/telemetry';
import {
  cacheMaxBytesFromEnv,
  createNodeEnvironment,
  encoderThreadsFor,
  imageHash,
  isTimeInvariantLayer,
  missingFrames,
  renderChunk,
  renderFrame,
  renderVideo,
  type ChunkResult,
  type ChunkRunner,
  type NodeEnvironment,
  type RenderEnvironment,
} from '@agentic-video/render';

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
        const x0 = Math.round(getNumber(n, 'x', 0));
        const x1 = Math.min(req.width, x0 + Math.round(getNumber(n, 'width', 0)));
        for (let y = 0; y < Math.min(req.height, Math.round(getNumber(n, 'height', 0))); y++)
          for (let x = Math.max(0, x0); x < x1; x++) data.set([Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255), 255], (y * req.width + x) * 4);
      }
      return Promise.resolve({ width: req.width, height: req.height, data });
    },
    dispose: () => Promise.resolve(),
  };
}

function makeEnv(counter: { calls: number }, written: RgbaImage[], aborted: { value: boolean } = { value: false }): RenderEnvironment {
  const registry = new Registry();
  registry.registerBackend(rectBackend(counter));
  return {
    registry,
    assets: { get: () => undefined, bytes: () => Promise.reject(new Error('no assets')), videoFrame: () => Promise.reject(new Error('no video')), all: () => [] },
    fonts: { all: () => [], has: () => true, fallbacks: () => [] },
    cache: createCache(new MemoryStore()),
    telemetry: createTelemetry({ serviceName: 'test', exporter: 'memory', logSink: () => undefined }),
    composite: (req) => req.layers.map((l) => (l.kind === 'image' ? l.image : undefined)).find((l) => l !== undefined) ?? { width: req.width, height: req.height, data: new Uint8Array(req.width * req.height * 4) },
    accumulate: (images) => images[0] ?? { width: 0, height: 0, data: new Uint8Array() },
    media: {
      createEncoder: (o) =>
        Promise.resolve({
          write: (img: RgbaImage) => {
            written.push(img);
            return Promise.resolve();
          },
          finish: async () => {
            const { writeFile } = await import('node:fs/promises');
            await writeFile(o.outPath, new Uint8Array([1, 2, 3]));
            return { outputs: [o.outPath], frames: written.length, encoder: 'test', args: [`threads=${String(o.threads)}`] };
          },
          abort: () => {
            aborted.value = true;
            return Promise.resolve();
          },
        }),
      info: () => Promise.resolve({ version: 'test-ffmpeg', license: 'LGPL-2.1-or-later', configuration: '', codecLicenses: {} }),
    },
    versions: { 'backend:skia': '1', 'canvaskit-wasm': 'test' },
    trusted: false,
    platform: { os: 'linux' },
  };
}

const projectWith = (nodes: unknown[], seconds = 2) => ({
  schemaVersion: SCHEMA_VERSION,
  compositions: [{ id: 'main', width: 32, height: 18, fps: 30, duration: `${String(seconds)}s`, background: 'transparent', nodes }],
});
const staticRect = { id: 's', type: 'rect', x: 2, width: 10, height: 10, fill: '#FF0000' };
const movingRect = { id: 'm', type: 'rect', width: 6, height: 6, fill: '#00FF00', x: { $keyframes: [{ t: 0, v: 0 }, { t: '2s', v: 26 }] } };

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('Frame-Hash (Story 18.5)', () => {
  it('imageHash rechnet nativ und gleicht contentHash(Kopf ‖ Pixel)', () => {
    const image: RgbaImage = { width: 3, height: 2, data: new Uint8Array(24).map((_, i) => i * 7) };
    const header = new Uint8Array(8);
    new DataView(header.buffer).setUint32(0, 3);
    new DataView(header.buffer).setUint32(4, 2);
    const joined = new Uint8Array(32);
    joined.set(header);
    joined.set(image.data, 8);
    expect(imageHash(image)).toBe(contentHash(joined));
  });
});

describe('Layer-Cache nur für zeitinvariante Layer (Story 18.3)', () => {
  const node = (type: string, props: Record<string, unknown> = {}, children: EvaluatedNode[] = []): EvaluatedNode => ({ id: type, type, props, children, time: { localFrame: 3, relFrame: 3, durationFrames: 9, progress: 0.3, compositionFrame: 3 }, pointer: '/n' });

  it('erkennt zeitinvariante Skia-Layer', () => {
    expect(isTimeInvariantLayer('skia', [node('rect'), node('group', {}, [node('text')])])).toBe(true);
    expect(isTimeInvariantLayer('skia', [node('video')])).toBe(false);
    expect(isTimeInvariantLayer('skia', [node('group', {}, [node('lottie')])])).toBe(false);
    expect(isTimeInvariantLayer('skia', [node('text', { textAnimation: { unit: 'char' } })])).toBe(false);
    expect(isTimeInvariantLayer('browser', [node('html')])).toBe(false);
  });

  it('rendert einen statischen Layer im Chunk nur einmal und schreibt ihn einmal', async () => {
    const counter = { calls: 0 };
    const env = makeEnv(counter, []);
    await renderChunk(env, projectWith([staticRect]), { compositionId: 'main', start: 0, end: 10, scale: 1, step: 1, offset: 0 });
    expect(counter.calls).toBe(1);
    expect(env.cache.stats().layer.writes).toBe(1);
  });

  it('komprimiert einen animierten Layer im Video-Render nicht bei jedem Frame', async () => {
    const counter = { calls: 0 };
    const env = makeEnv(counter, []);
    await renderChunk(env, projectWith([movingRect]), { compositionId: 'main', start: 0, end: 10, scale: 1, step: 1, offset: 0 });
    expect(counter.calls).toBe(10);
    // Nur der erste Frame (noch unbekannt, ob animiert) landet im Layer-Cache.
    expect(env.cache.stats().layer.writes).toBe(1);
    // Einzelframes (Vorschau) cachen weiterhin jeden Layer.
    const preview = makeEnv({ calls: 0 }, []);
    for (let f = 0; f < 4; f++) await renderFrame(preview, projectWith([movingRect]), { frame: f });
    expect(preview.cache.stats().layer.writes).toBe(4);
  });

  it('liefert mit Cache dieselben Pixel wie ohne', async () => {
    const env = makeEnv({ calls: 0 }, []);
    const project = projectWith([staticRect, movingRect]);
    const chunk = await renderChunk(env, project, { compositionId: 'main', start: 0, end: 6, scale: 1, step: 1, offset: 0 });
    const fresh = makeEnv({ calls: 0 }, []);
    const hashes: string[] = [];
    for (let f = 0; f < 6; f++) hashes.push(imageHash((await renderFrame(fresh, project, { frame: f, useCache: false })).image));
    expect(chunk.frameHashes).toEqual(hashes);
  });
});

describe('Encoding parallel zum Rendern (Story 18.6)', () => {
  it('schreibt Frames in Reihenfolge, auch wenn der Runner Chunks rückwärts meldet', async () => {
    const written: RgbaImage[] = [];
    const env = makeEnv({ calls: 0 }, written);
    const project = projectWith([movingRect]);
    const reversed: ChunkRunner = async (chunks, onDone) => {
      const results: ChunkResult[] = [];
      for (const c of chunks) results.push(await renderChunk(env, project, c));
      for (const r of [...results].reverse()) onDone(r);
      return results;
    };
    const r = await renderVideo(env, project, { outPath: join(tmp('ov-order-'), 'o.mp4'), profile: { format: 'mp4' }, chunkSize: 7, runChunks: reversed, noAudio: true });
    expect(written.map(imageHash)).toEqual(r.manifest.frameHashes);
  });

  it('startet den Encoder vor dem Ende des Renderns', async () => {
    const written: RgbaImage[] = [];
    const env = makeEnv({ calls: 0 }, written);
    const project = projectWith([movingRect]);
    const streaming: ChunkRunner = async (chunks, onDone) => {
      const results: ChunkResult[] = [];
      for (const c of chunks) {
        const r = await renderChunk(env, project, c);
        onDone(r);
        results.push(r);
        // Der nächste Chunk rendert erst, wenn der Encoder den vorigen schon bekommen hat.
        const deadline = Date.now() + 5000;
        while (written.length < r.end) {
          if (Date.now() > deadline) throw new Error('encoder did not receive frames while rendering');
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      return results;
    };
    const r = await renderVideo(env, project, { outPath: join(tmp('ov-stream-'), 'o.mp4'), profile: { format: 'mp4' }, chunkSize: 20, runChunks: streaming, noAudio: true, encoderThreads: 3 });
    expect(written).toHaveLength(60);
    expect(r.manifest.encoder?.args).toEqual(['threads=3']);
  });

  it('nutzt standardmäßig feste Encoder-Threads (bitgleiche Datei), auto nach freien Kernen', () => {
    expect(encoderThreadsFor(1, {}, 8)).toBe(4);
    expect(encoderThreadsFor(0, {}, 64)).toBe(4);
    expect(encoderThreadsFor(1, { OPENVIDEO_ENCODER_THREADS: 'auto' }, 8)).toBe(7);
    expect(encoderThreadsFor(8, { OPENVIDEO_ENCODER_THREADS: 'auto' }, 8)).toBe(2);
    expect(encoderThreadsFor(0, { OPENVIDEO_ENCODER_THREADS: 'auto' }, 64)).toBe(16);
    expect(encoderThreadsFor(4, { OPENVIDEO_ENCODER_THREADS: '6' }, 64)).toBe(6);
  });
});

describe('Abbruch (Story 18.8) und Cache-Budget (Story 18.9)', () => {
  it('bricht mit OV_RENDER_CANCELLED ab und verwirft die Ausgabe', async () => {
    const aborted = { value: false };
    const env = makeEnv({ calls: 0 }, [], aborted);
    const signal = { aborted: false };
    let frames = 0;
    const error = await renderVideo(env, projectWith([movingRect]), {
      outPath: join(tmp('ov-cancel-'), 'o.mp4'),
      profile: { format: 'mp4' },
      chunkSize: 5,
      noAudio: true,
      signal,
      onProgress: (p) => {
        if (p.stage === 'encode' && ++frames === 3) signal.aborted = true;
      },
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error instanceof OpenVideoError ? error.diagnostic.code : error).toBe('OV_RENDER_CANCELLED');
    expect(aborted.value).toBe(true);
  });

  it('räumt den Cache nach dem Render bis zur Obergrenze auf', async () => {
    const env = makeEnv({ calls: 0 }, []);
    await renderVideo(env, projectWith([movingRect]), { outPath: join(tmp('ov-prune-'), 'o.mp4'), profile: { format: 'mp4' }, noAudio: true, cacheMaxBytes: 0 });
    const usage = await env.cache.usage();
    expect(usage.frame.bytes + usage.layer.bytes).toBe(0);
    expect(cacheMaxBytesFromEnv({ OPENVIDEO_CACHE_MAX_BYTES: '5e9' })).toBe(5e9);
    expect(cacheMaxBytesFromEnv({ OPENVIDEO_CACHE_MAX_BYTES: '' })).toBeUndefined();
  });
});

function ffmpegPath(): string | undefined {
  try {
    return locateFfmpeg().ffmpeg;
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
}
const ffmpeg = ffmpegPath();
let gifEnv: NodeEnvironment | undefined;
afterAll(async () => {
  await gifEnv?.dispose();
});

describe('missingFrames mit animierten Bildern (Story 18.9)', () => {
  it.skipIf(skipUnless(ffmpeg !== undefined, 'FFmpeg fehlt: OPENVIDEO_FFMPEG setzen'))('meldet gerenderte Frames mit GIF nicht als fehlend', async () => {
    const dir = tmp('ov-missing-gif-');
    execFileSync(ffmpeg ?? 'ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=16x16:r=10:d=1', '-vf', "drawbox=x=0:y=0:w=16:h=16:color=blue:t=fill:enable='gte(t,0.5)'", '-loop', '0', join(dir, 'anim.gif')]);
    const project = { schemaVersion: SCHEMA_VERSION, assets: [{ id: 'anim', type: 'image', src: 'anim.gif' }], compositions: [{ id: 'main', width: 16, height: 16, fps: 10, duration: '1s', background: '#000000', nodes: [{ id: 'gif', type: 'image', asset: 'anim', width: 16, height: 16 }] }] };
    gifEnv = await createNodeEnvironment({ projectDir: dir, project, cache: createCache(new MemoryStore()), skipDefaultProviders: true });
    const frames = [0, 3, 6];
    for (const f of frames) await renderFrame(gifEnv, project, { compositionId: 'main', frame: f });
    expect(await missingFrames(gifEnv, project, 'main', frames)).toEqual([]);
    expect(await missingFrames(gifEnv, project, 'main', [9])).toEqual([9]);
  }, 60_000);
});
