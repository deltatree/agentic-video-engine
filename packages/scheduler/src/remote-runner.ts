/**
 * Chunk-Runner, der einen Render an den HTTP-Koordinator reicht und auf alle Chunks wartet.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { OpenVideoError, type Diagnostic } from '@agentic-video/core';
import type { ChunkResult, ChunkRunner } from '@agentic-video/render';
import type { Telemetry } from '@agentic-video/telemetry';
import { isJobStatus, type JobStatus } from './coordinator.js';
import { collectProjectFiles } from './files.js';

/** Optionen für {@link createRemoteChunkRunner}. */
export interface RemoteChunkRunnerOptions {
  readonly coordinatorUrl: string;
  readonly token?: string;
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
 * const runChunks = createRemoteChunkRunner({ coordinatorUrl: 'http://coordinator:8080', token, projectDir, project });
 * await renderVideo(env, project, { outPath: 'out/video.mp4', profile, runChunks });
 * ```
 */
export function createRemoteChunkRunner(options: RemoteChunkRunnerOptions): ChunkRunner {
  const base = options.coordinatorUrl.replace(/\/$/u, '');
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}) };
  const timeoutMs = options.requestTimeoutMs ?? 60_000;
  const call = (path: string, init: RequestInit = {}): Promise<Response> => fetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });

  const run: ChunkRunner = async (chunks, onDone) => {
    const files = await collectProjectFiles(options.projectDir);
    const traceparent = options.telemetry?.traceparent();
    const body = JSON.stringify({
      project: options.project,
      files: files.map((f) => ({ path: f.path, data: Buffer.from(f.bytes).toString('base64') })),
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
            reported.add(c.index);
            results.set(c.index, c.result);
            onDone(c.result);
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

  return (chunks, onDone) => {
    const telemetry = options.telemetry;
    if (telemetry === undefined) return run(chunks, onDone);
    return telemetry.withSpan('scheduler.remote', { chunks: chunks.length, coordinator: base }, () => run(chunks, onDone));
  };
}
