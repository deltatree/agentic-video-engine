/**
 * Render-Jobs (FR-23): Status, Fortschritt, Abbruch, Journal auf der Platte.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { OpenVideoError, isRecord, type Diagnostic } from '@agentic-video/core';
import type { Telemetry } from '@agentic-video/telemetry';
import { writeAtomic } from './workspace.js';

/** Zustand eines Jobs. */
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** Öffentliche Sicht auf einen Job. */
export interface JobInfo {
  readonly id: string;
  readonly kind: string;
  readonly projectId: string;
  readonly state: JobState;
  readonly progress: { readonly stage: string; readonly done: number; readonly total: number };
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly result?: unknown;
  readonly error?: Diagnostic;
  readonly traceparent?: string;
}

/** Signal für Abbruch und Fortschritt, das ein Job-Rumpf erhält. */
export interface JobControl {
  readonly signal: { readonly aborted: boolean };
  progress(stage: string, done: number, total: number): void;
}

const STATES: readonly JobState[] = ['queued', 'running', 'succeeded', 'failed', 'cancelled'];

/** Liest einen Journal-Eintrag geprüft ein. */
export function parseJobInfo(raw: unknown): JobInfo | undefined {
  if (!isRecord(raw)) return undefined;
  const { id, kind, projectId, state, progress, createdAt } = raw;
  const known = STATES.find((s) => s === state);
  if (typeof id !== 'string' || typeof kind !== 'string' || typeof projectId !== 'string' || known === undefined || typeof createdAt !== 'string' || !isRecord(progress)) return undefined;
  const error = raw['error'];
  return {
    id,
    kind,
    projectId,
    state: known,
    progress: { stage: String(progress['stage']), done: Number(progress['done']), total: Number(progress['total']) },
    createdAt,
    ...(typeof raw['startedAt'] === 'string' ? { startedAt: raw['startedAt'] } : {}),
    ...(typeof raw['finishedAt'] === 'string' ? { finishedAt: raw['finishedAt'] } : {}),
    ...('result' in raw ? { result: raw['result'] } : {}),
    ...(isRecord(error) && typeof error['code'] === 'string' && typeof error['problem'] === 'string'
      ? { error: { code: error['code'], severity: 'error' as const, errorClass: typeof error['errorClass'] === 'string' ? error['errorClass'] : 'JobError', problem: error['problem'], suggestions: Array.isArray(error['suggestions']) ? error['suggestions'].map(String) : [] } }
      : {}),
    ...(typeof raw['traceparent'] === 'string' ? { traceparent: raw['traceparent'] } : {}),
  };
}

interface MutableJob {
  info: JobInfo;
  abort: { aborted: boolean };
}

/**
 * Führt lang laufende Aufträge aus und hält ihren Zustand (auch über Neustarts, als Journal).
 *
 * @example
 * ```ts
 * const id = jobs.start('video.render', 'demo', async (control) => renderVideo(…));
 * jobs.status(id);
 * ```
 */
export class JobManager {
  private readonly jobs = new Map<string, MutableJob>();
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(
    private readonly dir: string,
    private readonly telemetry: Telemetry,
    private readonly maxConcurrent = 1,
  ) {}

  /** Lädt das Journal; unterbrochene Jobs gelten als fehlgeschlagen. */
  async restore(): Promise<void> {
    if (!existsSync(this.dir)) return;
    for (const file of await readdir(this.dir)) {
      if (!file.endsWith('.json')) continue;
      const raw: unknown = JSON.parse(await readFile(join(this.dir, file), 'utf8'));
      const info = parseJobInfo(raw);
      if (info === undefined) continue;
      const interrupted = info.state === 'queued' || info.state === 'running';
      this.jobs.set(info.id, {
        info: interrupted
          ? { ...info, state: 'failed', error: { code: 'OV_JOB_INTERRUPTED', severity: 'error', errorClass: 'JobError', problem: 'The server stopped while the job was running.', suggestions: ['Start the render again; finished frames come from the cache.'] } }
          : info,
        abort: { aborted: interrupted },
      });
    }
  }

  private async persist(job: MutableJob): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeAtomic(join(this.dir, `${job.info.id}.json`), JSON.stringify(job.info));
  }

  /** Startet einen Job und gibt seine ID zurück. */
  start(kind: string, projectId: string, body: (control: JobControl) => Promise<unknown>, traceparent?: string): string {
    const id = `job-${randomUUID()}`;
    const job: MutableJob = {
      info: { id, kind, projectId, state: 'queued', progress: { stage: 'queued', done: 0, total: 0 }, createdAt: new Date().toISOString(), ...(traceparent !== undefined ? { traceparent } : {}) },
      abort: { aborted: false },
    };
    this.jobs.set(id, job);
    const queuedAt = performance.now();
    const run = (): void => {
      this.running++;
      this.telemetry.metrics.recordQueueWait((performance.now() - queuedAt) / 1000, { kind });
      job.info = { ...job.info, state: 'running', startedAt: new Date().toISOString() };
      void this.persist(job);
      const control: JobControl = {
        signal: job.abort,
        progress: (stage, done, total) => {
          job.info = { ...job.info, progress: { stage, done, total } };
        },
      };
      this.telemetry
        .withRemoteParent(traceparent, () => this.telemetry.withSpan(`job.${kind}`, { job: id, project: projectId }, () => body(control)))
        .then(
          (result) => {
            job.info = { ...job.info, state: job.abort.aborted ? 'cancelled' : 'succeeded', result, finishedAt: new Date().toISOString() };
          },
          (error: unknown) => {
            const diagnostic: Diagnostic =
              error instanceof OpenVideoError
                ? error.diagnostic
                : { code: 'OV_INTERNAL', severity: 'error', errorClass: 'InternalError', problem: error instanceof Error ? error.message : String(error), suggestions: ['Report this bug with the job id.'] };
            const cancelled = job.abort.aborted || diagnostic.code === 'OV_RENDER_CANCELLED';
            if (!cancelled) this.telemetry.metrics.workerFailure(diagnostic.code);
            job.info = { ...job.info, state: cancelled ? 'cancelled' : 'failed', error: diagnostic, finishedAt: new Date().toISOString() };
          },
        )
        .finally(() => {
          this.running--;
          void this.persist(job);
          this.queue.shift()?.();
        });
    };
    if (this.running < this.maxConcurrent) run();
    else this.queue.push(run);
    void this.persist(job);
    return id;
  }

  /** Status eines Jobs. */
  status(id: string): JobInfo {
    const job = this.jobs.get(id);
    if (job === undefined) throw new OpenVideoError({ code: 'OV_JOB_UNKNOWN', errorClass: 'JobError', problem: `Job "${id}" does not exist.`, suggestions: ['Use the id returned by video.render or preview.render.'] });
    return job.info;
  }

  /** Bricht einen Job ab (wirkt beim nächsten Frame). */
  cancel(id: string): JobInfo {
    const job = this.jobs.get(id);
    if (job === undefined) throw new OpenVideoError({ code: 'OV_JOB_UNKNOWN', errorClass: 'JobError', problem: `Job "${id}" does not exist.`, suggestions: [] });
    if (job.info.state === 'queued' || job.info.state === 'running') {
      job.abort.aborted = true;
      if (job.info.state === 'queued') job.info = { ...job.info, state: 'cancelled', finishedAt: new Date().toISOString() };
    }
    return job.info;
  }

  /** Wartet, bis ein Job endet (für CLI und Tests). */
  async wait(id: string, pollMs = 50): Promise<JobInfo> {
    for (;;) {
      const info = this.status(id);
      if (info.state !== 'queued' && info.state !== 'running') return info;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /** Alle Jobs. */
  list(): JobInfo[] {
    return [...this.jobs.values()].map((j) => j.info);
  }
}
