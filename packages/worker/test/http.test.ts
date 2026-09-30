import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, createCache } from '@agentic-video/cache';
import { SCHEMA_VERSION, sha256Hex } from '@agentic-video/core';
import { createNodeEnvironment, renderVideo, type NodeEnvironment } from '@agentic-video/render';
import { createRemoteChunkRunner, inputKey, startCoordinator, type Coordinator } from '@agentic-video/scheduler';
import { createTelemetry } from '@agentic-video/telemetry';
import { runWorkerHttp } from '@agentic-video/worker';

const project = {
  schemaVersion: SCHEMA_VERSION,
  metadata: { title: 'Remote' },
  compositions: [
    {
      id: 'main',
      width: 320,
      height: 180,
      fps: 30,
      duration: '3s',
      background: '#101418',
      nodes: [
        { id: 'bg', type: 'rect', width: 320, height: 180, fill: '#1B2A4A' },
        { id: 'dot', type: 'ellipse', width: 40, height: 40, y: 70, fill: '#FF5A1F', x: { $keyframes: [{ t: 0, v: 10 }, { t: '3s', v: 270 }] } },
      ],
    },
  ],
};
const profile = { format: 'mp4', codec: 'h264' };
const quiet = () => createTelemetry({ serviceName: 'test', exporter: 'none', logSink: () => undefined });
const envs: NodeEnvironment[] = [];
let reference: readonly string[];

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function envFor(dir: string, store: FileStore, telemetry = quiet()): Promise<NodeEnvironment> {
  const env = await createNodeEnvironment({ projectDir: dir, project, cache: createCache(store), telemetry });
  envs.push(env);
  return env;
}

beforeAll(async () => {
  const dir = tmp('ov-remote-ref-');
  const env = await envFor(dir, new FileStore(join(dir, 'cache')));
  reference = (await renderVideo(env, project, { outPath: join(dir, 'out', 'ref.mp4'), profile, chunkSize: 10, noAudio: true })).manifest.frameHashes;
});

afterAll(async () => {
  for (const env of envs) await env.dispose();
});

describe('Koordinator und HTTP-Worker (Story 10.3)', () => {
  it('zwei Worker rendern alle Chunks, auch über einen Neustart des Koordinators; /v1/queue und /metrics antworten', async () => {
    const dir = tmp('ov-remote-');
    const store = new FileStore(join(dir, 'shared'));
    const journalDir = join(dir, 'journal');
    const token = 'secret-token-0123456789abcdef';
    const first = await startCoordinator({ port: 0, host: '127.0.0.1', store, journalDir, token, leaseSeconds: 10 });
    let current: Coordinator = first;
    const stop = new AbortController();
    const workers = ['w1', 'w2'].map((name) => runWorkerHttp({ coordinatorUrl: first.url, token, store, worker: name, signal: stop.signal, pollIntervalMs: 50, telemetry: quiet() }));
    const lines: string[] = [];
    const telemetry = createTelemetry({ serviceName: 'caller', exporter: 'memory', logSink: (l) => lines.push(l) });
    const env = await envFor(dir, store, telemetry);
    let restart: Promise<void> | undefined;
    const runChunks = createRemoteChunkRunner({ coordinatorUrl: first.url, token, store, projectDir: join(dir, 'project-src'), project, pollIntervalMs: 50, telemetry });
    // Projektordner ohne Dateien: das IR reicht für dieses Projekt.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'project-src'));
    let doneBeforeRestart = 0;
    const traceId = await telemetry.withSpan('job', {}, async (span) => {
      const r = await renderVideo(env, project, {
        outPath: join(dir, 'out', 'remote.mp4'),
        profile,
        chunkSize: 10,
        noAudio: true,
        runChunks,
        onProgress: (p) => {
          if (p.stage === 'render' && restart === undefined) {
            doneBeforeRestart = p.done;
            restart = (async () => {
              await first.close();
              current = await startCoordinator({ port: first.port, host: '127.0.0.1', store, journalDir, token, leaseSeconds: 10 });
            })();
          }
        },
      });
      expect(r.manifest.frameHashes).toEqual(reference);
      expect(new Set(r.manifest.chunks.map((c) => c.worker))).toEqual(new Set(['w1', 'w2']));
      return span.spanContext().traceId;
    });
    await restart;
    expect(doneBeforeRestart).toBeLessThan(90);
    expect(current).not.toBe(first);

    const auth = { authorization: `Bearer ${token}` };
    const queue = (await (await fetch(`${current.url}/v1/queue`, { headers: auth })).json()) as Record<string, unknown>;
    expect(queue).toEqual({ queueLength: 0, leasesActive: 0, jobsRunning: 0 });
    expect((await fetch(`${current.url}/v1/queue`)).status).toBe(401);
    const metrics = await (await fetch(`${current.url}/metrics`)).text();
    expect(metrics).toMatch(/^openvideo_queue_length 0$/m);
    expect(metrics).toMatch(/^openvideo_leases_active 0$/m);
    expect(metrics).toMatch(/^openvideo_chunks_failed_total \d+$/m);

    expect(new Set(telemetry.finishedSpans().map((s) => s.spanContext().traceId))).toEqual(new Set([traceId]));
    stop.abort();
    const summaries = await Promise.all(workers);
    expect(summaries.reduce((n, s) => n + s.completed, 0)).toBeGreaterThanOrEqual(9);
    await current.close();
  });

  it('vergibt abgelaufene Leases neu und nimmt beim Beenden (SIGTERM) den laufenden Chunk zurück', async () => {
    const dir = tmp('ov-lease-');
    const store = new FileStore(join(dir, 'shared'));
    // Injizierte Uhr statt Schlaf (Story 22.4): Der Test stellt die Zeit selbst vor.
    let clock = 1_000_000;
    const coordinator = await startCoordinator({ port: 0, host: '127.0.0.1', store, journalDir: join(dir, 'journal'), leaseSeconds: 1, now: () => clock });
    const post = (path: string, body: unknown) => fetch(`${coordinator.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const queue = async () => (await (await fetch(`${coordinator.url}/v1/queue`)).json()) as { queueLength: number; leasesActive: number };
    const submitted = (await (await post('/v1/jobs', { project, files: [], chunks: [{ compositionId: 'main', start: 0, end: 90, scale: 1, step: 1, offset: 0 }] })).json()) as { jobId: string };

    // Lease ohne Heartbeat läuft ab und steht danach wieder in der Warteschlange.
    expect((await post('/v1/lease', { worker: 'silent' })).status).toBe(200);
    expect(await queue()).toMatchObject({ queueLength: 0, leasesActive: 1 });
    clock += 999;
    expect(await queue()).toMatchObject({ queueLength: 0, leasesActive: 1 });
    clock += 301;
    expect(await queue()).toMatchObject({ queueLength: 1, leasesActive: 0 });

    // Worker beginnt zu rendern und wird abgebrochen: der Chunk geht ohne Fehlversuch zurück.
    const stop = new AbortController();
    const worker = runWorkerHttp({ coordinatorUrl: coordinator.url, store, worker: 'w', signal: stop.signal, pollIntervalMs: 50, telemetry: quiet() });
    // Der Worker rendert, sobald er die Lease hält: Abbruch mitten im Chunk (90 Frames).
    await expect.poll(async () => (await queue()).leasesActive, { timeout: 30_000, interval: 20 }).toBe(1);
    stop.abort();
    const summary = await worker;
    expect(summary).toMatchObject({ released: 1, completed: 0 });
    const status = (await (await fetch(`${coordinator.url}/v1/jobs/${submitted.jobId}`)).json()) as { chunks: { state: string; attempts: number }[] };
    expect(status.chunks[0]).toMatchObject({ state: 'queued', attempts: 1 });
    await coordinator.close();
  });

  it('schreibt Frames nur unter jobs/<jobId>/frames/ und prüft den Hash der Eingaben (Story 16.2)', async () => {
    const dir = tmp('ov-jobkeys-');
    const store = new FileStore(join(dir, 'shared'));
    const coordinator = await startCoordinator({ port: 0, host: '127.0.0.1', store, journalDir: join(dir, 'journal'), leaseSeconds: 10 });
    const post = (path: string, body: unknown) => fetch(`${coordinator.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const status = async (jobId: string) => (await (await fetch(`${coordinator.url}/v1/jobs/${jobId}`)).json()) as { state: string; chunks: { state: string; result?: { keys: string[] } }[]; diagnostics: { code: string }[] };
    let stop = new AbortController();
    let worker = runWorkerHttp({ coordinatorUrl: coordinator.url, store, worker: 'w', signal: stop.signal, pollIntervalMs: 20, telemetry: quiet() });
    try {
      const good = (await (await post('/v1/jobs', { project, files: [], chunks: [{ compositionId: 'main', start: 0, end: 3, scale: 1, step: 1, offset: 0 }] })).json()) as { jobId: string };
      await expect.poll(async () => (await status(good.jobId)).state, { timeout: 30_000 }).toBe('done');
      const keys = (await status(good.jobId)).chunks[0]?.result?.keys ?? [];
      expect(keys).toHaveLength(3);
      for (const key of keys) expect(key).toMatch(new RegExp(`^jobs/${good.jobId}/frames/[0-9a-f]{64}$`, 'u'));

      // Ein manipuliertes Projekt im Speicher: der Worker rendert es nicht. Erst manipulieren, dann einen Worker starten.
      stop.abort();
      await worker;
      const other = { ...project, metadata: { title: 'Tampered' } };
      const submitted = (await (await post('/v1/jobs', { project: other, files: [], chunks: [{ compositionId: 'main', start: 0, end: 1, scale: 1, step: 1, offset: 0 }] })).json()) as { jobId: string };
      await store.put(inputKey(sha256Hex(new TextEncoder().encode(JSON.stringify(other)))), new TextEncoder().encode(JSON.stringify({ ...project, metadata: { title: 'Evil' } })));
      stop = new AbortController();
      worker = runWorkerHttp({ coordinatorUrl: coordinator.url, store, worker: 'w2', signal: stop.signal, pollIntervalMs: 20, telemetry: quiet() });
      await expect.poll(async () => (await status(submitted.jobId)).diagnostics.map((d) => d.code), { timeout: 30_000 }).toContain('OV_SCHEDULER_CONTENT_MISMATCH');
    } finally {
      stop.abort();
      await worker;
      await coordinator.close();
    }
  }, 60_000);
});
