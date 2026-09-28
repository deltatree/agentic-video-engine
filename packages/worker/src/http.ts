/**
 * Pull-Worker für Remote- und Kubernetes-Betrieb: `lease` → rendern → `complete`/`fail`.
 *
 * Frames gehen in den gemeinsamen Speicher (S3 über `storeFromEnv`). Während des Renderns
 * hält ein Heartbeat die Lease. Bei Abbruch (SIGTERM) gibt der Worker den laufenden Chunk ab.
 */
import { hostname } from 'node:os';
import { createCache, storeFromEnv, type ContentStore } from '@agentic-video/cache';
import { OpenVideoError, isRecord, type Diagnostic } from '@agentic-video/core';
import { createNodeEnvironment, renderChunk, type NodeEnvironment } from '@agentic-video/render';
import { isLease, type Lease, type ProjectFile } from '@agentic-video/scheduler';
import type { Telemetry } from '@agentic-video/telemetry';
import { toDiagnostic, workerTelemetry, writeTempProject, type TempProject } from './workspace.js';

/** Optionen für {@link runWorkerHttp}. */
export interface HttpWorkerOptions {
  readonly coordinatorUrl: string;
  readonly token?: string;
  /** Gemeinsamer Speicher (Standard: `storeFromEnv(process.env, …)`, also S3 mit lokaler Stufe). */
  readonly store?: ContentStore;
  /** Name des Workers (Standard: `<hostname>-<pid>`). */
  readonly worker?: string;
  /** Beendet die Schleife; ein laufender Chunk wird abgegeben. */
  readonly signal?: AbortSignal;
  /** Wartezeit, wenn keine Arbeit da ist (Standard 1000 ms). */
  readonly pollIntervalMs?: number;
  /** Zeitgrenze je HTTP-Anfrage (Standard 30 000 ms). */
  readonly requestTimeoutMs?: number;
  /** Wie lange `complete`/`fail` bei nicht erreichbarem Koordinator wiederholt werden (Standard 120 000 ms). */
  readonly deliveryTimeoutMs?: number;
  readonly telemetry?: Telemetry;
}

/** Ergebnis von {@link runWorkerHttp}. */
export interface HttpWorkerSummary {
  readonly completed: number;
  readonly failed: number;
  readonly released: number;
}

interface JobSession {
  readonly jobId: string;
  readonly env: NodeEnvironment;
  readonly project: Readonly<Record<string, unknown>>;
  readonly temp: TempProject;
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Führt den Pull-Worker aus, bis `signal` abbricht.
 *
 * @example
 * ```ts
 * const stop = new AbortController();
 * process.once('SIGTERM', () => stop.abort());
 * await runWorkerHttp({ coordinatorUrl: 'http://coordinator:8080', token: process.env.OPENVIDEO_WORKER_TOKEN, signal: stop.signal });
 * ```
 */
export async function runWorkerHttp(options: HttpWorkerOptions): Promise<HttpWorkerSummary> {
  const base = options.coordinatorUrl.replace(/\/$/u, '');
  const worker = options.worker ?? `${hostname()}-${String(process.pid)}`;
  const telemetry = options.telemetry ?? workerTelemetry((line) => process.stderr.write(`${line}\n`));
  const store = options.store ?? storeFromEnv(process.env, process.cwd());
  const cache = createCache(store);
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}) };
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  const post = (path: string, body: unknown): Promise<Response> => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const signal = options.signal;
  let session: JobSession | undefined;
  const summary = { completed: 0, failed: 0, released: 0 };

  /** Meldet ein Ergebnis zuverlässig: wiederholt bei Netzfehlern und 5xx (Koordinator-Neustart). */
  const deliver = async (path: string, body: unknown): Promise<void> => {
    const deadline = performance.now() + (options.deliveryTimeoutMs ?? 120_000);
    for (let attempt = 1; ; attempt++) {
      let reason: string;
      try {
        const res = await post(path, body);
        if (res.ok) return;
        reason = `HTTP ${String(res.status)} ${(await res.text()).slice(0, 300)}`;
        if (res.status < 500) {
          telemetry.logger.error('coordinator rejected report', { worker, path, reason });
          return;
        }
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error);
      }
      if (performance.now() > deadline) {
        telemetry.logger.error('giving up report', { worker, path, attempts: attempt, reason });
        return;
      }
      telemetry.logger.warn('report failed, retrying', { worker, path, attempt, reason });
      await pause(Math.min(5000, 250 * attempt), undefined);
    }
  };

  const openJob = async (lease: Lease): Promise<JobSession> => {
    if (session?.jobId === lease.jobId) return session;
    const previous = session;
    session = undefined;
    if (previous !== undefined) {
      await previous.env.dispose();
      await previous.temp.remove();
    }
    const missing = (key: string): OpenVideoError =>
      new OpenVideoError({ code: 'OV_WORKER_STORE_MISSING', errorClass: 'WorkerError', problem: `The shared store has no entry "${key}".`, details: { store: store.name }, suggestions: ['Point coordinator and workers at the same store (OPENVIDEO_S3_*).'] });
    const projectBytes = await store.get(lease.projectKey);
    if (projectBytes === undefined) throw missing(lease.projectKey);
    const project: unknown = JSON.parse(new TextDecoder().decode(projectBytes));
    if (!isRecord(project)) throw new OpenVideoError({ code: 'OV_WORKER_PROJECT_INVALID', errorClass: 'WorkerError', problem: 'The stored project is not a JSON object.', suggestions: ['Submit the job again.'] });
    const files: ProjectFile[] = [];
    for (const f of lease.files) {
      const bytes = await store.get(f.key);
      if (bytes === undefined) throw missing(f.key);
      files.push({ path: f.path, bytes });
    }
    const temp = await writeTempProject(files);
    try {
      const env = await createNodeEnvironment({ projectDir: temp.dir, project, cache, telemetry });
      session = { jobId: lease.jobId, env, project, temp };
      return session;
    } catch (error) {
      await temp.remove();
      throw error;
    }
  };

  const work = async (lease: Lease): Promise<void> => {
    const ids = { leaseId: lease.leaseId, jobId: lease.jobId, index: lease.index };
    const beat = setInterval(
      () => {
        post('/v1/heartbeat', { leaseId: lease.leaseId }).then(
          (res) => {
            if (res.status === 410) telemetry.logger.warn('lease lost; finishing chunk anyway', { worker, ...ids });
          },
          (error: unknown) => {
            telemetry.logger.warn('heartbeat failed', { worker, ...ids, reason: error instanceof Error ? error.message : String(error) });
          },
        );
      },
      Math.max(1000, (lease.leaseSeconds * 1000) / 3),
    );
    try {
      const result = await telemetry.withRemoteParent(lease.traceparent, () =>
        telemetry.withSpan('worker.chunk', { worker, job: lease.jobId, start: lease.request.start, end: lease.request.end }, async () => {
          const s = await openJob(lease);
          const r = await renderChunk(s.env, s.project, lease.request, signal);
          telemetry.logger.info('chunk rendered', { worker, job: lease.jobId, start: r.start, end: r.end, rendered: r.rendered, fromCache: r.fromCache });
          return r;
        }),
      );
      await deliver('/v1/complete', { ...ids, result: { ...result, worker } });
      summary.completed++;
    } catch (error) {
      const diagnostic: Diagnostic = toDiagnostic(error);
      if (signal?.aborted === true) {
        telemetry.logger.info('releasing chunk on shutdown', { worker, ...ids });
        await deliver('/v1/fail', { ...ids, released: true, diagnostic });
        summary.released++;
      } else {
        telemetry.logger.error('chunk failed', { worker, ...ids, code: diagnostic.code, problem: diagnostic.problem });
        await deliver('/v1/fail', { ...ids, diagnostic });
        summary.failed++;
      }
    } finally {
      clearInterval(beat);
    }
  };

  try {
    while (signal?.aborted !== true) {
      let lease: Lease | undefined;
      try {
        const res = await post('/v1/lease', { worker });
        if (res.status === 200) {
          const value: unknown = await res.json();
          if (isLease(value)) lease = value;
          else telemetry.logger.error('invalid lease from coordinator', { worker });
        } else if (res.status !== 204) {
          telemetry.logger.warn('lease request failed', { worker, status: res.status, body: (await res.text()).slice(0, 300) });
        }
      } catch (error) {
        telemetry.logger.warn('coordinator not reachable', { worker, coordinator: base, reason: error instanceof Error ? error.message : String(error) });
      }
      if (lease === undefined) {
        await pause(options.pollIntervalMs ?? 1000, signal);
        continue;
      }
      await work(lease);
    }
  } finally {
    if (session !== undefined) {
      await session.env.dispose();
      await session.temp.remove();
    }
  }
  telemetry.logger.info('worker stopped', { worker, ...summary });
  return summary;
}
