/**
 * Worker-Pool über stdio: dynamische Verteilung (ein freier Worker holt den nächsten Chunk),
 * Neustart abgestürzter Worker, Wiederholung fehlgeschlagener Chunks auf einem anderen Worker.
 *
 * Prozess- und Docker-Runner unterscheiden sich nur darin, wie ein Worker startet
 * und welche `init`-Nachricht er bekommt.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { OpenVideoError, type Diagnostic } from '@agentic-video/core';
import type { Cache } from '@agentic-video/cache';
import type { ChunkRequest, ChunkResult } from '@agentic-video/render';
import type { LogLevel, Telemetry } from '@agentic-video/telemetry';
import { MessageDecoder, encodeMessage, type InitMessage, type ProtocolMessage } from './protocol.js';

/** Ereignisse des Schedulers (für Fortschritt, Tests und Betrieb). */
export type SchedulerEvent =
  | { readonly type: 'worker-started'; readonly worker: string; readonly pid?: number; readonly container?: string }
  | { readonly type: 'worker-exited'; readonly worker: string; readonly code: number | null; readonly signal: string | null }
  | { readonly type: 'chunk-started'; readonly worker: string; readonly pid?: number; readonly container?: string; readonly start: number; readonly end: number; readonly attempt: number }
  | { readonly type: 'chunk-done'; readonly worker: string; readonly start: number; readonly end: number; readonly attempt: number }
  | { readonly type: 'chunk-retry'; readonly worker: string; readonly start: number; readonly end: number; readonly attempt: number; readonly reason: string };

/** Wie ein Worker gestartet wird. */
export interface WorkerLaunch {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Containername (Docker), für Ereignisse und Aufräumen. */
  readonly container?: string;
  /** Räumt nach dem Ende auf (z. B. `docker rm -f`). */
  readonly cleanup?: () => void;
}

/** Optionen für {@link runPool}. */
export interface PoolOptions {
  readonly concurrency: number;
  readonly maxAttempts: number;
  readonly telemetry: Telemetry;
  /** Frame-Cache des Aufrufers; empfangene `frame`-Nachrichten landen hier. */
  readonly cache: Cache;
  readonly launch: (slot: number, generation: number) => WorkerLaunch;
  readonly init: (worker: string) => InitMessage;
  readonly onEvent?: (event: SchedulerEvent) => void;
}

type Outcome = { readonly kind: 'result'; readonly result: ChunkResult } | { readonly kind: 'error'; readonly diagnostic: Diagnostic } | { readonly kind: 'crash'; readonly reason: string };

interface Task {
  readonly chunk: ChunkRequest;
  readonly index: number;
  attempts: number;
  enqueued: number;
  /** Worker, auf dem der letzte Versuch scheiterte. */
  avoid?: string;
}

const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Ein laufender Worker mit Protokoll-Verbindung. */
class WorkerConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly decoder = new MessageDecoder();
  private pending: Promise<void> = Promise.resolve();
  private current: { id: string; resolve: (o: Outcome) => void } | undefined;
  private readonly stderrTail: string[] = [];
  private initError: Diagnostic | undefined;
  private exitInfo: { code: number | null; signal: string | null } | undefined;
  readonly exited: Promise<void>;
  private sequence = 0;

  constructor(
    readonly launch: WorkerLaunch,
    private readonly options: PoolOptions,
  ) {
    this.child = spawn(launch.command, [...launch.args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...(launch.env ?? process.env) } });
    this.exited = new Promise((resolve) => {
      this.child.on('close', (code, signal) => {
        this.exitInfo = { code, signal };
        launch.cleanup?.();
        options.onEvent?.({ type: 'worker-exited', worker: launch.id, code, signal });
        this.finishCurrent({ kind: 'crash', reason: this.exitReason() });
        resolve();
      });
    });
    this.child.on('error', (error) => {
      this.stderrTail.push(error.message);
    });
    this.child.stdin.on('error', (error) => {
      this.stderrTail.push(`stdin: ${error.message}`);
    });
    this.child.stdout.on('data', (chunk: Buffer) => {
      let messages: ProtocolMessage[];
      try {
        messages = this.decoder.push(chunk);
      } catch (error) {
        this.stderrTail.push(error instanceof Error ? error.message : String(error));
        this.child.kill('SIGKILL');
        return;
      }
      for (const m of messages) this.handle(m);
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim() === '') continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 20) this.stderrTail.shift();
      }
    });
    this.send(options.init(launch.id));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get alive(): boolean {
    return this.exitInfo === undefined;
  }

  private send(message: ProtocolMessage): void {
    if (this.child.stdin.writable) this.child.stdin.write(encodeMessage(message));
  }

  /** Beschreibt, warum der Worker endete (Exit-Code, Init-Fehler, letzte Ausgabe). */
  exitReason(): string {
    const info = this.exitInfo;
    const how = info === undefined ? 'unknown' : info.signal !== null ? `signal ${info.signal}` : `code ${String(info.code)}`;
    const init = this.initError !== undefined ? ` Init failed: ${this.initError.problem}` : '';
    const tail = this.stderrTail.length > 0 ? ` Last output: ${this.stderrTail.slice(-5).join(' | ')}` : '';
    return `Worker ${this.launch.id} exited (${how}).${init}${tail}`;
  }

  private finishCurrent(outcome: Outcome): void {
    const current = this.current;
    if (current === undefined) return;
    this.current = undefined;
    // Erst alle empfangenen Frames speichern, dann das Ergebnis melden.
    void this.pending.then(
      () => {
        current.resolve(outcome);
      },
      (error: unknown) => {
        current.resolve({ kind: 'crash', reason: `Storing frames failed: ${error instanceof Error ? error.message : String(error)}` });
      },
    );
  }

  private handle(m: ProtocolMessage): void {
    switch (m.type) {
      case 'frame': {
        const tier = this.options.cache.tier('frame');
        this.pending = this.pending.then(() => tier.put(m.key, m.bytes));
        return;
      }
      case 'result':
        if (this.current?.id === m.id) this.finishCurrent({ kind: 'result', result: { ...m.result, worker: this.launch.id } });
        return;
      case 'error':
        if (m.id === undefined) this.initError = m.diagnostic;
        else if (this.current?.id === m.id) this.finishCurrent({ kind: 'error', diagnostic: m.diagnostic });
        return;
      case 'log':
        this.forwardLog(m.line);
        return;
      default:
        return;
    }
  }

  private forwardLog(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.options.telemetry.logger.info(line, { worker: this.launch.id, parseError: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
    const { level, message, time: _time, service: _service, ...fields } = Object.fromEntries(Object.entries(parsed));
    const lvl = LEVELS.find((l) => l === level) ?? 'info';
    this.options.telemetry.logger.log(lvl, typeof message === 'string' ? message : 'worker log', { ...fields, worker: this.launch.id });
  }

  run(chunk: ChunkRequest, traceparent: string | undefined): Promise<Outcome> {
    if (!this.alive) return Promise.resolve({ kind: 'crash', reason: this.exitReason() });
    const id = `${this.launch.id}/${String(++this.sequence)}`;
    return new Promise((resolve) => {
      this.current = { id, resolve };
      this.send({ type: 'chunk', id, request: chunk, ...(traceparent !== undefined ? { traceparent } : {}) });
    });
  }

  async shutdown(): Promise<void> {
    if (!this.alive) return;
    this.send({ type: 'shutdown' });
    this.child.stdin.end();
    const timer = setTimeout(() => {
      this.child.kill('SIGKILL');
    }, 10_000);
    await this.exited;
    clearTimeout(timer);
  }

  kill(): void {
    if (this.alive) this.child.kill('SIGKILL');
  }
}

function describeChunk(c: ChunkRequest): string {
  return `[${String(c.start)}, ${String(c.end)})`;
}

/**
 * Rendert Chunks auf einem Pool von stdio-Workern.
 *
 * @example
 * ```ts
 * const results = await runPool(chunks, onDone, { concurrency: 3, maxAttempts: 3, telemetry, cache, launch, init });
 * ```
 */
export function runPool(chunks: readonly ChunkRequest[], onDone: (result: ChunkResult) => void, options: PoolOptions): Promise<readonly ChunkResult[]> {
  const { telemetry } = options;
  const results: (ChunkResult | undefined)[] = chunks.map(() => undefined);
  const queue: Task[] = chunks.map((chunk, index) => ({ chunk, index, attempts: 0, enqueued: performance.now() }));
  let remaining = chunks.length;
  // Als Objekt-Eigenschaft, weil Callbacks und andere Slots den Wert zwischen zwei `await` ändern.
  const state = { finished: false };
  const isFinished = (): boolean => state.finished;
  let fatal: OpenVideoError | undefined;
  const live = new Set<WorkerConnection>();
  let waiters: (() => void)[] = [];
  const notify = (): void => {
    const list = waiters;
    waiters = [];
    for (const w of list) w();
  };
  const fail = (error: OpenVideoError): void => {
    if (state.finished) return;
    fatal = error;
    state.finished = true;
    for (const w of live) w.kill();
    notify();
  };

  const take = (worker: string): Task | undefined => {
    const preferred = queue.findIndex((t) => t.avoid !== worker);
    if (preferred >= 0) return queue.splice(preferred, 1)[0];
    // Nur noch Chunks, die auf diesem Worker scheiterten: nehmen, wenn kein anderer Worker lebt.
    const others = [...live].filter((w) => w.launch.id !== worker && w.alive).length;
    return others === 0 ? queue.shift() : undefined;
  };

  const retry = (task: Task, worker: string, reason: string): void => {
    options.onEvent?.({ type: 'chunk-retry', worker, start: task.chunk.start, end: task.chunk.end, attempt: task.attempts, reason });
    if (task.attempts >= options.maxAttempts) {
      fail(
        new OpenVideoError({
          code: 'OV_SCHEDULER_CHUNK_FAILED',
          errorClass: 'SchedulerError',
          problem: `Chunk ${describeChunk(task.chunk)} failed ${String(task.attempts)} times. Last reason: ${reason}`,
          details: { start: task.chunk.start, end: task.chunk.end, attempts: task.attempts },
          suggestions: ['Render one frame of this range with `openvideo render --frame` to see the error.', 'Raise maxAttempts if the workers are unstable.'],
        }),
      );
      return;
    }
    task.avoid = worker;
    task.enqueued = performance.now();
    queue.push(task);
    notify();
  };

  const serve = async (worker: WorkerConnection): Promise<boolean> => {
    let served = false;
    while (!state.finished && worker.alive) {
      const task = take(worker.launch.id);
      if (task === undefined) {
        if (remaining === 0) return served;
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          void worker.exited.then(resolve);
        });
        continue;
      }
      task.attempts++;
      telemetry.metrics.recordQueueWait((performance.now() - task.enqueued) / 1000, { worker: worker.launch.id });
      options.onEvent?.({ type: 'chunk-started', worker: worker.launch.id, ...(worker.pid !== undefined ? { pid: worker.pid } : {}), ...(worker.launch.container !== undefined ? { container: worker.launch.container } : {}), start: task.chunk.start, end: task.chunk.end, attempt: task.attempts });
      const outcome = await telemetry.withSpan('scheduler.chunk', { start: task.chunk.start, end: task.chunk.end, worker: worker.launch.id, attempt: task.attempts }, () => worker.run(task.chunk, telemetry.traceparent()));
      served = true;
      if (isFinished()) return served;
      if (outcome.kind === 'result') {
        if (results[task.index] === undefined) {
          results[task.index] = outcome.result;
          remaining--;
          options.onEvent?.({ type: 'chunk-done', worker: worker.launch.id, start: task.chunk.start, end: task.chunk.end, attempt: task.attempts });
          onDone(outcome.result);
        }
        if (remaining === 0) {
          state.finished = true;
          notify();
        }
      } else {
        telemetry.metrics.workerFailure(outcome.kind === 'crash' ? 'crash' : 'chunk-error');
        const reason = outcome.kind === 'crash' ? outcome.reason : `${outcome.diagnostic.code}: ${outcome.diagnostic.problem}`;
        telemetry.logger.warn('chunk failed', { worker: worker.launch.id, start: task.chunk.start, end: task.chunk.end, attempt: task.attempts, reason });
        retry(task, worker.launch.id, reason);
      }
    }
    return served;
  };

  const slot = async (index: number): Promise<void> => {
    let generation = 0;
    let startFailures = 0;
    while (!state.finished) {
      const launch = options.launch(index, generation++);
      const worker = new WorkerConnection(launch, options);
      live.add(worker);
      options.onEvent?.({ type: 'worker-started', worker: launch.id, ...(worker.pid !== undefined ? { pid: worker.pid } : {}), ...(launch.container !== undefined ? { container: launch.container } : {}) });
      const served = await serve(worker);
      if (worker.alive) {
        await worker.shutdown();
        live.delete(worker);
        return;
      }
      live.delete(worker);
      if (isFinished()) return;
      startFailures = served ? 0 : startFailures + 1;
      const lastReason = worker.exitReason();
      if (!served) telemetry.metrics.workerFailure('start');
      if (startFailures >= options.maxAttempts) {
        telemetry.logger.error('worker slot gave up', { slot: index, reason: lastReason });
        if ([...live].every((w) => !w.alive)) {
          fail(
            new OpenVideoError({
              code: 'OV_SCHEDULER_WORKERS_FAILED',
              errorClass: 'SchedulerError',
              problem: `No worker could start. ${lastReason}`,
              suggestions: ['Run the worker by hand (`openvideo-worker --stdio`) to see its error.', 'Check that the worker packages are built (`npx tsc -b packages/worker`).'],
            }),
          );
        }
        return;
      }
    }
  };

  if (chunks.length === 0) return Promise.resolve([]);
  const slots = Array.from({ length: Math.max(1, Math.min(options.concurrency, chunks.length)) }, (_, i) => slot(i));
  return Promise.all(slots).then(() => {
    if (fatal !== undefined) throw fatal;
    const done = results.filter((r): r is ChunkResult => r !== undefined);
    if (done.length !== chunks.length) {
      throw new OpenVideoError({
        code: 'OV_SCHEDULER_INCOMPLETE',
        errorClass: 'SchedulerError',
        problem: `Only ${String(done.length)} of ${String(chunks.length)} chunks finished; all workers stopped.`,
        suggestions: ['Check the worker logs for crashes.', 'Lower the concurrency or raise the worker memory limit.'],
      });
    }
    return done;
  });
}
