/**
 * Koordinator-Sicherheit und -Grenzen (Epic 16): Rollen-Tokens, Lease-Pflicht, Präfixprüfung,
 * Body-Limit, Obergrenzen, TTL, Journal-Kompaktierung und die Frame-Prüfung im Remote-Runner.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '@agentic-video/cache';
import { OpenVideoError, sha256Hex } from '@agentic-video/core';
import {
  COORDINATOR_LIMITS,
  assertStrongToken,
  createRemoteChunkRunner,
  inputKey,
  isLoopbackAddress,
  jobFrameKey,
  startCoordinator,
  type Coordinator,
  type CoordinatorOptions,
  type Lease,
} from '@agentic-video/scheduler';

const SUBMIT = 'submit-token-0123456789abcdef';
const WORKER = 'worker-token-0123456789abcdef';
const METRICS = 'metrics-token-0123456789abcdef';
const project = { schemaVersion: '1.0.0', compositions: [{ id: 'main' }] };
const chunk = (start: number, end: number) => ({ compositionId: 'main', start, end, scale: 1, step: 1, offset: 0 });

const running: Coordinator[] = [];
afterEach(async () => {
  for (const c of running.splice(0)) await c.close();
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ov-coordinator-'));
}

async function start(extra: Partial<CoordinatorOptions> = {}, dir = tmp()): Promise<{ coordinator: Coordinator; store: FileStore; dir: string }> {
  const store = new FileStore(join(dir, 'shared'));
  const coordinator = await startCoordinator({ port: 0, host: '127.0.0.1', store, journalDir: join(dir, 'journal'), tokens: { submit: SUBMIT, worker: WORKER, metrics: METRICS }, ...extra });
  running.push(coordinator);
  return { coordinator, store, dir };
}

function call(c: Coordinator, path: string, token: string | undefined, body?: unknown): Promise<Response> {
  return fetch(`${c.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function json<T>(res: Response): Promise<T> {
  const value: unknown = await res.json();
  return value as T;
}

async function code(res: Response): Promise<string> {
  const body = await json<{ diagnostic?: { code?: string } }>(res);
  return body.diagnostic?.code ?? '';
}

async function submitJob(c: Coordinator, chunks = [chunk(0, 2)]): Promise<string> {
  const res = await call(c, '/v1/jobs', SUBMIT, { project, files: [], chunks });
  expect(res.status).toBe(201);
  return (await json<{ jobId: string }>(res)).jobId;
}

async function leaseOne(c: Coordinator): Promise<Lease> {
  const res = await call(c, '/v1/lease', WORKER, { worker: 'w' });
  expect(res.status).toBe(200);
  return json<Lease>(res);
}

/** Legt Frames wie ein ehrlicher Worker unter jobs/<jobId>/frames/ ab und baut das Ergebnis. */
async function honestResult(store: FileStore, lease: Lease, payloads: readonly string[]): Promise<Record<string, unknown>> {
  const keys: string[] = [];
  for (const p of payloads) {
    const bytes = new TextEncoder().encode(p);
    const key = jobFrameKey(lease.jobId, sha256Hex(bytes));
    await store.put(key, bytes);
    keys.push(key);
  }
  return { start: lease.request.start, end: lease.request.end, frameHashes: payloads.map((p) => `sha256:${p}`), keys, rendered: payloads.length, fromCache: 0, diagnostics: [] };
}

describe('Tokens (Story 16.3, M1/M4)', () => {
  it('verweigert den Start ohne Token außerhalb von Loopback', async () => {
    const dir = tmp();
    await expect(startCoordinator({ port: 0, host: '0.0.0.0', store: new FileStore(join(dir, 's')), journalDir: join(dir, 'j') })).rejects.toMatchObject({ diagnostic: { code: 'OV_COORDINATOR_TOKEN_REQUIRED' } });
    // Standard-Adresse ist 0.0.0.0: ebenfalls nur mit Token.
    await expect(startCoordinator({ port: 0, store: new FileStore(join(dir, 's')), journalDir: join(dir, 'j') })).rejects.toMatchObject({ diagnostic: { code: 'OV_COORDINATOR_TOKEN_REQUIRED' } });
  });

  it('lehnt kurze Tokens, Platzhalter und gleiche Tokens für verschiedene Rollen ab', async () => {
    expect(() => assertStrongToken('worker', 'short')).toThrow(/shorter than 24/u);
    expect(() => assertStrongToken('worker', 'REPLACE-WITH-A-LONG-RANDOM-WORKER-TOKEN')).toThrow(/placeholder/u);
    expect(() => assertStrongToken('worker', 'REPLACE')).toThrow(OpenVideoError);
    expect(() => assertStrongToken('worker', 'has whitespace 0123456789abcdef')).toThrow(/whitespace/u);
    expect(() => assertStrongToken('worker', 'a'.repeat(COORDINATOR_LIMITS.minTokenLength))).not.toThrow();
    await expect(start({ tokens: { submit: SUBMIT, worker: 'REPLACE' } })).rejects.toMatchObject({ diagnostic: { code: 'OV_COORDINATOR_TOKEN_WEAK' } });
    await expect(start({ tokens: { submit: SUBMIT, worker: SUBMIT } })).rejects.toMatchObject({ diagnostic: { code: 'OV_COORDINATOR_TOKEN_SHARED' } });
    await expect(start({ tokens: undefined, token: 't' })).rejects.toMatchObject({ diagnostic: { code: 'OV_COORDINATOR_TOKEN_WEAK' } });
  });

  it('erkennt Loopback-Adressen', () => {
    expect(['127.0.0.1', '127.1.2.3', 'localhost', '::1'].map(isLoopbackAddress)).toEqual([true, true, true, true]);
    expect(['0.0.0.0', '10.0.0.1', '::', 'coordinator'].map(isLoopbackAddress)).toEqual([false, false, false, false]);
  });

  it('trennt die Rollen submit, worker und metrics', async () => {
    const { coordinator: c } = await start();
    expect((await call(c, '/v1/queue', undefined)).status).toBe(401);
    expect((await call(c, '/v1/queue', 'wrong-token-0123456789abcdef')).status).toBe(401);
    expect((await call(c, '/v1/queue', METRICS)).status).toBe(200);
    expect((await call(c, '/v1/queue', SUBMIT)).status).toBe(200);
    const byWorker = await call(c, '/v1/queue', WORKER);
    expect(byWorker.status).toBe(403);
    expect(await code(byWorker)).toBe('OV_COORDINATOR_FORBIDDEN');

    for (const token of [WORKER, METRICS]) expect((await call(c, '/v1/jobs', token, { project, files: [], chunks: [chunk(0, 1)] })).status).toBe(403);
    const jobId = await submitJob(c);
    expect((await call(c, `/v1/jobs/${jobId}`, METRICS)).status).toBe(403);
    expect((await call(c, `/v1/jobs/${jobId}`, WORKER)).status).toBe(403);
    expect((await call(c, `/v1/jobs/${jobId}`, SUBMIT)).status).toBe(200);

    for (const token of [SUBMIT, METRICS]) {
      expect((await call(c, '/v1/lease', token, { worker: 'x' })).status).toBe(403);
      expect((await call(c, '/v1/complete', token, { leaseId: 'x' })).status).toBe(403);
    }
    expect((await call(c, '/v1/lease', WORKER, { worker: 'w' })).status).toBe(200);
    // /metrics bleibt ohne Token lesbar (nur Zähler, für Probes).
    expect((await fetch(`${c.url}/metrics`)).status).toBe(200);
  });
});

describe('Lease-Pflicht und Präfixprüfung (Story 16.2, H2)', () => {
  it('complete und fail nur mit gültiger leaseId; jobId/index allein reichen nicht', async () => {
    const { coordinator: c, store } = await start();
    const jobId = await submitJob(c);
    const lease = await leaseOne(c);
    const result = await honestResult(store, lease, ['a', 'b']);

    const byIndex = await call(c, '/v1/complete', WORKER, { jobId, index: 0, result });
    expect(byIndex.status).toBe(409);
    expect(await code(byIndex)).toBe('OV_COORDINATOR_LEASE_INVALID');
    expect((await call(c, '/v1/complete', WORKER, { leaseId: 'forged', jobId, index: 0, result })).status).toBe(409);
    expect((await call(c, '/v1/fail', WORKER, { jobId, index: 0 })).status).toBe(409);
    expect((await call(c, '/v1/heartbeat', WORKER, { leaseId: 'forged' })).status).toBe(410);

    expect((await call(c, '/v1/complete', WORKER, { leaseId: lease.leaseId, result })).status).toBe(200);
    // Dieselbe Lease ist danach verbraucht.
    expect((await call(c, '/v1/complete', WORKER, { leaseId: lease.leaseId, result })).status).toBe(409);
    const status = await json<{ state: string }>(await call(c, `/v1/jobs/${jobId}`, SUBMIT));
    expect(status.state).toBe('done');
  });

  it('nimmt nur Frame-Schlüssel unter jobs/<jobId>/frames/ und passende Frame-Zahlen an', async () => {
    const { coordinator: c, store } = await start();
    const other = await submitJob(c, [chunk(0, 1)]);
    await submitJob(c);
    await leaseOne(c);
    const lease = await leaseOne(c);
    expect(lease.jobId).not.toBe(other);
    const good = await honestResult(store, lease, ['a', 'b']);
    const hex = sha256Hex(new TextEncoder().encode('a'));
    const variants: readonly (readonly string[])[] = [
      [hex, hex],
      [`frame/${hex}`, `frame/${hex}`],
      [jobFrameKey(other, hex), jobFrameKey(other, hex)],
      [`jobs/${lease.jobId}/frames/../../frame/${hex}`, jobFrameKey(lease.jobId, hex)],
      [jobFrameKey(lease.jobId, hex)],
    ];
    for (const keys of variants) {
      const res = await call(c, '/v1/complete', WORKER, { leaseId: lease.leaseId, result: { ...good, keys } });
      expect(res.status, keys.join(',')).toBe(400);
      expect(await code(res)).toBe('OV_COORDINATOR_RESULT_INVALID');
    }
    expect((await call(c, '/v1/complete', WORKER, { leaseId: lease.leaseId, result: { ...good, start: 5, end: 7 } })).status).toBe(400);
    expect((await call(c, '/v1/complete', WORKER, { leaseId: lease.leaseId, result: good })).status).toBe(200);
  });

  it('eine Lease übersteht den Neustart des Koordinators (Journal)', async () => {
    const dir = tmp();
    const first = await start({}, dir);
    await submitJob(first.coordinator);
    const lease = await leaseOne(first.coordinator);
    await first.coordinator.close();
    running.splice(running.indexOf(first.coordinator), 1);
    const second = await start({}, dir);
    const result = await honestResult(second.store, lease, ['a', 'b']);
    expect((await call(second.coordinator, '/v1/heartbeat', WORKER, { leaseId: lease.leaseId })).status).toBe(200);
    expect((await call(second.coordinator, '/v1/complete', WORKER, { leaseId: lease.leaseId, result })).status).toBe(200);
  });

  it('legt Projekt und Dateien inhaltsadressiert unter inputs/ ab und prüft Verweise', async () => {
    const { coordinator: c, store } = await start();
    const bytes = new TextEncoder().encode('big asset');
    const key = inputKey(sha256Hex(bytes));
    const missing = await call(c, '/v1/jobs', SUBMIT, { project, files: [{ path: 'assets/a.bin', key }], chunks: [chunk(0, 1)] });
    expect(missing.status).toBe(400);
    await store.put(key, bytes);
    for (const bad of ['project/x', `jobs/x/frames/${sha256Hex(bytes)}`, `inputs/sha256-${'z'.repeat(64)}`]) {
      expect((await call(c, '/v1/jobs', SUBMIT, { project, files: [{ path: 'assets/a.bin', key: bad }], chunks: [chunk(0, 1)] })).status).toBe(400);
    }
    expect((await call(c, '/v1/jobs', SUBMIT, { project, files: [{ path: 'assets/a.bin', key }, { path: 'b.txt', data: Buffer.from('b').toString('base64') }], chunks: [chunk(0, 1)] })).status).toBe(201);
    const lease = await leaseOne(c);
    expect(lease.projectKey).toBe(inputKey(sha256Hex(new TextEncoder().encode(JSON.stringify(project)))));
    expect(lease.files).toEqual([
      { path: 'assets/a.bin', key },
      { path: 'b.txt', key: inputKey(sha256Hex(new TextEncoder().encode('b'))) },
    ]);
  });
});

describe('Grenzen (Story 16.4, M2)', () => {
  it('Body-Limit: Standard 64 MiB; größere Anfragen enden mit 413, bevor sie gepuffert werden', async () => {
    expect(COORDINATOR_LIMITS.maxBodyBytes).toBe(64 * 1024 * 1024);
    const { coordinator: c } = await start({ maxBodyBytes: 1024 });
    const res = await call(c, '/v1/jobs', SUBMIT, { project, files: [{ path: 'a.bin', data: 'A'.repeat(4096) }], chunks: [chunk(0, 1)] });
    expect(res.status).toBe(413);
    expect(await code(res)).toBe('OV_COORDINATOR_TOO_LARGE');
    // Ohne Token wird der Body gar nicht erst gelesen.
    expect((await call(c, '/v1/jobs', undefined, { project, files: [], chunks: [chunk(0, 1)] })).status).toBe(401);
  });

  it('Obergrenzen für Chunks je Job und laufende Jobs', async () => {
    const { coordinator: c } = await start({ maxChunksPerJob: 2, maxActiveJobs: 1 });
    const tooMany = await call(c, '/v1/jobs', SUBMIT, { project, files: [], chunks: [chunk(0, 1), chunk(1, 2), chunk(2, 3)] });
    expect(tooMany.status).toBe(413);
    expect(await code(tooMany)).toBe('OV_COORDINATOR_TOO_MANY_CHUNKS');
    await submitJob(c, [chunk(0, 1)]);
    const busy = await call(c, '/v1/jobs', SUBMIT, { project, files: [], chunks: [chunk(0, 1)] });
    expect(busy.status).toBe(429);
    expect(await code(busy)).toBe('OV_COORDINATOR_BUSY');
  });

  it('TTL: fertige Jobs verschwinden samt Frames; das Journal wird kompaktiert', async () => {
    let clock = 1_000_000;
    const dir = tmp();
    const { coordinator: c, store } = await start({ now: () => clock, jobTtlSeconds: 60 }, dir);
    const jobId = await submitJob(c);
    const lease = await leaseOne(c);
    const result = await honestResult(store, lease, ['a', 'b']);
    expect((await call(c, '/v1/complete', WORKER, { leaseId: lease.leaseId, result })).status).toBe(200);
    clock += 59_000;
    expect((await call(c, `/v1/jobs/${jobId}`, SUBMIT)).status).toBe(200);
    clock += 2_000;
    expect((await call(c, `/v1/jobs/${jobId}`, SUBMIT)).status).toBe(404);
    await expect.poll(async () => (await store.list(`jobs/${jobId}/`)).length).toBe(0);
    expect(readFileSync(join(dir, 'journal', 'journal.jsonl'), 'utf8')).not.toContain(jobId);
    // Nach einem Neustart bleibt der Job weg.
    await c.close();
    running.splice(running.indexOf(c), 1);
    const again = await start({ now: () => clock, jobTtlSeconds: 60 }, dir);
    expect((await call(again.coordinator, `/v1/jobs/${jobId}`, SUBMIT)).status).toBe(404);
  });

  it('Kompaktierung beim Start behält offene Jobs, Versuche und Ergebnisse', async () => {
    const dir = tmp();
    const first = await start({ maxAttempts: 3 }, dir);
    const jobId = await submitJob(first.coordinator, [chunk(0, 1), chunk(1, 2)]);
    const a = await leaseOne(first.coordinator);
    expect((await call(first.coordinator, '/v1/fail', WORKER, { leaseId: a.leaseId })).status).toBe(200);
    const b = await leaseOne(first.coordinator);
    expect((await call(first.coordinator, '/v1/complete', WORKER, { leaseId: b.leaseId, result: await honestResult(first.store, b, ['x']) })).status).toBe(200);
    await first.coordinator.close();
    running.splice(running.indexOf(first.coordinator), 1);
    const second = await start({ maxAttempts: 3 }, dir);
    const lines = readFileSync(join(dir, 'journal', 'journal.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const status = await json<{ state: string; chunks: { state: string; attempts: number }[] }>(await call(second.coordinator, `/v1/jobs/${jobId}`, SUBMIT));
    expect(status.state).toBe('running');
    expect(status.chunks.map((ch) => [ch.state, ch.attempts])).toEqual(
      a.index === 0
        ? [
            ['queued', 1],
            ['done', 0],
          ]
        : [
            ['done', 0],
            ['queued', 1],
          ],
    );
  });
});

describe('Remote-Runner prüft Worker-Frames (T8)', () => {
  async function runWith(worker: (c: Coordinator, store: FileStore) => Promise<void>): Promise<{ result: Promise<unknown>; store: FileStore }> {
    const { coordinator: c, store, dir } = await start();
    const projectDir = join(dir, 'project');
    mkdirSync(projectDir);
    const runChunks = createRemoteChunkRunner({ coordinatorUrl: c.url, token: SUBMIT, store, projectDir, project, pollIntervalMs: 20 });
    const result = runChunks([chunk(0, 2)], () => undefined);
    await worker(c, store);
    return { result, store };
  }

  async function leaseWhenQueued(c: Coordinator): Promise<Lease> {
    for (let i = 0; i < 200; i++) {
      const res = await call(c, '/v1/lease', WORKER, { worker: 'w' });
      if (res.status === 200) return json<Lease>(res);
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('no lease');
  }

  it('übernimmt geprüfte Frames als remote-sha256-<hex> in die lokale Frame-Ebene', async () => {
    const { result, store } = await runWith(async (c, s) => {
      const lease = await leaseWhenQueued(c);
      expect((await call(c, '/v1/complete', WORKER, { leaseId: lease.leaseId, result: await honestResult(s, lease, ['a', 'b']) })).status).toBe(200);
    });
    const results = await result;
    const hexA = sha256Hex(new TextEncoder().encode('a'));
    expect(results).toMatchObject([{ keys: [`remote-sha256-${hexA}`, `remote-sha256-${sha256Hex(new TextEncoder().encode('b'))}`] }]);
    expect(new TextDecoder().decode(await store.get(`frame/remote-sha256-${hexA}`))).toBe('a');
  });

  it('verwirft einen Frame, dessen Inhalt nicht zum SHA-256 im Schlüssel passt', async () => {
    const { result } = await runWith(async (c, s) => {
      const lease = await leaseWhenQueued(c);
      const honest = await honestResult(s, lease, ['a', 'b']);
      const keys = honest['keys'];
      // Ein anderer Worker überschreibt den Frame unter demselben Schlüssel.
      if (Array.isArray(keys) && typeof keys[0] === 'string') await s.put(keys[0], new TextEncoder().encode('poisoned'));
      expect((await call(c, '/v1/complete', WORKER, { leaseId: lease.leaseId, result: honest })).status).toBe(200);
    });
    await expect(result).rejects.toMatchObject({ diagnostic: { code: 'OV_SCHEDULER_CONTENT_MISMATCH' } });
  });

  it('lädt große Projektdateien als Verweis hoch statt sie in den Job-Body zu packen', async () => {
    const { coordinator: c, store, dir } = await start({ maxBodyBytes: 64 * 1024 });
    const projectDir = join(dir, 'project');
    mkdirSync(join(projectDir, 'assets'), { recursive: true });
    const big = new Uint8Array(200 * 1024).map((_, i) => i % 251);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(projectDir, 'assets', 'big.bin'), big);
    const runChunks = createRemoteChunkRunner({ coordinatorUrl: c.url, token: SUBMIT, store, projectDir, project, pollIntervalMs: 20, inlineFileLimit: 1024 });
    const running = runChunks([chunk(0, 1)], () => undefined);
    const lease = await leaseWhenQueued(c);
    expect(lease.files).toEqual([{ path: 'assets/big.bin', key: inputKey(sha256Hex(big)) }]);
    expect(await store.get(inputKey(sha256Hex(big)))).toEqual(big);
    expect((await call(c, '/v1/complete', WORKER, { leaseId: lease.leaseId, result: await honestResult(store, lease, ['z']) })).status).toBe(200);
    await expect(running).resolves.toHaveLength(1);
  });
});
