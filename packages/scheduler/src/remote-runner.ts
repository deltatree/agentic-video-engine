/**
 * Chunk-Runner, der einen Render an den HTTP-Koordinator reicht und auf alle Chunks wartet.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { TieredStore, type ContentStore } from '@agentic-video/cache';
import { OpenVideoError, type Diagnostic } from '@agentic-video/core';
import type { ChunkRequest, ChunkResult, ChunkRunner } from '@agentic-video/render';
import type { Telemetry } from '@agentic-video/telemetry';
import { isJobStatus, type JobStatus } from './coordinator.js';
import { collectProjectFiles } from './files.js';
import { assertContentMatches, digestHex, inputKey, jobFrameDigest, jobFramePrefix } from './keys.js';

/** Optionen für {@link createRemoteChunkRunner}. */
export interface RemoteChunkRunnerOptions {
  readonly coordinatorUrl: string;
  /** Token der Rolle `submit` (Story 16.3). */
  readonly token?: string;
  /**
   * Gemeinsamer Speicher wie bei den Workern (S3). Der Runner prüft darin jeden gemeldeten Frame
   * (Präfix `jobs/<jobId>/frames/`, SHA-256) und legt große Projektdateien als Verweis ab (T8).
   */
  readonly store: ContentStore;
  /** Dateien ab dieser Größe gehen als Verweis `inputs/sha256-…` statt Base64 in den Job (Standard 4 MiB). */
  readonly inlineFileLimit?: number;
  readonly projectDir: string;
  readonly project: Readonly<Record<string, unknown>>;
  /** Für Spans und Trace-Kontext (Standard: kein Span, nur der aktive Kontext). */
  readonly telemetry?: Telemetry;
  /** Abfrage-Intervall in ms (Standard 500). */
  readonly pollIntervalMs?: number;
  /** Wie lange der Koordinator am Stück unerreichbar sein darf (Standard 120 000 ms). */
  readonly unreachableTimeoutMs?: number;
  /** Zeitgrenze je HTTP-Anfrage (Standard 60 000 ms). */
  readonly requestTimeoutMs?: number;
}

/** Vorsilbe der geprüften Remote-Frames in der Frame-Ebene des Aufrufers (inhaltsadressiert). */
const VERIFIED_FRAME = 'remote-sha256-';

function frameError(code: string, problem: string): OpenVideoError {
  return new OpenVideoError({
    code,
    errorClass: 'SchedulerError',
    problem,
    suggestions: ['Check the worker logs and who can write to the shared store (ADR 0023).', 'Render again; unverified frames are never used.'],
  });
}

/**
 * Übernimmt die Frames eines Worker-Ergebnisses nur nach Prüfung (T8): jeder Schlüssel liegt unter
 * `jobs/<jobId>/frames/`, der Inhalt passt zu seinem SHA-256, und die Zahl passt zum Chunk.
 * Geprüfte Frames landen lokal in der Frame-Ebene unter `remote-sha256-<hex>`; nur diese Schlüssel
 * gibt der Runner an `renderVideo` weiter.
 */
async function adoptFrames(store: ContentStore, jobId: string, request: ChunkRequest | undefined, result: ChunkResult): Promise<ChunkResult> {
  const count = result.end - result.start;
  if (request !== undefined && (request.start !== result.start || request.end !== result.end)) {
    throw frameError('OV_SCHEDULER_RESULT_INVALID', `A worker reported frames ${String(result.start)}–${String(result.end)} for chunk ${String(request.start)}–${String(request.end)}.`);
  }
  if (result.keys.length !== count || result.frameHashes.length !== count) {
    throw frameError('OV_SCHEDULER_RESULT_INVALID', `A worker reported ${String(result.keys.length)} frames for a chunk of ${String(count)}.`);
  }
  // Lesen aus der entfernten Stufe; geschrieben wird nur lokal (kein zweiter Upload, kein fremdes Präfix).
  const source = store instanceof TieredStore ? store.remote : store;
  const target = store instanceof TieredStore ? store.local : store;
  const keys: string[] = [];
  for (const key of result.keys) {
    const hex = jobFrameDigest(jobId, key);
    if (hex === undefined) throw frameError('OV_SCHEDULER_FRAME_FOREIGN', `A worker reported frame key "${key.slice(0, 200)}" outside ${jobFramePrefix(jobId)}.`);
    const local = `frame/${VERIFIED_FRAME}${hex}`;
    if (!(await target.has(local))) {
      const bytes = await source.get(key);
      if (bytes === undefined) throw frameError('OV_SCHEDULER_FRAME_MISSING', `Frame "${key}" is missing in the shared store.`);
      assertContentMatches(key, bytes, 'SchedulerError');
      await target.put(local, bytes);
    }
    keys.push(`${VERIFIED_FRAME}${hex}`);
  }
  return { ...result, keys };
}

function unreachable(url: string, reason: string): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_SCHEDULER_COORDINATOR_UNREACHABLE',
    errorClass: 'SchedulerError',
    problem: `The coordinator at ${url} is not reachable: ${reason}`,
    suggestions: ['Check that the coordinator runs and the URL is right.', 'Check the bearer token.'],
  });
}

async function responseDiagnostic(res: Response): Promise<string> {
  const text = await res.text();
  return `HTTP ${String(res.status)} ${text.slice(0, 500)}`;
}

/**
 * Erzeugt einen {@link ChunkRunner} für Remote-Worker über den Koordinator.
 *
 * @example
 * ```ts
 * const runChunks = createRemoteChunkRunner({ coordinatorUrl: 'http://coordinator:8080', token, store: env.cache.store, projectDir, project });
 * await renderVideo(env, project, { outPath: 'out/video.mp4', profile, runChunks });
 * ```
 */
export function createRemoteChunkRunner(options: RemoteChunkRunnerOptions): ChunkRunner {
  const base = options.coordinatorUrl.replace(/\/$/u, '');
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}) };
  const timeoutMs = options.requestTimeoutMs ?? 60_000;
  const call = (path: string, init: RequestInit = {}): Promise<Response> => fetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });

  const inlineLimit = options.inlineFileLimit ?? 4 * 1024 * 1024;
  const run: ChunkRunner = async (chunks, onDone, runOptions) => {
    const signal = runOptions?.signal;
    const files = await collectProjectFiles(options.projectDir);
    const traceparent = options.telemetry?.traceparent();
    const listed: { path: string; data?: string; key?: string }[] = [];
    for (const f of files) {
      if (f.bytes.length <= inlineLimit) {
        listed.push({ path: f.path, data: Buffer.from(f.bytes).toString('base64') });
        continue;
      }
      // Große Dateien nicht im Job-Body (Body-Limit des Koordinators), sondern inhaltsadressiert im Speicher.
      const key = inputKey(digestHex(f.bytes));
      if (!(await options.store.has(key))) await options.store.put(key, f.bytes);
      listed.push({ path: f.path, key });
    }
    const body = JSON.stringify({
      project: options.project,
      files: listed,
      chunks,
      ...(traceparent !== undefined ? { traceparent } : {}),
    });
    let submitted: Response;
    try {
      submitted = await call('/v1/jobs', { method: 'POST', body });
    } catch (error) {
      throw unreachable(base, error instanceof Error ? error.message : String(error));
    }
    if (submitted.status !== 201) throw unreachable(base, await responseDiagnostic(submitted));
    const accepted: unknown = await submitted.json();
    const jobId = typeof accepted === 'object' && accepted !== null && 'jobId' in accepted && typeof accepted.jobId === 'string' ? accepted.jobId : undefined;
    if (jobId === undefined) throw unreachable(base, 'The answer to POST /v1/jobs has no jobId.');

    const reported = new Set<number>();
    const results = new Map<number, ChunkResult>();
    let lastContact = performance.now();
    const pollMs = options.pollIntervalMs ?? 500;
    const maxDown = options.unreachableTimeoutMs ?? 120_000;
    for (;;) {
      if (signal?.aborted === true) {
        // Abbruch (Story 18.8): Job am Koordinator beenden; Worker verlieren ihre Leases und hören auf.
        try {
          await call(`/v1/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
        } catch (error) {
          options.telemetry?.logger.warn('cancelling the remote job failed', { coordinator: base, jobId, reason: error instanceof Error ? error.message : String(error) });
        }
        throw new OpenVideoError({ code: 'OV_RENDER_CANCELLED', errorClass: 'RenderError', problem: 'The render was cancelled.', suggestions: [] });
      }
      let status: JobStatus | undefined;
      try {
        const res = await call(`/v1/jobs/${encodeURIComponent(jobId)}`);
        if (res.ok) {
          const value: unknown = await res.json();
          if (isJobStatus(value)) status = value;
        } else if (res.status === 404) {
          throw new OpenVideoError({ code: 'OV_SCHEDULER_JOB_LOST', errorClass: 'SchedulerError', problem: `The coordinator no longer knows job ${jobId}.`, suggestions: ['Keep the coordinator journal on a persistent volume.', 'Render again.'] });
        }
      } catch (error) {
        if (error instanceof OpenVideoError) throw error;
        // Koordinator kurz weg (z. B. Neustart): weiter abfragen bis zur Zeitgrenze.
        options.telemetry?.logger.warn('coordinator not reachable', { coordinator: base, reason: error instanceof Error ? error.message : String(error) });
      }
      if (status !== undefined) {
        lastContact = performance.now();
        for (const c of status.chunks) {
          if (c.result !== undefined && !reported.has(c.index)) {
            const adopted = await adoptFrames(options.store, jobId, chunks[c.index], c.result);
            reported.add(c.index);
            results.set(c.index, adopted);
            onDone(adopted);
          }
        }
        if (status.state === 'failed') {
          const last: Diagnostic | undefined = status.diagnostics[status.diagnostics.length - 1];
          throw new OpenVideoError({
            code: 'OV_SCHEDULER_CHUNK_FAILED',
            errorClass: 'SchedulerError',
            problem: `Job ${jobId} failed on the remote workers.${last !== undefined ? ` Last error: ${last.code}: ${last.problem}` : ''}`,
            suggestions: ['Check the worker logs.', 'Render one frame locally to see the error.'],
          });
        }
        if (status.state === 'done') break;
      } else if (performance.now() - lastContact > maxDown) {
        throw unreachable(base, `no answer for ${String(maxDown)} ms`);
      }
      await sleep(pollMs);
    }
    return chunks.map((_, i) => results.get(i)).filter((r): r is ChunkResult => r !== undefined);
  };

  return (chunks, onDone, runOptions) => {
    const telemetry = options.telemetry;
    if (telemetry === undefined) return run(chunks, onDone, runOptions);
    return telemetry.withSpan('scheduler.remote', { chunks: chunks.length, coordinator: base }, () => run(chunks, onDone, runOptions));
  };
}
