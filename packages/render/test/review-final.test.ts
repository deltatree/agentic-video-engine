/**
 * Abschließendes Review (2026-09-30): Schlüssel der Cache-Ebene `encoding` aus den Frame-Schlüsseln
 * aller Ausgabe-Frames (M1), Runner-Fingerabdruck (M2), Transkripte je Deklarationsstand (m1),
 * Plugin-Code und HTML-Skripte in den Versionen (m2), Hardware-Wahl (m3) und Negativtests (m5).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, createCache, type Cache } from '@agentic-video/cache';
import { Registry, SCHEMA_VERSION, evaluateScene, type AsrProvider } from '@agentic-video/core';
import { createNodeEnvironment, describeChunkRunner, hostCodeVersions, renderChunk, renderVideo, type ChunkResult, type ChunkRunner, type NodeEnvironment, type RenderEnvironment, type RenderVideoOptions } from '@agentic-video/render';

const ffmpeg = process.env['OPENVIDEO_FFMPEG'] ?? 'ffmpeg';

const project = {
  schemaVersion: SCHEMA_VERSION,
  compositions: [
    {
      id: 'main',
      width: 64,
      height: 36,
      fps: 10,
      duration: 6,
      background: '#101010',
      nodes: [{ id: 'box', type: 'rect', width: 20, height: 20, fill: '#33AAFF', x: { $keyframes: [{ t: 0, v: 0 }, { t: 5, v: 40 }] } }],
    },
  ],
};

let root: string;
let cache: Cache;
let env: NodeEnvironment;
let n = 0;

function out(): string {
  return join(root, 'out', `v${String(++n)}.mp4`);
}

async function render(e: RenderEnvironment, p: Readonly<Record<string, unknown>>, options: Partial<RenderVideoOptions> = {}): Promise<'hit' | 'miss' | 'off'> {
  const r = await renderVideo(e, p, { outPath: out(), profile: { format: 'mp4', codec: 'h264' }, ...options });
  const state = r.manifest.cache.output;
  if (state === undefined) throw new Error('The manifest does not report cache.output.');
  return state;
}

/** Runner, der im eigenen Prozess rendert (wie ein Worker derselben Installation). */
function inProcess(e: RenderEnvironment, p: Readonly<Record<string, unknown>>): ChunkRunner {
  return async (chunks, onDone) => {
    const results: ChunkResult[] = [];
    for (const c of chunks) {
      const r = await renderChunk(e, p, c);
      onDone(r);
      results.push(r);
    }
    return results;
  };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'ov-review-final-'));
  cache = createCache(new FileStore(join(root, 'cache')));
  env = await createNodeEnvironment({ projectDir: root, project, cache, skipDefaultProviders: true });
  // Ausgangslage: einmal kodiert, danach ein Treffer.
  expect(await render(env, project)).toBe('miss');
  expect(await render(env, project)).toBe('hit');
}, 120_000);

afterAll(async () => {
  await env.dispose();
});

describe('Ebene encoding: Negativtests (Review m5)', () => {
  it('andere Font-Hashes treffen nicht', async () => {
    const fonts = env.fonts;
    const other: RenderEnvironment = { ...env, fonts: { ...fonts, all: () => [...fonts.all(), { family: 'Other', weight: 400, style: 'normal', hash: 'feedbeef', path: 'x.ttf', bytes: new Uint8Array([1]), variable: false }] } };
    expect(await render(other, project)).toBe('miss');
  }, 60_000);

  it('andere Versionen treffen nicht', async () => {
    expect(await render({ ...env, versions: { ...env.versions, compositor: 'openvideo-compositor-test' } }, project)).toBe('miss');
  }, 60_000);

  it('andere Encoder-Threads treffen nicht', async () => {
    expect(await render(env, project, { encoderThreads: 3 })).toBe('miss');
    expect(await render(env, project, { encoderThreads: 3 })).toBe('hit');
  }, 60_000);

  it('eine andere Tonspur trifft nicht', async () => {
    const tone = (freq: number): RenderEnvironment => ({
      ...env,
      audio: {
        renderComposition: (input) => {
          execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=f=${String(freq)}:d=0.6`, input.outPath]);
          return Promise.resolve({ path: input.outPath, durationSeconds: 0.6 });
        },
      },
    });
    expect(await render(tone(440), project)).toBe('miss');
    expect(await render(tone(440), project)).toBe('hit');
    expect(await render(tone(880), project)).toBe('miss');
  }, 60_000);

  it('der Runner steht im Schlüssel; unbeschriebene Runner nutzen den Ausgabe-Cache nicht (Review M2)', async () => {
    const docker = (image: string, gpus: string | null) => describeChunkRunner(inProcess(env, project), { kind: 'docker', image, gpus, browserGpu: false });
    expect(await render(env, project, { runChunks: docker('openvideo/worker:a', null) })).toBe('miss');
    expect(await render(env, project, { runChunks: docker('openvideo/worker:a', null) })).toBe('hit');
    expect(await render(env, project, { runChunks: docker('openvideo/worker:b', null) })).toBe('miss');
    expect(await render(env, project, { runChunks: docker('openvideo/worker:a', 'all') })).toBe('miss');
    expect(await render(env, project, { runChunks: inProcess(env, project) })).toBe('off');
    expect(await render(env, project, { runChunks: describeChunkRunner(inProcess(env, project), null) })).toBe('off');
  }, 120_000);

  it('hardware ≠ none: die verfügbaren Hardware-Encoder (tatsächliche Wahl) stehen im Schlüssel (Review m3)', async () => {
    const media = env.media;
    if (media === undefined) throw new Error('FFmpeg is required for this test.');
    const withHardware = (nvenc: boolean): RenderEnvironment => ({
      ...env,
      media: { createEncoder: (o) => media.createEncoder(o), info: () => media.info(), hardwareEncoders: () => Promise.resolve({ nvenc, vaapi: false, qsv: false, videotoolbox: false }) },
    });
    const profile = { format: 'mp4', codec: 'h264', hardwareAcceleration: 'auto' };
    expect(await render(withHardware(false), project, { profile })).toBe('miss');
    expect(await render(withHardware(false), project, { profile })).toBe('hit');
    // Auf einer Maschine mit NVENC wählte `auto` h264_nvenc: kein Treffer mit den libx264-Bytes.
    expect(await render(withHardware(true), project, { profile })).toBe('miss');
    // Ohne Auskunft über die Hardware kein Ausgabe-Cache.
    expect(await render({ ...env, media: { createEncoder: (o) => media.createEncoder(o), info: () => media.info() } }, project, { profile })).toBe('off');
  }, 120_000);
});

describe('Plugin-Code und HTML-Skripte in den Versionen (Review m2)', () => {
  function pluginProject(dir: string, code: string): Record<string, unknown> {
    mkdirSync(join(dir, 'plugins'), { recursive: true });
    writeFileSync(join(dir, 'plugins', 'p.mjs'), code);
    return { ...project, settings: { plugins: ['./plugins/p.mjs'] } };
  }

  it('gleicher Plugin-Name und gleiche Version, anderer Code: anderer Schlüssel', async () => {
    const a = mkdtempSync(join(tmpdir(), 'ov-plugin-code-a-'));
    const b = mkdtempSync(join(tmpdir(), 'ov-plugin-code-b-'));
    const pa = pluginProject(a, "export default { name: 'same', version: '1.0.0', permissions: [], setup() {} };\n");
    const pb = pluginProject(b, "export default { name: 'same', version: '1.0.0', permissions: [], setup() { /* anderer Code */ } };\n");
    const envA = await createNodeEnvironment({ projectDir: a, project: pa, cache, skipDefaultProviders: true, plugins: { load: true, permissions: [] }, env: {} });
    const envB = await createNodeEnvironment({ projectDir: b, project: pb, cache, skipDefaultProviders: true, plugins: { load: true, permissions: [] }, env: {} });
    try {
      expect(envA.versions['plugin:same']).toBe('1.0.0');
      expect(envA.versions['plugin-code:same']).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(envB.versions['plugin-code:same']).not.toBe(envA.versions['plugin-code:same']);
      // Auch jeder Layer-Schlüssel trägt den Plugin-Code.
      expect(hostCodeVersions(envA.versions)).toEqual({ 'plugin-code:same': envA.versions['plugin-code:same'] });
      expect(await render(envA, pa)).toBe('miss');
      expect(await render(envA, pa)).toBe('hit');
      expect(await render(envB, pb)).toBe('miss');
    } finally {
      await envA.dispose();
      await envB.dispose();
    }
  }, 120_000);

  it('ohne Plugins und Skripte bleiben die Versionen (Standard-Schlüssel) unverändert', () => {
    expect(hostCodeVersions(env.versions)).toBeUndefined();
    expect(env.versions['html-scripts']).toBeUndefined();
  });

  it('freigegebene HTML-Skripte ergeben einen anderen Schlüssel', async () => {
    const scripts = await createNodeEnvironment({ projectDir: root, project, cache, skipDefaultProviders: true, allowHtmlScripts: true });
    try {
      expect(scripts.versions['html-scripts']).toBe('allowed');
      expect(hostCodeVersions(scripts.versions)).toEqual({ 'html-scripts': 'allowed' });
      expect(await render(scripts, project)).toBe('miss');
    } finally {
      await scripts.dispose();
    }
  }, 60_000);
});

describe('fromAudio-Transkripte (Review M1, m1)', () => {
  function asrProject(language: string): Record<string, unknown> {
    return {
      schemaVersion: SCHEMA_VERSION,
      assets: [{ id: 'voice', type: 'audio', src: 'assets/voice.wav' }],
      compositions: [
        {
          id: 'main',
          width: 160,
          height: 90,
          fps: 10,
          duration: 4,
          tracks: [{ id: 'subs', kind: 'subtitle', language, fromAudio: { source: 'voice', provider: 'fake-asr' } }],
          nodes: [{ id: 'caps', type: 'subtitles', track: 'subs', fontSize: 16 }],
        },
      ],
    };
  }

  function asr(version: string, text: string, calls: string[] = []): Registry {
    const provider: AsrProvider = {
      id: 'fake-asr',
      version: () => Promise.resolve(version),
      available: () => Promise.resolve(true),
      transcribe: (_path, options) => {
        calls.push(options?.language ?? '?');
        return Promise.resolve({ cues: [{ start: 0, end: 1, text: `${text} ${options?.language ?? '?'}` }] });
      },
    };
    const registry = new Registry();
    registry.registerAsrProvider(provider);
    return registry;
  }

  function asrDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ov-review-asr-'));
    mkdirSync(join(dir, 'assets'));
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=1', join(dir, 'assets', 'voice.wav')]);
    return dir;
  }

  /** Ausgewertete Szene als Text (die Cues stehen in `spans` der `rich-text`-Nodes). */
  function texts(e: RenderEnvironment, p: Readonly<Record<string, unknown>>): string[] {
    const json = JSON.stringify(evaluateScene(p, 'main', 0, { registry: e.registry }).nodes);
    return [[...json.matchAll(/"text":"([^"]*)"/gu)].map((m) => m[1] ?? '').join('')];
  }

  it('ein anderes Transkript (anderes ASR-Modell) trifft den Ausgabe-Cache nicht (M1)', async () => {
    const dir = asrDir();
    const p = asrProject('en');
    const shared = createCache(new FileStore(join(dir, 'cache')));
    const v1 = await createNodeEnvironment({ projectDir: dir, project: p, registry: asr('1', 'Alpha'), cache: shared, skipDefaultProviders: true });
    const v2 = await createNodeEnvironment({ projectDir: dir, project: p, registry: asr('2', 'Beta'), cache: shared, skipDefaultProviders: true });
    try {
      expect(await render(v1, p)).toBe('miss');
      expect(await render(v1, p)).toBe('hit');
      // Projekt, Assets und Versionen gleich – nur der Untertiteltext der Frames ist anders.
      expect(await render(v2, p)).toBe('miss');
      expect(texts(v2, p).join(' ')).toContain('Beta en');
    } finally {
      await v1.dispose();
      await v2.dispose();
    }
  }, 120_000);

  it('jede Auswertung liest das Transkript ihres eigenen Projektstands (m1)', async () => {
    const dir = asrDir();
    const calls: string[] = [];
    const en = asrProject('en');
    const de = asrProject('de');
    const e = await createNodeEnvironment({ projectDir: dir, project: en, registry: asr('1', 'Hello', calls), cache: createCache(new FileStore(join(dir, 'cache'))), skipDefaultProviders: true });
    try {
      // Beide Stände parallel vorbereitet (z. B. zwei Anfragen an denselben Dienst).
      await Promise.all([e.prepare?.(en), e.prepare?.(de)]);
      expect(texts(e, en).join(' ')).toContain('Hello en');
      expect(texts(e, de).join(' ')).toContain('Hello de');
      // Zurück zum ersten Stand: kein neues Transkribieren, kein fremdes Transkript.
      await e.prepare?.(en);
      expect(texts(e, en).join(' ')).toContain('Hello en');
      expect([...calls].sort()).toEqual(['de', 'en']);
    } finally {
      await e.dispose();
    }
  }, 60_000);
});
