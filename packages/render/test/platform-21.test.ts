/**
 * Epic 21 im Render: Cache-Ebene `encoding` (21.2), Browser-GPU-Modus im Schlüssel (21.4),
 * ehrliches Manifest (21.5) sowie die Review-Befunde Q3 (fromAudio-Transkripte) und Q7
 * (Encoder-Fehler bricht Rendern ab).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, MemoryStore, createCache } from '@agentic-video/cache';
import { OpenVideoError, Registry, SCHEMA_VERSION, type AsrProvider } from '@agentic-video/core';
import { createTelemetry, type Telemetry } from '@agentic-video/telemetry';
import { skipUnless } from '@agentic-video/testing';
import {
  buildFrameManifest,
  createNodeEnvironment,
  fromAudioDeclarations,
  imageHash,
  projectUsesScene3d,
  renderChunk,
  renderFrame,
  renderVideo,
  validateFrameManifest,
  validateManifest,
  type ChunkResult,
  type ChunkRunner,
  type NodeEnvironment,
  type RenderEnvironment,
} from '@agentic-video/render';

const ffmpeg = process.env['OPENVIDEO_FFMPEG'] ?? 'ffmpeg';

const project = {
  schemaVersion: SCHEMA_VERSION,
  compositions: [
    {
      id: 'main',
      width: 64,
      height: 36,
      fps: 10,
      duration: 12,
      background: '#101010',
      nodes: [{ id: 'box', type: 'rect', width: 20, height: 20, fill: '#FF3366', x: { $keyframes: [{ t: 0, v: 0 }, { t: 11, v: 40 }] } }],
    },
  ],
};

/** Telemetrie, die Cache-Meldungen und GPU-Speicher mitschreibt. */
function recordingTelemetry(): { telemetry: Telemetry; hits: string[]; misses: string[]; gpu: (number | undefined)[] } {
  const base = createTelemetry({ serviceName: 'test', exporter: 'none', logSink: () => undefined });
  const hits: string[] = [];
  const misses: string[] = [];
  const gpu: (number | undefined)[] = [];
  const telemetry: Telemetry = {
    ...base,
    metrics: {
      ...base.metrics,
      cacheHit: (tier) => {
        hits.push(tier);
      },
      cacheMiss: (tier) => {
        misses.push(tier);
      },
      setGpuMemory: (bytes) => {
        gpu.push(bytes);
      },
    },
  };
  return { telemetry, hits, misses, gpu };
}

const MIB = 1024 * 1024;

function hasEspeak(): boolean {
  try {
    execFileSync(process.env['OPENVIDEO_ESPEAK'] ?? 'espeak-ng', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}
const espeakOk = hasEspeak();
let dir: string;
let env: NodeEnvironment;
let rec: ReturnType<typeof recordingTelemetry>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ov-platform-21-'));
  rec = recordingTelemetry();
  env = await createNodeEnvironment({
    projectDir: dir,
    project,
    cache: createCache(new FileStore(join(dir, '.openvideo', 'cache'))),
    telemetry: rec.telemetry,
    probeGpu: () => Promise.resolve({ name: 'Test GPU', source: 'nvidia-smi', memoryTotalBytes: 1024 * MIB, memoryUsedBytes: 100 * MIB }),
  });
});

afterAll(async () => {
  await env.dispose();
});

describe('Cache-Ebene encoding (Story 21.2)', () => {
  it('liefert bei wiederholtem identischem Render die Bytes aus dem Cache, bitgleich zur Direktkodierung', async () => {
    const first = await renderVideo(env, project, { outPath: join(dir, 'a.mp4'), profile: { format: 'mp4', codec: 'h264' } });
    expect(first.manifest.cache.output).toBe('miss');
    const second = await renderVideo(env, project, { outPath: join(dir, 'b.mp4'), profile: { format: 'mp4', codec: 'h264' } });
    expect(second.manifest.cache.output).toBe('hit');
    expect(second.manifest.cache.framesRendered).toBe(0);
    expect(second.manifest.frameHashes).toEqual(first.manifest.frameHashes);
    expect(second.manifest.outputs[0]?.hash).toBe(first.manifest.outputs[0]?.hash);
    expect(validateManifest(second.manifest)).toEqual([]);
    // Ohne Ausgabe-Cache (Direktkodierung) entstehen genau dieselben Bytes.
    const direct = await renderVideo(env, project, { outPath: join(dir, 'c.mp4'), profile: { format: 'mp4', codec: 'h264' }, reuseOutput: false });
    expect(direct.manifest.cache.output).toBe('off');
    expect(readFileSync(join(dir, 'c.mp4')).equals(readFileSync(join(dir, 'b.mp4')))).toBe(true);
    expect(rec.hits).toContain('encoding');
    expect(rec.misses).toContain('encoding');
  }, 120_000);

  it('ein anderes Profil trifft nicht', async () => {
    const r = await renderVideo(env, project, { outPath: join(dir, 'q.mp4'), profile: { format: 'mp4', codec: 'h264', quality: 40 } });
    expect(r.manifest.cache.output).toBe('miss');
  }, 120_000);
});

describe('Ehrliches Manifest (Story 21.5)', () => {
  it('nennt genutzte Backends, GPU, Grafik-Modus, Chromium-Begründung und CPU-Encoding', async () => {
    const r = await renderVideo(env, project, { outPath: join(dir, 'm.mp4'), profile: { format: 'mp4', codec: 'h264' }, reuseOutput: false });
    const m = r.manifest;
    // Registriert sind auch browser/three/pixi/blender; genutzt hat der Plan nur skia.
    expect(env.registry.backends.has('three')).toBe(true);
    expect(m.renderBackend).toEqual(['skia']);
    expect(m.gpu).toBe('Test GPU (1024 MiB)');
    expect(m.graphics).toMatchObject({ browserGpu: 'swiftshader', threeBackends: [] });
    expect(m.chromiumVersion).toMatchObject({ version: null });
    expect(m.encoder?.name).toBe('libx264');
    expect(m.encoder?.args.join(' ')).not.toMatch(/nvenc|vaapi|qsv|videotoolbox/u);
    expect(rec.gpu).toContain(100 * MIB);
    expect(validateManifest(m)).toEqual([]);
  }, 120_000);

  it('baut ein gültiges Kurzmanifest für Einzelbilder', async () => {
    const r = await renderFrame(env, project, { frame: 3 });
    const manifest = await buildFrameManifest(env, project, [{ frame: 3, ...r }], 1);
    expect(validateFrameManifest(manifest)).toEqual([]);
    expect(manifest.frames).toEqual([{ frame: 3, key: r.key, hash: imageHash(r.image), cached: r.cached }]);
    expect(manifest.renderBackend).toEqual(['skia']);
    expect(manifest.gpu).toBe('Test GPU (1024 MiB)');
    expect(manifest.resolution).toEqual({ width: 64, height: 36 });
  });

  it.skipIf(skipUnless(espeakOk, 'espeak-ng fehlt: apt-get install espeak-ng'))('nennt die Hashes erzeugter Stimmen (espeak-ng)', async () => {
    const voiceDir = mkdtempSync(join(tmpdir(), 'ov-voice-21-'));
    const withVoice = {
      ...project,
      audio: [{ id: 'vo', voice: { provider: 'espeak-ng', text: 'Hello' } }],
      compositions: [{ ...project.compositions[0], tracks: [{ id: 'vo-track', kind: 'audio', clips: [{ id: 'c', source: 'vo', start: 0 }] }] }],
    };
    const voiceEnv = await createNodeEnvironment({ projectDir: voiceDir, project: withVoice, cache: createCache(new MemoryStore()), skipDefaultProviders: true });
    try {
      const r = await renderVideo(voiceEnv, withVoice, { outPath: join(voiceDir, 'v.mp4'), profile: { format: 'mp4', codec: 'h264' } });
      expect(Object.keys(r.manifest.voiceHashes ?? {})).toEqual(['vo']);
      expect(r.manifest.voiceHashes?.['vo']).toMatch(/^sha256:[0-9a-f]{64}$/u);
    } finally {
      await voiceEnv.dispose();
    }
  }, 120_000);
});


describe('Browser-GPU-Modus (Story 21.4, T5)', () => {
  it('steht in Plattform und Versionen; Frame-Schlüssel trennen die Modi', async () => {
    const gpuDir = mkdtempSync(join(tmpdir(), 'ov-gpu-mode-'));
    const native = await createNodeEnvironment({ projectDir: gpuDir, project, cache: createCache(new MemoryStore()), browserGpu: true, probeGpu: () => Promise.resolve(undefined) });
    const standard = await createNodeEnvironment({ projectDir: gpuDir, project, cache: createCache(new MemoryStore()), env: {}, probeGpu: () => Promise.resolve(undefined) });
    try {
      expect(native.platform.browserGpu).toBe('native');
      expect(native.versions['browser-gpu']).toBe('native');
      expect(standard.platform.browserGpu).toBe('swiftshader');
      // Standard: Schlüssel wie bisher, ohne Eintrag für den Modus.
      expect(standard.versions['browser-gpu']).toBeUndefined();
      const a = await renderFrame(native, project, { frame: 0 });
      const b = await renderFrame(standard, project, { frame: 0 });
      expect(a.key).not.toBe(b.key);
      expect(standard.platform.gpu).toBeUndefined();
    } finally {
      await native.dispose();
      await standard.dispose();
    }
  });

  it('erkennt Projekte mit scene3d (dann prüft die Umgebung WebGPU vor dem ersten Schlüssel)', () => {
    expect(projectUsesScene3d(project)).toBe(false);
    expect(projectUsesScene3d({ compositions: [{ nodes: [{ type: 'group', children: [{ type: 'scene3d' }] }] }] })).toBe(true);
  });
});

describe('fromAudio-Transkripte (Review Q3)', () => {
  it('transkribiert erst beim Render und neu, wenn sich die Deklaration ändert', async () => {
    const asrDir = mkdtempSync(join(tmpdir(), 'ov-asr-q3-'));
    mkdirSync(join(asrDir, 'assets'));
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=1', join(asrDir, 'assets', 'voice.wav')]);
    const calls: (string | undefined)[] = [];
    const asr: AsrProvider = {
      id: 'fake-asr',
      version: () => Promise.resolve('1'),
      available: () => Promise.resolve(true),
      transcribe: (_path, options) => {
        calls.push(options?.language);
        return Promise.resolve({ cues: [{ start: 0, end: 1, text: `Hello ${options?.language ?? '?'}` }] });
      },
    };
    const registry = new Registry();
    registry.registerAsrProvider(asr);
    const withTrack = (language: string) => ({
      schemaVersion: SCHEMA_VERSION,
      assets: [{ id: 'voice', type: 'audio', src: 'assets/voice.wav' }],
      compositions: [
        {
          id: 'main',
          width: 160,
          height: 90,
          fps: 10,
          duration: 10,
          tracks: [{ id: 'subs', kind: 'subtitle', language, fromAudio: { source: 'voice', provider: 'fake-asr' } }],
          nodes: [{ id: 'caps', type: 'subtitles', track: 'subs', fontSize: 16 }],
        },
      ],
    });
    const asrEnv = await createNodeEnvironment({ projectDir: asrDir, project: withTrack('en'), registry, cache: createCache(new MemoryStore()), skipDefaultProviders: true });
    try {
      // Keine ASR beim Anlegen der Umgebung: validate, plugins.list usw. warten nicht darauf.
      expect(calls).toEqual([]);
      const en = await renderFrame(asrEnv, withTrack('en'), { frame: 0, useCache: false });
      expect(calls).toEqual(['en']);
      expect(en.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      await renderFrame(asrEnv, withTrack('en'), { frame: 1, useCache: false });
      expect(calls).toEqual(['en']);
      // Nach einem Patch (andere Sprache) darf die alte Umgebung kein veraltetes Transkript liefern.
      await renderFrame(asrEnv, withTrack('de'), { frame: 0, useCache: false });
      expect(calls).toEqual(['en', 'de']);
      expect(fromAudioDeclarations(withTrack('de'))).toEqual([{ composition: 'main', track: 'subs', fromAudio: { source: 'voice', provider: 'fake-asr' }, language: 'de' }]);
    } finally {
      await asrEnv.dispose();
    }
  }, 60_000);
});

describe('Encoder-Fehler bricht das Rendern ab (Review Q7)', () => {
  it('der Runner sieht das Abbruch-Signal, sobald die Encoder-Pumpe scheitert', async () => {
    const media = env.media;
    if (media === undefined) throw new Error('FFmpeg is required for this test.');
    const broken: RenderEnvironment = {
      ...env,
      media: {
        info: () => media.info(),
        createEncoder: () =>
          Promise.resolve({
            write: () => Promise.reject(new OpenVideoError({ code: 'OV_TEST_ENCODER_BROKEN', errorClass: 'EncodeError', problem: 'The encoder is broken on purpose.', suggestions: [] })),
            finish: () => Promise.reject(new Error('not reached')),
            abort: () => Promise.resolve(),
          }),
      },
    };
    let rendered = 0;
    const runner: ChunkRunner = async (chunks, onDone, options) => {
      const out: ChunkResult[] = [];
      for (const c of chunks) {
        if (options?.signal?.aborted === true) throw new OpenVideoError({ code: 'OV_RENDER_CANCELLED', errorClass: 'RenderError', problem: 'cancelled', suggestions: [] });
        const r = await renderChunk(broken, project, c);
        rendered++;
        onDone(r);
        out.push(r);
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return out;
    };
    const error = await renderVideo(broken, project, { outPath: join(dir, 'broken.mp4'), profile: { format: 'mp4', codec: 'h264' }, chunkSize: 1, runChunks: runner, reuseOutput: false }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpenVideoError);
    expect(error instanceof OpenVideoError ? error.diagnostic.code : '').toBe('OV_TEST_ENCODER_BROKEN');
    expect(rendered).toBeLessThan(12);
  }, 60_000);
});
