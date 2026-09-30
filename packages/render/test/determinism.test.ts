/**
 * Pipeline-Determinismus (Story 22.2, Testplan R1): Dieselbe Composition ergibt dieselben
 * Frame-Hashes und dieselbe Videodatei – in zwei frischen Umgebungen ohne Cache, bei umgekehrter
 * Chunk-Reihenfolge und mit 1 gegen 3 Prozess-Workern. Kein Vergleich stützt sich auf den Cache:
 * Jeder Lauf bekommt einen eigenen, leeren Datei-Cache, und jeder Lauf muss alle Frames rendern.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { FileStore, createCache } from '@agentic-video/cache';
import { SCHEMA_VERSION } from '@agentic-video/core';
import { locateFfmpeg } from '@agentic-video/ffmpeg';
import { createNodeEnvironment, renderChunk, renderVideo, type ChunkRunner, type NodeEnvironment, type RenderVideoResult } from '@agentic-video/render';
import { createProcessChunkRunner } from '@agentic-video/scheduler';
import { createTelemetry } from '@agentic-video/telemetry';
import { skipUnless } from '@agentic-video/testing';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function has(check: () => unknown): boolean {
  try {
    return Boolean(check());
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

const ffmpegOk = has(() => locateFfmpeg());
const chromiumOk = has(() => existsSync(chromium.executablePath()));
const workerBuilt = existsSync(join(repoRoot, 'packages', 'worker', 'dist', 'bin.js'));
const FFMPEG_REASON = 'FFmpeg fehlt: OPENVIDEO_FFMPEG und OPENVIDEO_FFPROBE setzen';
const WORKER_REASON = 'Worker nicht gebaut (packages/worker/dist/bin.js): zuerst `npm run build` ausführen';
const CHROMIUM_REASON = 'Chromium für Playwright fehlt: `npx playwright install chromium` (CI installiert die gepinnte Revision)';

const FRAMES = 12;
const CHUNK = 4;
/** Feste Encoder-Threads: Die Bytes der Videodatei hängen davon ab, die Frame-Hashes nicht. */
const ENCODER_THREADS = 2;
const profile = { format: 'mp4', codec: 'h264' };

/** Skia-2D (Verlauf, Keyframes, Text) und ein Compositor-Layer (Blend Mode, Blur). */
const skiaNodes = [
  { id: 'bg', type: 'rect', width: 320, height: 180, fill: { type: 'linear', stops: [{ offset: 0, color: '#1B2A4A' }, { offset: 1, color: '#0B0D12' }], start: { x: 0, y: 0 }, end: { x: 1, y: 1 } } },
  { id: 'dot', type: 'ellipse', width: 40, height: 40, y: 20, fill: '#FF5A1F', x: { $keyframes: [{ t: 0, v: 10 }, { t: FRAMES - 1, v: 270, ease: 'easeInOutCubic' }] } },
  { id: 'title', type: 'text', text: 'Determinism', fontSize: 22, fontWeight: 700, x: 12, y: 120, fill: '#FFFFFF' },
  { id: 'glow', type: 'layer', blendMode: 'screen', opacity: 0.8, effects: [{ type: 'blur', radius: 4 }], children: [{ id: 'bar', type: 'rect', x: 12, y: 160, height: 8, cornerRadius: 4, fill: '#3DDC97', width: { $keyframes: [{ t: 0, v: 20 }, { t: FRAMES - 1, v: 296 }] } }] },
];

/** Browser-Layer (HTML/CSS) und Three.js-Layer (WebGL2 über SwiftShader). */
const browserNodes = [
  {
    id: 'scene',
    type: 'scene3d',
    width: 160,
    height: 120,
    x: 160,
    y: 30,
    backend: 'webgl2',
    camera: 'cam',
    children: [
      { id: 'cam', type: 'camera3d', position: [0, 1.2, 4], target: [0, 0, 0], fov: 45 },
      { id: 'amb', type: 'light3d', kind: 'ambient', intensity: 0.4 },
      { id: 'sun', type: 'light3d', kind: 'directional', position: [3, 5, 2], intensity: 3 },
      { id: 'box', type: 'mesh3d', geometry: { type: 'box' }, material: { color: '#7F5AF0', roughness: 0.4 }, rotation: { $keyframes: [{ t: 0, v: [0, 0, 0] }, { t: FRAMES - 1, v: [30, 120, 0] }] } },
    ],
  },
  { id: 'card', type: 'html', x: 12, y: 60, width: 140, height: 50, html: '<div class="c">HTML</div>', css: '.c{height:100%;border-radius:10px;background:linear-gradient(135deg,#7F5AF0,#2CB67D);color:#fff;font:700 24px Inter,sans-serif;padding:8px;box-sizing:border-box}' },
];

function projectWith(nodes: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    metadata: { title: 'Determinism' },
    compositions: [{ id: 'main', width: 320, height: 180, fps: 30, duration: FRAMES, background: '#0B0D12', nodes }],
  };
}

const envs: NodeEnvironment[] = [];

afterAll(async () => {
  for (const env of envs) await env.dispose();
});

/** Frische Umgebung: eigener Projektordner, eigener leerer Datei-Cache. */
async function freshEnv(project: Record<string, unknown>): Promise<{ dir: string; env: NodeEnvironment }> {
  const dir = mkdtempSync(join(tmpdir(), 'ov-determinism-'));
  const env = await createNodeEnvironment({
    projectDir: dir,
    project,
    cache: createCache(new FileStore(join(dir, '.openvideo', 'cache'))),
    telemetry: createTelemetry({ serviceName: 'determinism', exporter: 'none', logSink: () => undefined }),
  });
  envs.push(env);
  return { dir, env };
}

/** Rendert die Chunks lokal, aber in umgekehrter Reihenfolge (letzter Chunk zuerst). */
function reversedRunner(env: NodeEnvironment, project: Record<string, unknown>): ChunkRunner {
  return async (chunks, onDone) => {
    const results = [];
    for (const chunk of [...chunks].reverse()) {
      const r = await renderChunk(env, project, chunk);
      onDone(r);
      results.push(r);
    }
    return results;
  };
}

type Mode = 'local' | 'reversed' | { readonly workers: number };

async function render(project: Record<string, unknown>, mode: Mode): Promise<RenderVideoResult> {
  const { dir, env } = await freshEnv(project);
  const runChunks: ChunkRunner | undefined =
    mode === 'local'
      ? undefined
      : mode === 'reversed'
        ? reversedRunner(env, project)
        : createProcessChunkRunner({ concurrency: mode.workers, projectDir: dir, project, cache: env.cache, telemetry: env.telemetry });
  const r = await renderVideo(env, project, {
    outPath: join(dir, 'out', 'video.mp4'),
    profile,
    chunkSize: CHUNK,
    noAudio: true,
    encoderThreads: ENCODER_THREADS,
    ...(runChunks !== undefined ? { runChunks } : {}),
  });
  // Nichts aus dem Cache: Jeder Lauf rendert jeden Frame selbst.
  expect(r.manifest.cache.framesFromCache).toBe(0);
  expect(r.manifest.cache.framesRendered).toBe(FRAMES);
  expect(r.manifest.frameHashes).toHaveLength(FRAMES);
  return r;
}

function expectSame(a: RenderVideoResult, b: RenderVideoResult): void {
  expect(b.manifest.frameHashes).toEqual(a.manifest.frameHashes);
  expect(b.manifest.outputs[0]?.hash).toBe(a.manifest.outputs[0]?.hash);
  expect(b.manifest.outputs[0]?.hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
}

async function suite(project: Record<string, unknown>, withWorkers: boolean): Promise<void> {
  const first = await render(project, 'local');
  // Bewegte Inhalte: Die Frames unterscheiden sich, sonst prüft der Vergleich nichts.
  expect(new Set(first.manifest.frameHashes).size).toBe(FRAMES);
  expectSame(first, await render(project, 'local'));
  expectSame(first, await render(project, 'reversed'));
  if (!withWorkers) return;
  const one = await render(project, { workers: 1 });
  const three = await render(project, { workers: 3 });
  expect(new Set(three.manifest.chunks.map((c) => c.worker)).size).toBeGreaterThanOrEqual(2);
  expectSame(first, one);
  expectSame(one, three);
}

describe.skipIf(skipUnless(ffmpegOk, FFMPEG_REASON))('Pipeline-Determinismus (Story 22.2)', () => {
  it('Skia + Compositor: zwei frische Umgebungen, umgekehrte Chunks, 1 gegen 3 Prozess-Worker', { timeout: 180_000 }, async () => {
    await suite(projectWith(skiaNodes), !skipUnless(workerBuilt, WORKER_REASON));
  });

  it.skipIf(skipUnless(chromiumOk, CHROMIUM_REASON))('gemischt mit Browser- und Three-Layer: frische Umgebungen, umgekehrte Chunks, 1 gegen 3 Prozess-Worker', { timeout: 300_000 }, async () => {
    await suite(projectWith([...skiaNodes, ...browserNodes]), !skipUnless(workerBuilt, WORKER_REASON));
  });
});
