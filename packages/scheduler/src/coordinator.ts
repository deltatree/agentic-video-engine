/**
 * HTTP-Koordinator für Remote- und Kubernetes-Worker (FR-66, FR-91).
 *
 * Worker holen Chunks per Pull (`lease`), melden sich per `heartbeat` und geben das
 * Ergebnis mit `complete` oder `fail` ab. Ein Journal (JSON Lines) hält Jobs und
 * Ergebnisse; nach einem Neustart werden offene Chunks wieder vergeben.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { OpenVideoError, isRecord, sha256Hex, type Diagnostic } from '@agentic-video/core';
import type { ContentStore } from '@agentic-video/cache';
import type { ChunkRequest, ChunkResult } from '@agentic-video/render';
import { isSafeRelativePath } from './files.js';
import { isChunkRequest, isChunkResult, isDiagnostic } from './protocol.js';

/** Optionen für {@link startCoordinator}. */
export interface CoordinatorOptions {
  /** TCP-Port (0 = frei wählen). */
  readonly port: number;
  /** Adresse (Standard `0.0.0.0`). */
  readonly host?: string;
  /** Gemeinsamer Speicher (S3 im Cluster); Projekt und Assets liegen hier. */
  readonly store: ContentStore;
  readonly journalDir: string;
  /** Bearer-Token für alle `/v1`-Endpunkte. */
  readonly token?: string;
  /** Dauer einer Lease ohne Heartbeat (Standard 120 s). */
  readonly leaseSeconds?: number;
  /** Versuche je Chunk (Standard 3). */
  readonly maxAttempts?: number;
  /** Größte Anfrage in Bytes (Standard 512 MiB). */
  readonly maxBodyBytes?: number;
}

/** Ein laufender Koordinator. */
export interface Coordinator {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

/** Eine Projektdatei im Speicher. */
export interface StoredFile {
  readonly path: string;
  readonly key: string;
}

/** Antwort auf `POST /v1/lease`. */
export interface Lease {
  readonly leaseId: string;
  readonly jobId: string;
  readonly index: number;
  readonly request: ChunkRequest;
  readonly traceparent?: string;
  /** Speicherschlüssel der Projekt-IR (JSON). */
  readonly projectKey: string;
  readonly files: readonly StoredFile[];
  readonly leaseSeconds: number;
}

/** Zustand eines Chunks. */
export type ChunkState = 'queued' | 'leased' | 'done' | 'failed';

/** Antwort auf `GET /v1/jobs/<id>`. */
export interface JobStatus {
  readonly id: string;
  readonly state: 'running' | 'done' | 'failed';
  readonly chunks: readonly { readonly index: number; readonly state: ChunkState; readonly attempts: number; readonly result?: ChunkResult }[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Antwort auf `GET /v1/queue` (für KEDA metrics-api: `valueLocation: queueLength`). */
export interface QueueStatus {
  readonly queueLength: number;
  readonly leasesActive: number;
  readonly jobsRunning: number;
}

interface ChunkEntry {
  readonly request: ChunkRequest;
  state: ChunkState;
  attempts: number;
  lease?: { id: string; worker: string; expires: number };
  result?: ChunkResult;
  queuedSince: number;
}

interface Job {
  readonly id: string;
  readonly projectKey: string;
  readonly files: readonly StoredFile[];
  readonly traceparent?: string;
  readonly chunks: ChunkEntry[];
  readonly diagnostics: Diagnostic[];
}

/** Prüft, ob ein Wert eine {@link Lease} ist. */
export function isLease(value: unknown): value is Lease {
  return (
    isRecord(value) &&
    typeof value['leaseId'] === 'string' &&
    typeof value['jobId'] === 'string' &&
    typeof value['index'] === 'number' &&
    isChunkRequest(value['request']) &&
    (value['traceparent'] === undefined || typeof value['traceparent'] === 'string') &&
    typeof value['projectKey'] === 'string' &&
    typeof value['leaseSeconds'] === 'number' &&
    Array.isArray(value['files']) &&
    value['files'].every((f) => isRecord(f) && typeof f['path'] === 'string' && typeof f['key'] === 'string')
  );
}

/** Prüft, ob ein Wert ein {@link JobStatus} ist. */
export function isJobStatus(value: unknown): value is JobStatus {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    (value['state'] === 'running' || value['state'] === 'done' || value['state'] === 'failed') &&
    Array.isArray(value['diagnostics']) &&
    value['diagnostics'].every(isDiagnostic) &&
    Array.isArray(value['chunks']) &&
    value['chunks'].every(
      (c) =>
        isRecord(c) &&
        typeof c['index'] === 'number' &&
        typeof c['attempts'] === 'number' &&
        (c['state'] === 'queued' || c['state'] === 'leased' || c['state'] === 'done' || c['state'] === 'failed') &&
        (c['result'] === undefined || isChunkResult(c['result'])),
    )
  );
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly diagnostic: Diagnostic,
  ) {
    super(diagnostic.problem);
  }
}

function badRequest(problem: string, suggestion: string): HttpError {
  return new HttpError(400, { code: 'OV_COORDINATOR_REQUEST', severity: 'error', errorClass: 'CoordinatorError', problem, suggestions: [suggestion] });
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    if (!(chunk instanceof Buffer)) continue;
    size += chunk.length;
    if (size > limit) throw new HttpError(413, { code: 'OV_COORDINATOR_TOO_LARGE', severity: 'error', errorClass: 'CoordinatorError', problem: `The request body exceeds ${String(limit)} bytes.`, suggestions: ['Put large assets into the shared store first.'] });
    parts.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch (error) {
    throw badRequest(`The request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 'Send a JSON object.');
  }
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice('Bearer '.length));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

/**
 * Startet den HTTP-Koordinator.
 *
 * Endpunkte: `POST /v1/jobs`, `POST /v1/lease`, `POST /v1/heartbeat`, `POST /v1/complete`,
 * `POST /v1/fail`, `GET /v1/jobs/<id>`, `GET /v1/queue`, `GET /metrics` (Prometheus-Text).
 *
 * @example
 * ```ts
 * const coordinator = await startCoordinator({ port: 8080, store: storeFromEnv(process.env, '/data'), journalDir: '/data/journal', token: process.env.OPENVIDEO_TOKEN });
 * ```
 */
export async function startCoordinator(options: CoordinatorOptions): Promise<Coordinator> {
  const leaseMs = (options.leaseSeconds ?? 120) * 1000;
  const maxAttempts = options.maxAttempts ?? 3;
  const maxBody = options.maxBodyBytes ?? 512 * 1024 * 1024;
  const jobs = new Map<string, Job>();
  let failedTotal = 0;
  mkdirSync(options.journalDir, { recursive: true });
  const journalPath = join(options.journalDir, 'journal.jsonl');

  const journal = (entry: Readonly<Record<string, unknown>>): void => {
    appendFileSync(journalPath, `${JSON.stringify(entry)}\n`);
  };

  const now = (): number => Date.now();

  const applyAttempt = (job: Job, index: number, failed: boolean, diagnostic: Diagnostic | undefined): void => {
    const c = job.chunks[index];
    if (c === undefined || c.state === 'done') return;
    delete c.lease;
    if (failed) {
      c.attempts++;
      failedTotal++;
    }
    if (diagnostic !== undefined) job.diagnostics.push(diagnostic);
    c.state = c.attempts >= maxAttempts ? 'failed' : 'queued';
    c.queuedSince = now();
  };

  // Journal einlesen: offene Chunks stehen danach wieder in der Warteschlange.
  if (existsSync(journalPath)) {
    for (const line of readFileSync(journalPath, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      let e: unknown;
      try {
        e = JSON.parse(line);
      } catch (error) {
        // Eine halb geschriebene letzte Zeile (Absturz beim Schreiben) wird übersprungen.
        process.emitWarning(`Skipping unreadable journal line: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!isRecord(e)) continue;
      if (e['e'] === 'job' && isRecord(e['job'])) {
        const j = e['job'];
        const chunks = j['chunks'];
        const files = j['files'];
        if (typeof j['id'] !== 'string' || typeof j['projectKey'] !== 'string' || !Array.isArray(chunks) || !chunks.every(isChunkRequest) || !Array.isArray(files)) continue;
        const stored = files.filter((f): f is StoredFile => isRecord(f) && typeof f['path'] === 'string' && typeof f['key'] === 'string');
        const tp = j['traceparent'];
        jobs.set(j['id'], { id: j['id'], projectKey: j['projectKey'], files: stored, ...(typeof tp === 'string' ? { traceparent: tp } : {}), chunks: chunks.map((request) => ({ request, state: 'queued', attempts: 0, queuedSince: now() })), diagnostics: [] });
      } else if (typeof e['jobId'] === 'string' && typeof e['index'] === 'number') {
        const job = jobs.get(e['jobId']);
        if (job === undefined) continue;
        if (e['e'] === 'done' && isChunkResult(e['result'])) {
          const c = job.chunks[e['index']];
          if (c !== undefined) {
            c.state = 'done';
            c.result = e['result'];
          }
        } else if (e['e'] === 'attempt') {
          applyAttempt(job, e['index'], e['failed'] === true, isDiagnostic(e['diagnostic']) ? e['diagnostic'] : undefined);
        }
      }
    }
  }

  const expireLeases = (): void => {
    const t = now();
    for (const job of jobs.values()) {
      job.chunks.forEach((c, index) => {
        if (c.state === 'leased' && c.lease !== undefined && c.lease.expires <= t) {
          const diagnostic: Diagnostic = { code: 'OV_COORDINATOR_LEASE_EXPIRED', severity: 'warning', errorClass: 'CoordinatorError', problem: `Lease of chunk ${String(index)} (worker ${c.lease.worker}) expired.`, suggestions: ['Check the worker logs; the chunk is given to another worker.'] };
          journal({ e: 'attempt', jobId: job.id, index, failed: true, diagnostic });
          applyAttempt(job, index, true, diagnostic);
        }
      });
    }
  };

  const findLease = (leaseId: string): { job: Job; index: number } | undefined => {
    for (const job of jobs.values()) {
      const index = job.chunks.findIndex((c) => c.lease?.id === leaseId);
      if (index >= 0) return { job, index };
    }
    return undefined;
  };

  /** Findet den Chunk einer Lease; nach einem Neustart auch über `jobId` und `index`. */
  const locate = (body: Readonly<Record<string, unknown>>): { job: Job; index: number } | undefined => {
    const leaseId = body['leaseId'];
    if (typeof leaseId === 'string') {
      const hit = findLease(leaseId);
      if (hit !== undefined) return hit;
    }
    const jobId = body['jobId'];
    const index = body['index'];
    if (typeof jobId !== 'string' || typeof index !== 'number') return undefined;
    const job = jobs.get(jobId);
    return job !== undefined && job.chunks[index] !== undefined ? { job, index } : undefined;
  };

  const jobState = (job: Job): JobStatus['state'] => (job.chunks.some((c) => c.state === 'failed') ? 'failed' : job.chunks.every((c) => c.state === 'done') ? 'done' : 'running');

  const counts = (): QueueStatus => {
    let queued = 0;
    let leased = 0;
    let running = 0;
    for (const job of jobs.values()) {
      if (jobState(job) === 'running') running++;
      for (const c of job.chunks) {
        if (c.state === 'queued') queued++;
        if (c.state === 'leased') leased++;
      }
    }
    return { queueLength: queued, leasesActive: leased, jobsRunning: running };
  };

  const submit = async (body: unknown): Promise<unknown> => {
    if (!isRecord(body) || !isRecord(body['project']) || !Array.isArray(body['chunks']) || !Array.isArray(body['files'])) {
      throw badRequest('A job needs "project", "files" and "chunks".', '{ "project": {…}, "files": [{ "path": "assets/a.png", "data": "<base64>" }], "chunks": [{…}] }');
    }
    const chunks = body['chunks'];
    if (chunks.length === 0 || !chunks.every(isChunkRequest)) throw badRequest('"chunks" must be a non-empty list of chunk requests.', 'Use the chunks that renderVideo passes to its runner.');
    const projectBytes = new TextEncoder().encode(JSON.stringify(body['project']));
    const projectKey = `project/sha256:${sha256Hex(projectBytes)}`;
    await options.store.put(projectKey, projectBytes);
    const files: StoredFile[] = [];
    for (const f of body['files']) {
      if (!isRecord(f) || typeof f['path'] !== 'string' || typeof f['data'] !== 'string' || !isSafeRelativePath(f['path'])) {
        throw badRequest('Each file needs a safe relative "path" and base64 "data".', 'Use paths like "assets/logo.png" without "..".');
      }
      const bytes = new Uint8Array(Buffer.from(f['data'], 'base64'));
      const key = `project/sha256:${sha256Hex(bytes)}`;
      await options.store.put(key, bytes);
      files.push({ path: f['path'], key });
    }
    const tp = body['traceparent'];
    const job: Job = { id: randomUUID(), projectKey, files, ...(typeof tp === 'string' ? { traceparent: tp } : {}), chunks: chunks.map((request) => ({ request, state: 'queued', attempts: 0, queuedSince: now() })), diagnostics: [] };
    journal({ e: 'job', job: { id: job.id, projectKey, files, traceparent: job.traceparent, chunks } });
    jobs.set(job.id, job);
    return { jobId: job.id, chunks: chunks.length };
  };

  const lease = (body: Readonly<Record<string, unknown>>): Lease | undefined => {
    expireLeases();
    const worker = typeof body['worker'] === 'string' ? body['worker'] : 'unknown';
    let best: { job: Job; index: number; since: number } | undefined;
    for (const job of jobs.values()) {
      job.chunks.forEach((c, index) => {
        if (c.state === 'queued' && (best === undefined || c.queuedSince < best.since)) best = { job, index, since: c.queuedSince };
      });
    }
    if (best === undefined) return undefined;
    const { job, index } = best;
    const c = job.chunks[index];
    if (c === undefined) return undefined;
    const leaseId = randomUUID();
    c.state = 'leased';
    c.lease = { id: leaseId, worker, expires: now() + leaseMs };
    return { leaseId, jobId: job.id, index, request: c.request, ...(job.traceparent !== undefined ? { traceparent: job.traceparent } : {}), projectKey: job.projectKey, files: job.files, leaseSeconds: leaseMs / 1000 };
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://coordinator');
    const path = url.pathname;
    if (req.method === 'GET' && path === '/metrics') {
      expireLeases();
      const q = counts();
      const lines = [
        '# HELP openvideo_queue_length Chunks waiting for a worker.',
        '# TYPE openvideo_queue_length gauge',
        `openvideo_queue_length ${String(q.queueLength)}`,
        '# HELP openvideo_leases_active Chunks currently leased by a worker.',
        '# TYPE openvideo_leases_active gauge',
        `openvideo_leases_active ${String(q.leasesActive)}`,
        '# HELP openvideo_chunks_failed_total Failed or expired chunk attempts.',
        '# TYPE openvideo_chunks_failed_total counter',
        `openvideo_chunks_failed_total ${String(failedTotal)}`,
        '',
      ];
      send(res, 200, lines.join('\n'), 'text/plain; version=0.0.4');
      return;
    }
    if (!path.startsWith('/v1/')) throw new HttpError(404, { code: 'OV_COORDINATOR_NOT_FOUND', severity: 'error', errorClass: 'CoordinatorError', problem: `No endpoint ${path}.`, suggestions: ['Use the /v1 API or /metrics.'] });
    if (options.token !== undefined && !tokenMatches(req.headers.authorization, options.token)) {
      throw new HttpError(401, { code: 'OV_COORDINATOR_UNAUTHORIZED', severity: 'error', errorClass: 'CoordinatorError', problem: 'The bearer token is missing or wrong.', suggestions: ['Send "Authorization: Bearer <token>".'] });
    }
    if (req.method === 'GET' && path === '/v1/queue') {
      expireLeases();
      send(res, 200, counts());
      return;
    }
    if (req.method === 'GET' && path.startsWith('/v1/jobs/')) {
      const job = jobs.get(decodeURIComponent(path.slice('/v1/jobs/'.length)));
      if (job === undefined) throw new HttpError(404, { code: 'OV_COORDINATOR_JOB_UNKNOWN', severity: 'error', errorClass: 'CoordinatorError', problem: 'Unknown job.', suggestions: ['Submit the job again with POST /v1/jobs.'] });
      expireLeases();
      const status: JobStatus = {
        id: job.id,
        state: jobState(job),
        chunks: job.chunks.map((c, index) => ({ index, state: c.state, attempts: c.attempts, ...(c.result !== undefined ? { result: c.result } : {}) })),
        diagnostics: job.diagnostics,
      };
      send(res, 200, status);
      return;
    }
    if (req.method !== 'POST') throw new HttpError(405, { code: 'OV_COORDINATOR_METHOD', severity: 'error', errorClass: 'CoordinatorError', problem: `${req.method ?? '?'} is not allowed on ${path}.`, suggestions: ['Use POST.'] });
    const body = await readBody(req, maxBody);
    if (path === '/v1/jobs') {
      send(res, 201, await submit(body));
      return;
    }
    if (!isRecord(body)) throw badRequest('The body must be a JSON object.', 'Send {"leaseId": "…"}.');
    if (path === '/v1/lease') {
      const l = lease(body);
      if (l === undefined) {
        res.writeHead(204).end();
        return;
      }
      send(res, 200, l);
      return;
    }
    if (path === '/v1/heartbeat') {
      const hit = typeof body['leaseId'] === 'string' ? findLease(body['leaseId']) : undefined;
      const c = hit?.job.chunks[hit.index];
      if (c?.lease === undefined) {
        // Lease unbekannt (abgelaufen oder Neustart): der Worker rendert weiter, das Ergebnis zählt trotzdem.
        send(res, 410, { ok: false });
        return;
      }
      c.lease.expires = now() + leaseMs;
      send(res, 200, { ok: true, leaseSeconds: leaseMs / 1000 });
      return;
    }
    if (path === '/v1/complete') {
      const hit = locate(body);
      const result = body['result'];
      if (hit === undefined || !isChunkResult(result)) throw badRequest('complete needs a known "leaseId" (or "jobId" and "index") and a valid "result".', 'Send the ChunkResult from renderChunk.');
      const c = hit.job.chunks[hit.index];
      if (c !== undefined && c.state !== 'done') {
        // Chunks sind idempotent: auch ein spätes Ergebnis einer abgelaufenen Lease ist gültig.
        journal({ e: 'done', jobId: hit.job.id, index: hit.index, result });
        c.state = 'done';
        c.result = result;
        delete c.lease;
      }
      send(res, 200, { ok: true });
      return;
    }
    if (path === '/v1/fail') {
      const hit = locate(body);
      if (hit === undefined) throw badRequest('fail needs a known "leaseId" (or "jobId" and "index").', 'Send the lease you received.');
      const c = hit.job.chunks[hit.index];
      if (c !== undefined && c.state !== 'done') {
        // `released`: der Worker gibt den Chunk beim Beenden ab; das zählt nicht als Fehlversuch.
        const failed = body['released'] !== true;
        const diagnostic = isDiagnostic(body['diagnostic']) ? body['diagnostic'] : undefined;
        journal({ e: 'attempt', jobId: hit.job.id, index: hit.index, failed, ...(diagnostic !== undefined ? { diagnostic } : {}) });
        applyAttempt(hit.job, hit.index, failed, diagnostic);
      }
      send(res, 200, { ok: true });
      return;
    }
    throw new HttpError(404, { code: 'OV_COORDINATOR_NOT_FOUND', severity: 'error', errorClass: 'CoordinatorError', problem: `No endpoint ${path}.`, suggestions: ['See the coordinator API in the scheduler README.'] });
  };

  const server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        send(res, error.status, { diagnostic: error.diagnostic });
        return;
      }
      const diagnostic: Diagnostic = error instanceof OpenVideoError ? error.diagnostic : { code: 'OV_COORDINATOR_INTERNAL', severity: 'error', errorClass: 'CoordinatorError', problem: error instanceof Error ? error.message : String(error), suggestions: ['Check the coordinator logs and the shared store.'] };
      send(res, 500, { diagnostic });
    });
  });
  const timer = setInterval(expireLeases, 1000);
  timer.unref();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = address !== null && typeof address === 'object' ? address.port : options.port;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        clearInterval(timer);
        server.close((error) => {
          if (error !== undefined) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
}
