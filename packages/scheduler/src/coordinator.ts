/**
 * HTTP-Koordinator für Remote- und Kubernetes-Worker (FR-66, FR-91, Epic 16).
 *
 * Worker holen Chunks per Pull (`lease`), melden sich per `heartbeat` und geben das
 * Ergebnis mit `complete` oder `fail` ab. Ein Journal (JSON Lines) hält Jobs und
 * Ergebnisse; nach einem Neustart werden offene Chunks wieder vergeben.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { OpenVideoError, isRecord, sha256Hex, type Diagnostic } from '@agentic-video/core';
import { TieredStore, type ContentStore } from '@agentic-video/cache';
import type { ChunkRequest, ChunkResult } from '@agentic-video/render';
import { isSafeRelativePath } from './files.js';
import { inputKey, jobFrameDigest, jobFramePrefix, keyDigest } from './keys.js';
import { isChunkRequest, isChunkResult, isDiagnostic } from './protocol.js';

/** Rollen am Koordinator (Story 16.3): API reicht Jobs ein, Worker rendern, KEDA liest die Queue. */
export type CoordinatorRole = 'submit' | 'worker' | 'metrics';

/** Getrennte Bearer-Tokens je Rolle. */
export interface CoordinatorTokens {
  /** `POST /v1/jobs`, `GET /v1/jobs/<id>`, `GET /v1/queue` (Agent API). */
  readonly submit?: string;
  /** `POST /v1/lease|heartbeat|complete|fail` (Worker). */
  readonly worker?: string;
  /** Nur `GET /v1/queue` (KEDA). */
  readonly metrics?: string;
}

/** Standard-Grenzen des Koordinators (Story 16.4). */
export const COORDINATOR_LIMITS = {
  /** Größte Anfrage in Bytes. Große Dateien gehen als Verweis (`inputs/…`) in den Speicher. */
  maxBodyBytes: 64 * 1024 * 1024,
  /** Höchstzahl Chunks je Job (1 h bei 60 fps in Chunks zu 30 Frames sind 7200). */
  maxChunksPerJob: 10_000,
  /** Höchstzahl gleichzeitig laufender Jobs. */
  maxActiveJobs: 1000,
  /** Fertige Jobs bleiben so lange abrufbar (Sekunden). */
  jobTtlSeconds: 24 * 3600,
  /** Mindestlänge jedes Tokens. */
  minTokenLength: 24,
} as const;

/** Optionen für {@link startCoordinator}. */
export interface CoordinatorOptions {
  /** TCP-Port (0 = frei wählen). */
  readonly port: number;
  /** Adresse (Standard `0.0.0.0`). Außerhalb von Loopback ist ein Token Pflicht. */
  readonly host?: string;
  /** Gemeinsamer Speicher (S3 im Cluster); Projekt und Assets liegen hier. */
  readonly store: ContentStore;
  readonly journalDir: string;
  /** Ein Bearer-Token für alle Rollen (lokaler Betrieb). Im Cluster getrennte {@link tokens}. */
  readonly token?: string;
  /** Getrennte Tokens je Rolle (Story 16.3). */
  readonly tokens?: CoordinatorTokens;
  /** Dauer einer Lease ohne Heartbeat (Standard 120 s). */
  readonly leaseSeconds?: number;
  /** Versuche je Chunk (Standard 3). */
  readonly maxAttempts?: number;
  /** Größte Anfrage in Bytes (Standard 64 MiB). */
  readonly maxBodyBytes?: number;
  /** Höchstzahl Chunks je Job (Standard 10 000). */
  readonly maxChunksPerJob?: number;
  /** Höchstzahl laufender Jobs (Standard 1000). */
  readonly maxActiveJobs?: number;
  /** Wie lange fertige Jobs abrufbar bleiben, in Sekunden (Standard 24 h). Danach löscht der Koordinator sie samt Frames. */
  readonly jobTtlSeconds?: number;
  /** Uhr in Millisekunden (Standard `Date.now`); Tests setzen eine eigene. */
  readonly now?: () => number;
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
  /** Zeitpunkt, an dem der Job fertig oder gescheitert ist (für die TTL). */
  finishedAt?: number;
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

function httpError(status: number, code: string, problem: string, suggestions: readonly string[]): HttpError {
  return new HttpError(status, { code, severity: 'error', errorClass: 'CoordinatorError', problem, suggestions });
}

function badRequest(problem: string, suggestion: string): HttpError {
  return httpError(400, 'OV_COORDINATOR_REQUEST', problem, [suggestion]);
}

function tooLarge(limit: number): HttpError {
  return httpError(413, 'OV_COORDINATOR_TOO_LARGE', `The request body exceeds ${String(limit)} bytes.`, ['Upload large files to the shared store first and reference them as { "path", "key": "inputs/sha256-<hex>" }.', 'createRemoteChunkRunner does this automatically for files above its inline limit.']);
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  // Früh ablehnen, bevor etwas gepuffert wird (M2).
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > limit) throw tooLarge(limit);
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    if (!(chunk instanceof Buffer)) continue;
    size += chunk.length;
    if (size > limit) throw tooLarge(limit);
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
 * Ist `host` eine Loopback-Adresse? Nur dort darf der Koordinator ohne Token laufen (M4).
 *
 * @example
 * ```ts
 * isLoopbackAddress('127.0.0.1'); // true
 * isLoopbackAddress('0.0.0.0'); // false
 * ```
 */
export function isLoopbackAddress(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host);
}

/**
 * Prüft ein Token: mindestens {@link COORDINATOR_LIMITS.minTokenLength} Zeichen, kein Platzhalter
 * (`REPLACE…`), keine Leerzeichen. Wirft `OV_COORDINATOR_TOKEN_WEAK`.
 *
 * @example
 * ```ts
 * assertStrongToken('worker', randomBytes(32).toString('hex')); // ok
 * ```
 */
export function assertStrongToken(role: string, token: string): void {
  const problem =
    /^REPLACE/iu.test(token) ? 'is still the placeholder from the template' : token.length < COORDINATOR_LIMITS.minTokenLength ? `is shorter than ${String(COORDINATOR_LIMITS.minTokenLength)} characters` : /\s/u.test(token) ? 'contains whitespace' : undefined;
  if (problem === undefined) return;
  throw new OpenVideoError({
    code: 'OV_COORDINATOR_TOKEN_WEAK',
    errorClass: 'SecurityError',
    problem: `The ${role} token ${problem}.`,
    suggestions: ['Generate a token with `openssl rand -hex 32` and put it into the secret (deploy/k8s/overlays/production/secrets.env).'],
  });
}

/** Welche Rollen ein Endpunkt annimmt. */
function rolesFor(method: string | undefined, path: string): readonly CoordinatorRole[] | undefined {
  if (method === 'GET' && path === '/v1/queue') return ['metrics', 'submit'];
  if (method === 'GET' && path.startsWith('/v1/jobs/')) return ['submit'];
  if (method === 'POST' && path === '/v1/jobs') return ['submit'];
  if (method === 'POST' && (path === '/v1/lease' || path === '/v1/heartbeat' || path === '/v1/complete' || path === '/v1/fail')) return ['worker'];
  return undefined;
}

/**
 * Startet den HTTP-Koordinator.
 *
 * Endpunkte: `POST /v1/jobs`, `POST /v1/lease`, `POST /v1/heartbeat`, `POST /v1/complete`,
 * `POST /v1/fail`, `GET /v1/jobs/<id>`, `GET /v1/queue`, `GET /metrics` (Prometheus-Text).
 *
 * Sicherheit (Epic 16): getrennte Tokens je Rolle, Pflicht-Token außerhalb von Loopback,
 * `complete`/`fail` nur mit gültiger Lease, Ergebnis-Frames nur unter `jobs/<jobId>/frames/`,
 * Body-Limit, Chunk- und Job-Obergrenzen, TTL für fertige Jobs und ein kompaktiertes Journal.
 *
 * @example
 * ```ts
 * const coordinator = await startCoordinator({
 *   port: 8080,
 *   store: storeFromEnv(process.env, '/data'),
 *   journalDir: '/data/journal',
 *   tokens: { submit: process.env.OPENVIDEO_SUBMIT_TOKEN, worker: process.env.OPENVIDEO_WORKER_TOKEN, metrics: process.env.OPENVIDEO_METRICS_TOKEN },
 * });
 * ```
 */
export async function startCoordinator(options: CoordinatorOptions): Promise<Coordinator> {
  const leaseMs = (options.leaseSeconds ?? 120) * 1000;
  const maxAttempts = options.maxAttempts ?? 3;
  const maxBody = options.maxBodyBytes ?? COORDINATOR_LIMITS.maxBodyBytes;
  const maxChunks = options.maxChunksPerJob ?? COORDINATOR_LIMITS.maxChunksPerJob;
  const maxActive = options.maxActiveJobs ?? COORDINATOR_LIMITS.maxActiveJobs;
  const ttlMs = (options.jobTtlSeconds ?? COORDINATOR_LIMITS.jobTtlSeconds) * 1000;
  const now = options.now ?? ((): number => Date.now());
  const host = options.host ?? '0.0.0.0';

  // Tokens prüfen (M1, M4): stark, je Rolle verschieden, Pflicht außerhalb von Loopback.
  const roleTokens: Record<CoordinatorRole, string[]> = { submit: [], worker: [], metrics: [] };
  const named: [string, string | undefined][] = [
    ['shared', options.token],
    ['submit', options.tokens?.submit],
    ['worker', options.tokens?.worker],
    ['metrics', options.tokens?.metrics],
  ];
  for (const [name, value] of named) {
    if (value === undefined) continue;
    assertStrongToken(name, value);
    if (name === 'shared') for (const role of ['submit', 'worker', 'metrics'] as const) roleTokens[role].push(value);
    else if (name === 'submit' || name === 'worker' || name === 'metrics') roleTokens[name].push(value);
  }
  const perRole = [options.tokens?.submit, options.tokens?.worker, options.tokens?.metrics].filter((t): t is string => t !== undefined);
  if (new Set(perRole).size !== perRole.length) {
    throw new OpenVideoError({ code: 'OV_COORDINATOR_TOKEN_SHARED', errorClass: 'SecurityError', problem: 'Two coordinator roles use the same token; the roles would not be separated.', suggestions: ['Use a different random token for submit, worker and metrics.'] });
  }
  const open = named.every(([, value]) => value === undefined);
  if (open && !isLoopbackAddress(host)) {
    throw new OpenVideoError({
      code: 'OV_COORDINATOR_TOKEN_REQUIRED',
      errorClass: 'SecurityError',
      problem: `The coordinator would listen on ${host} without a token.`,
      suggestions: ['Set tokens for submit, worker and metrics (OPENVIDEO_SUBMIT_TOKEN, OPENVIDEO_WORKER_TOKEN, OPENVIDEO_METRICS_TOKEN).', 'Or bind to 127.0.0.1 for local use.'],
    });
  }

  const jobs = new Map<string, Job>();
  let failedTotal = 0;
  mkdirSync(options.journalDir, { recursive: true });
  const journalPath = join(options.journalDir, 'journal.jsonl');
  let journalLines = 0;

  const journal = (entry: Readonly<Record<string, unknown>>): void => {
    appendFileSync(journalPath, `${JSON.stringify(entry)}\n`);
    journalLines++;
  };

  const jobState = (job: Job): JobStatus['state'] => (job.chunks.some((c) => c.state === 'failed') ? 'failed' : job.chunks.every((c) => c.state === 'done') ? 'done' : 'running');

  /** Merkt den Abschluss eines Jobs für die TTL. */
  const markFinished = (job: Job, at: number, record: boolean): void => {
    if (job.finishedAt !== undefined || jobState(job) === 'running') return;
    job.finishedAt = at;
    if (record) journal({ e: 'finished', jobId: job.id, at });
  };

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

  const restoreJob = (j: Readonly<Record<string, unknown>>): Job | undefined => {
    const chunks = j['chunks'];
    const files = j['files'];
    if (typeof j['id'] !== 'string' || typeof j['projectKey'] !== 'string' || !Array.isArray(chunks) || !Array.isArray(files)) return undefined;
    const stored = files.filter((f): f is StoredFile => isRecord(f) && typeof f['path'] === 'string' && typeof f['key'] === 'string');
    const entries: ChunkEntry[] = [];
    for (const c of chunks) {
      // Alte Journale: Chunk-Auftrag direkt; Snapshots: { request, state, attempts, result }.
      if (isChunkRequest(c)) entries.push({ request: c, state: 'queued', attempts: 0, queuedSince: now() });
      else if (isRecord(c) && isChunkRequest(c['request'])) {
        const attempts = typeof c['attempts'] === 'number' ? c['attempts'] : 0;
        const result = c['result'];
        const entry: ChunkEntry = { request: c['request'], state: 'queued', attempts, queuedSince: now() };
        if (c['state'] === 'done' && isChunkResult(result)) {
          entry.state = 'done';
          entry.result = result;
        } else if (attempts >= maxAttempts) entry.state = 'failed';
        entries.push(entry);
      } else return undefined;
    }
    const tp = j['traceparent'];
    const diagnostics = Array.isArray(j['diagnostics']) ? j['diagnostics'].filter(isDiagnostic) : [];
    const job: Job = { id: j['id'], projectKey: j['projectKey'], files: stored, ...(typeof tp === 'string' ? { traceparent: tp } : {}), chunks: entries, diagnostics };
    if (typeof j['finishedAt'] === 'number') job.finishedAt = j['finishedAt'];
    return job;
  };

  // Journal einlesen: offene Chunks stehen danach wieder in der Warteschlange, vergebene Leases gelten weiter.
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
      if ((e['e'] === 'job' || e['e'] === 'snapshot') && isRecord(e['job'])) {
        const job = restoreJob(e['job']);
        if (job !== undefined) jobs.set(job.id, job);
      } else if (e['e'] === 'finished' && typeof e['jobId'] === 'string' && typeof e['at'] === 'number') {
        const job = jobs.get(e['jobId']);
        if (job !== undefined) job.finishedAt = e['at'];
      } else if (typeof e['jobId'] === 'string' && typeof e['index'] === 'number') {
        const job = jobs.get(e['jobId']);
        const c = job?.chunks[e['index']];
        if (job === undefined || c === undefined) continue;
        if (e['e'] === 'done' && isChunkResult(e['result'])) {
          c.state = 'done';
          c.result = e['result'];
          delete c.lease;
        } else if (e['e'] === 'attempt') {
          applyAttempt(job, e['index'], e['failed'] === true, isDiagnostic(e['diagnostic']) ? e['diagnostic'] : undefined);
        } else if (e['e'] === 'lease' && typeof e['leaseId'] === 'string' && c.state === 'queued') {
          // Nach einem Neustart bleibt eine Lease gültig und bekommt eine volle Laufzeit.
          c.state = 'leased';
          c.lease = { id: e['leaseId'], worker: typeof e['worker'] === 'string' ? e['worker'] : 'unknown', expires: now() + leaseMs };
        }
      }
    }
  }
  for (const job of jobs.values()) markFinished(job, now(), false);

  /** Schreibt das Journal als Momentaufnahme neu (atomar per Umbenennen); entfernt abgelaufene Einträge. */
  const compact = (): void => {
    const lines: string[] = [];
    for (const job of jobs.values()) {
      const snapshot = {
        id: job.id,
        projectKey: job.projectKey,
        files: job.files,
        ...(job.traceparent !== undefined ? { traceparent: job.traceparent } : {}),
        chunks: job.chunks.map((c) => ({ request: c.request, state: c.state === 'done' ? 'done' : 'open', attempts: c.attempts, ...(c.result !== undefined ? { result: c.result } : {}) })),
        diagnostics: job.diagnostics,
        ...(job.finishedAt !== undefined ? { finishedAt: job.finishedAt } : {}),
      };
      lines.push(JSON.stringify({ e: 'snapshot', job: snapshot }));
      job.chunks.forEach((c, index) => {
        if (c.lease !== undefined) lines.push(JSON.stringify({ e: 'lease', jobId: job.id, index, leaseId: c.lease.id, worker: c.lease.worker }));
      });
    }
    const tmp = `${journalPath}.tmp`;
    writeFileSync(tmp, lines.length > 0 ? `${lines.join('\n')}\n` : '');
    renameSync(tmp, journalPath);
    journalLines = lines.length;
  };
  compact();

  /** Löscht die Frames eines Jobs aus dem gemeinsamen Speicher (auch die entfernte Stufe). */
  const removeJobData = async (jobId: string): Promise<void> => {
    const target = options.store instanceof TieredStore ? options.store.remote : options.store;
    try {
      for (const entry of await target.list(`jobs/${jobId}/`)) await target.delete(entry.key);
      if (target !== options.store) for (const entry of await options.store.list(`jobs/${jobId}/`)) await options.store.delete(entry.key);
    } catch (error) {
      process.emitWarning(`Could not remove the frames of job ${jobId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** Entfernt fertige Jobs nach Ablauf der TTL und kompaktiert das Journal (M2). */
  const sweep = (): void => {
    const t = now();
    const expired: string[] = [];
    for (const job of jobs.values()) if (job.finishedAt !== undefined && t - job.finishedAt >= ttlMs) expired.push(job.id);
    for (const id of expired) {
      jobs.delete(id);
      void removeJobData(id);
    }
    // Viele Anhänge seit der letzten Momentaufnahme: ebenfalls kompaktieren.
    if (expired.length > 0 || journalLines > 10_000) compact();
  };

  const expireLeases = (): void => {
    const t = now();
    for (const job of jobs.values()) {
      job.chunks.forEach((c, index) => {
        if (c.state === 'leased' && c.lease !== undefined && c.lease.expires <= t) {
          const diagnostic: Diagnostic = { code: 'OV_COORDINATOR_LEASE_EXPIRED', severity: 'warning', errorClass: 'CoordinatorError', problem: `Lease of chunk ${String(index)} (worker ${c.lease.worker}) expired.`, suggestions: ['Check the worker logs; the chunk is given to another worker.'] };
          journal({ e: 'attempt', jobId: job.id, index, failed: true, diagnostic });
          applyAttempt(job, index, true, diagnostic);
          markFinished(job, t, true);
        }
      });
    }
  };

  /** Findet den Chunk einer aktuell gültigen Lease (Story 16.2: ohne gültige Lease kein Ergebnis). */
  const findLease = (leaseId: unknown): { job: Job; index: number; chunk: ChunkEntry } | undefined => {
    if (typeof leaseId !== 'string' || leaseId === '') return undefined;
    for (const job of jobs.values()) {
      const index = job.chunks.findIndex((c) => c.state === 'leased' && c.lease?.id === leaseId);
      const chunk = job.chunks[index];
      if (chunk !== undefined) return { job, index, chunk };
    }
    return undefined;
  };

  const requireLease = (body: Readonly<Record<string, unknown>>, action: string): { job: Job; index: number; chunk: ChunkEntry } => {
    expireLeases();
    const hit = findLease(body['leaseId']);
    if (hit === undefined) {
      throw httpError(409, 'OV_COORDINATOR_LEASE_INVALID', `${action} needs the "leaseId" of a current lease; it is unknown, expired or already finished.`, ['Lease a new chunk with POST /v1/lease.', 'Keep the lease alive with POST /v1/heartbeat while rendering.']);
    }
    return hit;
  };

  /** Prüft ein Worker-Ergebnis: passender Bereich und nur Frame-Schlüssel unter `jobs/<jobId>/frames/` (T8). */
  const checkResult = (job: Job, chunk: ChunkEntry, result: ChunkResult): void => {
    const count = chunk.request.end - chunk.request.start;
    if (result.start !== chunk.request.start || result.end !== chunk.request.end || result.keys.length !== count || result.frameHashes.length !== count) {
      throw httpError(400, 'OV_COORDINATOR_RESULT_INVALID', `The result does not cover frames ${String(chunk.request.start)}–${String(chunk.request.end)} of the leased chunk.`, ['Send the ChunkResult of exactly the leased chunk.']);
    }
    const foreign = result.keys.find((key) => jobFrameDigest(job.id, key) === undefined);
    if (foreign !== undefined) {
      throw httpError(400, 'OV_COORDINATOR_RESULT_INVALID', `Frame key "${foreign.slice(0, 200)}" is outside ${jobFramePrefix(job.id)}.`, ['Upload each frame to jobs/<jobId>/frames/<sha256 of the bytes> and report those keys.']);
    }
  };

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
    if (chunks.length > maxChunks) {
      throw httpError(413, 'OV_COORDINATOR_TOO_MANY_CHUNKS', `The job has ${String(chunks.length)} chunks; the limit is ${String(maxChunks)}.`, ['Use larger chunks (chunkSize) or split the render into several jobs.']);
    }
    if (counts().jobsRunning >= maxActive) {
      throw httpError(429, 'OV_COORDINATOR_BUSY', `${String(maxActive)} jobs are already running.`, ['Retry when running jobs have finished.', 'Scale the workers or raise maxActiveJobs.']);
    }
    const projectBytes = new TextEncoder().encode(JSON.stringify(body['project']));
    const projectKey = inputKey(sha256Hex(projectBytes));
    await options.store.put(projectKey, projectBytes);
    const files: StoredFile[] = [];
    for (const f of body['files']) {
      if (!isRecord(f) || typeof f['path'] !== 'string' || !isSafeRelativePath(f['path'])) {
        throw badRequest('Each file needs a safe relative "path" and base64 "data" or a store "key".', 'Use paths like "assets/logo.png" without "..".');
      }
      if (typeof f['data'] === 'string') {
        const bytes = new Uint8Array(Buffer.from(f['data'], 'base64'));
        const key = inputKey(sha256Hex(bytes));
        await options.store.put(key, bytes);
        files.push({ path: f['path'], key });
      } else if (typeof f['key'] === 'string' && keyDigest(f['key']) !== undefined && f['key'] === inputKey(keyDigest(f['key']) ?? '')) {
        // Verweis auf eine vom Aufrufer hochgeladene Datei; Worker prüfen den Hash beim Lesen.
        if (!(await options.store.has(f['key']))) throw badRequest(`The shared store has no entry "${f['key']}".`, 'Upload the file to the shared store before submitting the job.');
        files.push({ path: f['path'], key: f['key'] });
      } else {
        throw badRequest('Each file needs base64 "data" or a "key" of the form "inputs/sha256-<hex>".', 'Send small files inline and large files as a store reference.');
      }
    }
    const tp = body['traceparent'];
    const job: Job = { id: randomUUID(), projectKey, files, ...(typeof tp === 'string' ? { traceparent: tp } : {}), chunks: chunks.map((request) => ({ request, state: 'queued', attempts: 0, queuedSince: now() })), diagnostics: [] };
    journal({ e: 'job', job: { id: job.id, projectKey, files, traceparent: job.traceparent, chunks } });
    jobs.set(job.id, job);
    return { jobId: job.id, chunks: chunks.length };
  };

  const lease = (body: Readonly<Record<string, unknown>>): Lease | undefined => {
    expireLeases();
    const worker = typeof body['worker'] === 'string' ? body['worker'].slice(0, 200) : 'unknown';
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
    journal({ e: 'lease', jobId: job.id, index, leaseId, worker });
    c.state = 'leased';
    c.lease = { id: leaseId, worker, expires: now() + leaseMs };
    return { leaseId, jobId: job.id, index, request: c.request, ...(job.traceparent !== undefined ? { traceparent: job.traceparent } : {}), projectKey: job.projectKey, files: job.files, leaseSeconds: leaseMs / 1000 };
  };

  /** Prüft das Bearer-Token für die Rollen eines Endpunkts (401 ohne passendes Token, 403 bei falscher Rolle). */
  const authorize = (req: IncomingMessage, roles: readonly CoordinatorRole[]): void => {
    if (open) return;
    const header = req.headers.authorization;
    if (roles.some((role) => roleTokens[role].some((t) => tokenMatches(header, t)))) return;
    const other = (['submit', 'worker', 'metrics'] as const).some((role) => roleTokens[role].some((t) => tokenMatches(header, t)));
    if (other) throw httpError(403, 'OV_COORDINATOR_FORBIDDEN', `This token may not use ${req.method ?? '?'} ${req.url ?? ''}; it needs the ${roles.join(' or ')} role.`, ['Use the token of the matching role (submit for the API, worker for workers, metrics for KEDA).']);
    throw httpError(401, 'OV_COORDINATOR_UNAUTHORIZED', 'The bearer token is missing or wrong.', ['Send "Authorization: Bearer <token>".']);
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
    const roles = rolesFor(req.method, path);
    if (roles === undefined) {
      if (path.startsWith('/v1/') && (path === '/v1/jobs' || path === '/v1/lease' || path === '/v1/heartbeat' || path === '/v1/complete' || path === '/v1/fail' || path === '/v1/queue')) {
        throw httpError(405, 'OV_COORDINATOR_METHOD', `${req.method ?? '?'} is not allowed on ${path}.`, ['See the coordinator API in the scheduler README.']);
      }
      throw httpError(404, 'OV_COORDINATOR_NOT_FOUND', `No endpoint ${path}.`, ['Use the /v1 API or /metrics.']);
    }
    authorize(req, roles);
    sweep();
    if (req.method === 'GET' && path === '/v1/queue') {
      expireLeases();
      send(res, 200, counts());
      return;
    }
    if (req.method === 'GET') {
      const job = jobs.get(decodeURIComponent(path.slice('/v1/jobs/'.length)));
      if (job === undefined) throw httpError(404, 'OV_COORDINATOR_JOB_UNKNOWN', 'Unknown job.', ['Submit the job again with POST /v1/jobs.', 'Finished jobs are removed after jobTtlSeconds.']);
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
      const hit = findLease(body['leaseId']);
      if (hit?.chunk.lease === undefined) {
        // Lease unbekannt oder abgelaufen: das Ergebnis dieses Workers wird nicht mehr angenommen.
        send(res, 410, { ok: false });
        return;
      }
      hit.chunk.lease.expires = now() + leaseMs;
      send(res, 200, { ok: true, leaseSeconds: leaseMs / 1000 });
      return;
    }
    if (path === '/v1/complete') {
      const hit = requireLease(body, 'complete');
      const result = body['result'];
      if (!isChunkResult(result)) throw badRequest('complete needs a valid "result".', 'Send the ChunkResult from renderChunk.');
      checkResult(hit.job, hit.chunk, result);
      journal({ e: 'done', jobId: hit.job.id, index: hit.index, result });
      hit.chunk.state = 'done';
      hit.chunk.result = result;
      delete hit.chunk.lease;
      markFinished(hit.job, now(), true);
      send(res, 200, { ok: true });
      return;
    }
    // path === '/v1/fail'
    const hit = requireLease(body, 'fail');
    // `released`: der Worker gibt den Chunk beim Beenden ab; das zählt nicht als Fehlversuch.
    const failed = body['released'] !== true;
    const diagnostic = isDiagnostic(body['diagnostic']) ? body['diagnostic'] : undefined;
    journal({ e: 'attempt', jobId: hit.job.id, index: hit.index, failed, ...(diagnostic !== undefined ? { diagnostic } : {}) });
    applyAttempt(hit.job, hit.index, failed, diagnostic);
    markFinished(hit.job, now(), true);
    send(res, 200, { ok: true });
  };

  const server = createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        // Nach einem abgelehnten, zu großen Body die Verbindung schließen statt weiterzulesen.
        if (error.status === 413) res.shouldKeepAlive = false;
        send(res, error.status, { diagnostic: error.diagnostic });
        if (error.status === 413) req.destroy();
        return;
      }
      const diagnostic: Diagnostic = error instanceof OpenVideoError ? error.diagnostic : { code: 'OV_COORDINATOR_INTERNAL', severity: 'error', errorClass: 'CoordinatorError', problem: error instanceof Error ? error.message : String(error), suggestions: ['Check the coordinator logs and the shared store.'] };
      send(res, 500, { diagnostic });
    });
  });
  const timer = setInterval(() => {
    expireLeases();
    sweep();
  }, 1000);
  timer.unref();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => {
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
