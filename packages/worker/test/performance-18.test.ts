/**
 * Epic 18 im Worker: Abbruch auf Chunk-Ebene über stdio (`cancel`) und über eine verlorene Lease
 * (Story 18.8), sowie Befund M4 (vergiftete Frame-Schlüssel blockieren den Job nicht).
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { FileStore, createCache } from '@agentic-video/cache';
import { SCHEMA_VERSION } from '@agentic-video/core';
import { encodeRawFrameAsync } from '@agentic-video/png';
import { createNodeEnvironment, renderFrame, type NodeEnvironment } from '@agentic-video/render';
import { MessageDecoder, digestHex, encodeMessage, jobFrameKey, startCoordinator, type ProtocolMessage } from '@agentic-video/scheduler';
import { createTelemetry } from '@agentic-video/telemetry';
import { runWorkerHttp, runWorkerStdio } from '@agentic-video/worker';

const project = {
  schemaVersion: SCHEMA_VERSION,
  compositions: [
    {
      id: 'main',
      width: 320,
      height: 180,
      fps: 30,
      duration: '20s',
      background: '#101418',
      nodes: [{ id: 'dot', type: 'ellipse', width: 40, height: 40, y: 70, fill: '#FF5A1F', x: { $keyframes: [{ t: 0, v: 10 }, { t: '20s', v: 270 }] } }],
    },
  ],
};
const quiet = () => createTelemetry({ serviceName: 'test', exporter: 'none', logSink: () => undefined });
const envs: NodeEnvironment[] = [];
afterAll(async () => {
  for (const env of envs) await env.dispose();
});

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('stdio-Worker: cancel (Story 18.8)', () => {
  it('bricht einen laufenden Chunk nach cancel ab und meldet OV_RENDER_CANCELLED', async () => {
    const dir = tmp('ov-stdio-cancel-');
    const input = new PassThrough();
    const output = new PassThrough();
    const decoder = new MessageDecoder();
    const messages: ProtocolMessage[] = [];
    output.on('data', (chunk: Buffer) => {
      messages.push(...decoder.push(chunk));
    });
    const done = runWorkerStdio({ input, output });
    input.write(encodeMessage({ type: 'init', mode: 'shared', worker: 'w', project, projectDir: dir, cacheDir: join(dir, 'cache'), options: {} }));
    input.write(encodeMessage({ type: 'chunk', id: 'w/1', request: { compositionId: 'main', start: 0, end: 600, scale: 1, step: 1, offset: 0 } }));
    await expect.poll(() => messages.some((m) => m.type === 'log' && m.line.includes('worker ready')), { timeout: 30_000 }).toBe(true);
    const started = Date.now();
    input.write(encodeMessage({ type: 'cancel', id: 'w/1' }));
    await expect.poll(() => messages.find((m) => m.type === 'error' || m.type === 'result'), { timeout: 20_000 }).toBeDefined();
    const answer = messages.find((m) => m.type === 'error' || m.type === 'result');
    expect(answer?.type).toBe('error');
    expect(answer?.type === 'error' ? answer.diagnostic.code : '').toBe('OV_RENDER_CANCELLED');
    expect(Date.now() - started).toBeLessThan(10_000);
    input.end(encodeMessage({ type: 'shutdown' }));
    await done;
  }, 60_000);
});

describe('HTTP-Worker (Story 18.8, Befund M4)', () => {
  it('überschreibt einen vorab vergifteten Frame-Schlüssel; der Job wird fertig', async () => {
    const dir = tmp('ov-poison-');
    const store = new FileStore(join(dir, 'shared'));
    const coordinator = await startCoordinator({ port: 0, host: '127.0.0.1', store, journalDir: join(dir, 'journal'), leaseSeconds: 10 });
    const post = (path: string, body: unknown) => fetch(`${coordinator.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    try {
      // Den ehrlichen Frame 0 vorab berechnen (deterministisch) und seinen Schlüssel vergiften.
      const env = await createNodeEnvironment({ projectDir: tmp('ov-poison-ref-'), project, cache: createCache(new FileStore(join(dir, 'ref-cache'))), telemetry: quiet() });
      envs.push(env);
      const honest = await encodeRawFrameAsync((await renderFrame(env, project, { compositionId: 'main', frame: 0, useCache: false })).image);
      const submitted: unknown = await (await post('/v1/jobs', { project, files: [], chunks: [{ compositionId: 'main', start: 0, end: 1, scale: 1, step: 1, offset: 0 }] })).json();
      const jobId = typeof submitted === 'object' && submitted !== null && 'jobId' in submitted && typeof submitted.jobId === 'string' ? submitted.jobId : '';
      const key = jobFrameKey(jobId, digestHex(honest));
      await store.put(key, new TextEncoder().encode('poison'));
      const stop = new AbortController();
      const worker = runWorkerHttp({ coordinatorUrl: coordinator.url, store, worker: 'w', signal: stop.signal, pollIntervalMs: 20, telemetry: quiet() });
      const state = async (): Promise<unknown> => {
        const s: unknown = await (await fetch(`${coordinator.url}/v1/jobs/${jobId}`)).json();
        return typeof s === 'object' && s !== null && 'state' in s ? s.state : undefined;
      };
      await expect.poll(state, { timeout: 30_000 }).toBe('done');
      stop.abort();
      await worker;
      const stored = await store.get(key);
      expect(stored !== undefined && digestHex(stored) === digestHex(honest)).toBe(true);
    } finally {
      await coordinator.close();
    }
  }, 60_000);

  it('hört auf zu rendern, sobald die Lease verloren ist (Job abgebrochen)', async () => {
    const dir = tmp('ov-lost-');
    const store = new FileStore(join(dir, 'shared'));
    const coordinator = await startCoordinator({ port: 0, host: '127.0.0.1', store, journalDir: join(dir, 'journal'), leaseSeconds: 3 });
    const stop = new AbortController();
    try {
      const res = await fetch(`${coordinator.url}/v1/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project, files: [], chunks: [{ compositionId: 'main', start: 0, end: 600, scale: 1, step: 1, offset: 0 }] }) });
      const body: unknown = await res.json();
      const jobId = typeof body === 'object' && body !== null && 'jobId' in body && typeof body.jobId === 'string' ? body.jobId : '';
      const logs: string[] = [];
      const worker = runWorkerHttp({ coordinatorUrl: coordinator.url, store, worker: 'w', signal: stop.signal, pollIntervalMs: 20, telemetry: createTelemetry({ serviceName: 'test', exporter: 'none', logSink: (l) => logs.push(l) }) });
      // Warten, bis der Chunk vergeben ist, dann abbrechen.
      await expect.poll(async () => {
        const s: unknown = await (await fetch(`${coordinator.url}/v1/jobs/${jobId}`)).json();
        return JSON.stringify(s).includes('"leased"');
      }, { timeout: 30_000 }).toBe(true);
      const cancelledAt = Date.now();
      expect((await fetch(`${coordinator.url}/v1/jobs/${jobId}`, { method: 'DELETE' })).status).toBe(200);
      // Der Worker gibt den Chunk auf, lange bevor 600 Frames fertig wären (Sperre statt fester Wartezeit, Story 22.4).
      await expect.poll(() => logs.some((l) => l.includes('chunk abandoned after losing the lease')), { timeout: 20_000 }).toBe(true);
      stop.abort();
      const summary = await worker;
      expect(summary.completed).toBe(0);
      expect(summary.rejected).toBe(1);
      expect(Date.now() - cancelledAt).toBeLessThan(15_000);
    } finally {
      stop.abort();
      await coordinator.close();
    }
  }, 60_000);
});
