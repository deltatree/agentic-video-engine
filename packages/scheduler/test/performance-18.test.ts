/**
 * Epic 18 im Scheduler: Abbruch und Timeout auf Chunk-Ebene (18.8), Standard-Parallelität (18.7),
 * native Hashes (18.5) und die Review-Befunde M5, m7, m8 am Koordinator.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileStore, MemoryStore, createCache } from '@agentic-video/cache';
import { OpenVideoError, sha256Hex } from '@agentic-video/core';
import type { ChunkRequest } from '@agentic-video/render';
import {
  MessageDecoder,
  DEFAULT_CANCEL_GRACE_MS,
  createRemoteChunkRunner,
  defaultWorkerCount,
  digestHex,
  encodeMessage,
  inputKey,
  isLease,
  runPool,
  startCoordinator,
  type Coordinator,
  type Lease,
  type PoolOptions,
} from '@agentic-video/scheduler';
import { createTelemetry } from '@agentic-video/telemetry';

const FAKE_WORKER = fileURLToPath(new URL('./fake-worker.ts', import.meta.url));
const chunk = (start: number, end: number): ChunkRequest => ({ compositionId: 'main', start, end, scale: 1, step: 1, offset: 0 });
const telemetry = createTelemetry({ serviceName: 'test', exporter: 'none', logSink: () => undefined });

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function poolOptions(mode: string, log: string, extra: Partial<PoolOptions> = {}): PoolOptions {
  return {
    concurrency: 1,
    maxAttempts: 2,
    telemetry,
    cache: createCache(new MemoryStore()),
    launch: (slot, generation) => ({ id: `fake-${String(slot)}.${String(generation)}`, command: process.execPath, args: ['--experimental-strip-types', '--no-warnings', FAKE_WORKER, mode, log, '--stdio'] }),
    init: (worker) => ({ type: 'init', mode: 'shared', worker, project: {}, projectDir: '/nonexistent', cacheDir: '/nonexistent', options: {} }),
    ...extra,
  };
}

async function failure(p: Promise<unknown>): Promise<OpenVideoError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof OpenVideoError) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('Protokoll: cancel (Story 18.8)', () => {
  it('kodiert und dekodiert cancel', () => {
    const [m] = new MessageDecoder().push(encodeMessage({ type: 'cancel', id: 'w/1' }));
    expect(m).toEqual({ type: 'cancel', id: 'w/1' });
  });
});

describe('Pool: Chunk-Timeout und Abbruch (Story 18.8)', () => {
  it('beendet einen hängenden Worker nach chunkTimeoutMs und wiederholt den Chunk auf einem neuen', async () => {
    const log = join(tmp('ov-pool-once-'), 'log');
    const results = await runPool([chunk(0, 3)], () => undefined, poolOptions('hang-once', log, { chunkTimeoutMs: 1500 }));
    expect(results).toHaveLength(1);
    expect(results[0]?.keys).toEqual(['k0', 'k1', 'k2']);
    // Zwei Worker-Starts: der erste hing und wurde beendet.
    expect(readFileSync(log, 'utf8').split('\n').filter((l) => l === 'init')).toHaveLength(2);
  }, 30_000);

  it('gibt nach maxAttempts Zeitüberschreitungen mit Grund auf', async () => {
    const log = join(tmp('ov-pool-hang-'), 'log');
    const error = await failure(runPool([chunk(0, 2)], () => undefined, poolOptions('hang', log, { chunkTimeoutMs: 800 })));
    expect(error.diagnostic.code).toBe('OV_SCHEDULER_CHUNK_FAILED');
    expect(error.diagnostic.problem).toMatch(/timed out after 800 ms/u);
  }, 30_000);

  it('schickt bei Abbruch cancel an laufende Worker und endet mit OV_RENDER_CANCELLED', async () => {
    const log = join(tmp('ov-pool-cancel-'), 'log');
    const signal = { aborted: false };
    const started = Date.now();
    const run = runPool([chunk(0, 2), chunk(2, 4)], () => undefined, poolOptions('hang', log, { concurrency: 2, signal, onEvent: (e) => { if (e.type === 'chunk-started') signal.aborted = true; } }));
    const error = await failure(run);
    expect(error.diagnostic.code).toBe('OV_RENDER_CANCELLED');
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(readFileSync(log, 'utf8')).toMatch(/^cancel$/mu);
  }, 30_000);

  it('beendet einen Worker, der cancel ignoriert, nach cancelGraceMs (Review Q6)', async () => {
    const log = join(tmp('ov-pool-ignore-cancel-'), 'log');
    const signal = { aborted: false };
    const exits: (string | null)[] = [];
    const run = runPool([chunk(0, 2)], () => undefined, poolOptions('ignore-cancel', log, {
      signal,
      cancelGraceMs: 500,
      onEvent: (e) => {
        if (e.type === 'worker-exited') exits.push(e.signal);
      },
    }));
    // Erst abbrechen, wenn der Worker den Chunk nachweislich gelesen hat: Unter Last (CI) kann ein frisch
    // gestarteter Worker sonst schon nach der Frist beendet werden, bevor er überhaupt etwas empfangen hat.
    await vi.waitFor(() => {
      expect(existsSync(log) && readFileSync(log, 'utf8').split('\n').includes('chunk')).toBe(true);
    }, { timeout: 15_000, interval: 50 });
    signal.aborted = true;
    const abortedAt = performance.now();
    const error = await failure(run);
    expect(error.diagnostic.code).toBe('OV_RENDER_CANCELLED');
    // Deutlich unter der Standardfrist von 10 s: die Frist von 500 ms hat gegriffen.
    expect(performance.now() - abortedAt).toBeLessThan(8_000);
    expect(readFileSync(log, 'utf8')).toMatch(/^cancel$/mu);
    expect(exits).toEqual(['SIGKILL']);
  }, 40_000);

  it('hat eine Standardfrist von 10 s nach cancel', () => {
    expect(DEFAULT_CANCEL_GRACE_MS).toBe(10_000);
  });
});

describe('Standard-Parallelität (Story 18.7)', () => {
  it('richtet sich nach Kernen und Speicherbudget', () => {
    const gb = 1024 ** 3;
    expect(defaultWorkerCount({ cores: 4, totalBytes: 16 * gb, freeBytes: 12 * gb })).toBe(3);
    expect(defaultWorkerCount({ cores: 32, totalBytes: 64 * gb, freeBytes: 60 * gb })).toBe(16);
    expect(defaultWorkerCount({ cores: 16, totalBytes: 8 * gb, freeBytes: 6 * gb })).toBe(2);
    expect(defaultWorkerCount({ cores: 1, totalBytes: 2 * gb, freeBytes: 1 * gb })).toBe(1);
  });
});

describe('Native Hashes (Story 18.5)', () => {
  it('digestHex gleicht sha256Hex aus core', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
    expect(digestHex(bytes)).toBe(sha256Hex(bytes));
  });
});

const SUBMIT = 'submit-token-0123456789abcdef';
const WORKER = 'worker-token-0123456789abcdef';
const METRICS = 'metrics-token-0123456789abcdef';
const running: Coordinator[] = [];
afterEach(async () => {
  for (const c of running.splice(0)) await c.close();
});

async function coordinatorWith(extra: Record<string, unknown> = {}, now?: () => number): Promise<{ c: Coordinator; store: FileStore; dir: string }> {
  const dir = tmp('ov-coord-18-');
  const store = new FileStore(join(dir, 'shared'));
  const c = await startCoordinator({ port: 0, host: '127.0.0.1', store, journalDir: join(dir, 'journal'), tokens: { submit: SUBMIT, worker: WORKER, metrics: METRICS }, ...extra, ...(now !== undefined ? { now } : {}) });
  running.push(c);
  return { c, store, dir };
}

function call(c: Coordinator, path: string, token: string, body?: unknown, method?: string): Promise<Response> {
  return fetch(`${c.url}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function submit(c: Coordinator, chunks: ChunkRequest[], files: unknown[] = []): Promise<string> {
  const res = await call(c, '/v1/jobs', SUBMIT, { project: { schemaVersion: '1.0.0', n: Math.random() }, files, chunks });
  expect(res.status).toBe(201);
  const body: unknown = await res.json();
  if (typeof body !== 'object' || body === null || !('jobId' in body) || typeof body.jobId !== 'string') throw new Error('no jobId');
  return body.jobId;
}

async function lease(c: Coordinator): Promise<Lease | undefined> {
  const res = await call(c, '/v1/lease', WORKER, { worker: 'w' });
  if (res.status === 204) return undefined;
  const body: unknown = await res.json();
  if (!isLease(body)) throw new Error('no lease');
  return body;
}

async function queue(c: Coordinator): Promise<{ queueLength: number; jobsRunning: number }> {
  const body: unknown = await (await call(c, '/v1/queue', METRICS)).json();
  if (typeof body !== 'object' || body === null || !('queueLength' in body) || !('jobsRunning' in body) || typeof body.queueLength !== 'number' || typeof body.jobsRunning !== 'number') throw new Error('no queue status');
  return { queueLength: body.queueLength, jobsRunning: body.jobsRunning };
}

describe('Koordinator: gescheiterte und abgebrochene Jobs (M5, Story 18.8)', () => {
  it('vergibt nach dem Scheitern eines Chunks keine Rest-Chunks und zählt sie nicht für KEDA', async () => {
    const { c } = await coordinatorWith({ maxAttempts: 1 });
    await submit(c, [chunk(0, 1), chunk(1, 2), chunk(2, 3)]);
    const first = await lease(c);
    expect(first).toBeDefined();
    const fail = await call(c, '/v1/fail', WORKER, { leaseId: first?.leaseId, diagnostic: { code: 'X', severity: 'error', errorClass: 'E', problem: 'boom', suggestions: [] } });
    expect(fail.status).toBe(200);
    expect(await lease(c)).toBeUndefined();
    expect(await queue(c)).toMatchObject({ queueLength: 0, jobsRunning: 0 });
  });

  it('DELETE /v1/jobs/<id> bricht ab: Status failed, Heartbeat 410, keine Leases mehr', async () => {
    const { c } = await coordinatorWith();
    const jobId = await submit(c, [chunk(0, 1), chunk(1, 2)]);
    const l = await lease(c);
    const del = await call(c, `/v1/jobs/${jobId}`, SUBMIT, undefined, 'DELETE');
    expect(del.status).toBe(200);
    expect((await call(c, '/v1/heartbeat', WORKER, { leaseId: l?.leaseId })).status).toBe(410);
    expect(await lease(c)).toBeUndefined();
    const status: unknown = await (await call(c, `/v1/jobs/${jobId}`, SUBMIT)).json();
    expect(status).toMatchObject({ state: 'failed' });
    // Worker dürfen nicht abbrechen.
    expect((await call(c, `/v1/jobs/${jobId}`, WORKER, undefined, 'DELETE')).status).toBe(403);
  });

  it('der Remote-Runner bricht über DELETE ab und wirft OV_RENDER_CANCELLED', async () => {
    const { c, store } = await coordinatorWith();
    const dir = tmp('ov-remote-cancel-');
    const runner = createRemoteChunkRunner({ coordinatorUrl: c.url, token: SUBMIT, store, projectDir: dir, project: { schemaVersion: '1.0.0' }, pollIntervalMs: 50 });
    const signal = { aborted: false };
    setTimeout(() => {
      signal.aborted = true;
    }, 300);
    const error = await failure(runner([chunk(0, 2)], () => undefined, { signal }));
    expect(error.diagnostic.code).toBe('OV_RENDER_CANCELLED');
    expect(await lease(c)).toBeUndefined();
  });
});

describe('Koordinator: Befunde m7 und m8', () => {
  it('ein Heartbeat nach Ablauf der Lease verlängert sie nicht (410)', async () => {
    let t = 1_000_000;
    const { c } = await coordinatorWith({ leaseSeconds: 10 }, () => t);
    await submit(c, [chunk(0, 1)]);
    const l = await lease(c);
    t += 11_000;
    expect((await call(c, '/v1/heartbeat', WORKER, { leaseId: l?.leaseId })).status).toBe(410);
  });

  it('kaputte Prozent-Kodierung in der Job-ID ergibt 400 statt 500', async () => {
    const { c } = await coordinatorWith();
    expect((await call(c, '/v1/jobs/%E0%A4%A', SUBMIT)).status).toBe(400);
  });

  it('/metrics schreibt kein Journal', async () => {
    let t = 1_000_000;
    const { c, dir } = await coordinatorWith({ leaseSeconds: 10 }, () => t);
    await submit(c, [chunk(0, 1)]);
    await lease(c);
    t += 11_000;
    const before = readFileSync(join(dir, 'journal', 'journal.jsonl'), 'utf8');
    expect((await fetch(`${c.url}/metrics`)).status).toBe(200);
    expect(readFileSync(join(dir, 'journal', 'journal.jsonl'), 'utf8')).toBe(before);
  });

  it('parallele Einreichungen halten maxActiveJobs ein', async () => {
    const { c } = await coordinatorWith({ maxActiveJobs: 2 });
    const statuses = await Promise.all(Array.from({ length: 6 }, (_, i) => call(c, '/v1/jobs', SUBMIT, { project: { i }, files: [{ path: 'a.bin', data: Buffer.alloc(200_000, i).toString('base64') }], chunks: [chunk(0, 1)] }).then((r) => r.status)));
    expect(statuses.filter((s) => s === 201)).toHaveLength(2);
    expect(statuses.filter((s) => s === 429)).toHaveLength(4);
  });

  it('räumt Eingaben abgelaufener Jobs auf, die kein anderer Job nutzt', async () => {
    let t = 1_000_000;
    const { c, store } = await coordinatorWith({ jobTtlSeconds: 1 }, () => t);
    const shared = Buffer.from('shared-input').toString('base64');
    const own = Buffer.from('own-input').toString('base64');
    const a = await submit(c, [chunk(0, 1)], [{ path: 'a.txt', data: own }, { path: 's.txt', data: shared }]);
    await submit(c, [chunk(0, 1)], [{ path: 's.txt', data: shared }]);
    // Job a beenden (Abbruch zählt als fertig für die TTL).
    expect((await call(c, `/v1/jobs/${a}`, SUBMIT, undefined, 'DELETE')).status).toBe(200);
    t += 5_000;
    await call(c, '/v1/queue', METRICS);
    await new Promise((r) => setTimeout(r, 200));
    const ownKey = inputKey(sha256Hex(new TextEncoder().encode('own-input')));
    const sharedKey = inputKey(sha256Hex(new TextEncoder().encode('shared-input')));
    expect(await store.has(ownKey)).toBe(false);
    expect(await store.has(sharedKey)).toBe(true);
  });
});
