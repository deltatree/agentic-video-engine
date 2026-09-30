/**
 * Worker über stdio (Prozess- und Docker-Worker).
 *
 * Ablauf: `init` → Render-Umgebung bauen → `chunk`-Aufträge nacheinander rendern → `result`.
 * Während ein Chunk rendert, liest der Worker weiter: `cancel` bricht ihn nach dem laufenden Frame
 * ab (Story 18.8, Antwort `error` mit `OV_RENDER_CANCELLED`), `shutdown` wartet auf das Ende.
 * Stream-Modus: Projektdateien kommen mit `init`, jeder neue Frame geht als `frame` zurück,
 * der Worker selbst hält nur einen Speicher-Cache.
 * Shared-Modus: Projektordner und Datei-Cache liegen im gemeinsamen Dateisystem.
 */
import { format } from 'node:util';
import type { Readable, Writable } from 'node:stream';
import { MemoryStore, createCache, storeFromEnv, type ContentStore, type StoreEntry } from '@agentic-video/cache';
import { OpenVideoError } from '@agentic-video/core';
import { createNodeEnvironment, renderChunk, type NodeEnvironment } from '@agentic-video/render';
import { MessageDecoder, encodeMessage, type ChunkMessage, type InitMessage, type ProtocolMessage } from '@agentic-video/scheduler';
import type { Telemetry } from '@agentic-video/telemetry';
import { toDiagnostic, workerTelemetry, writeTempProject, type TempProject } from './workspace.js';

/** Optionen für {@link runWorkerStdio}. */
export interface StdioWorkerOptions {
  /** Eingang (Standard `process.stdin`). */
  readonly input?: Readable;
  /** Ausgang für Protokoll-Rahmen (Standard `process.stdout`). */
  readonly output?: Writable;
}

/**
 * Speicher des Stream-Modus: Frames werden nicht behalten, sondern an den Koordinator geschickt.
 * Alle anderen Ebenen (Layer, Assets, Schriften) bleiben im Arbeitsspeicher.
 */
class ForwardingStore implements ContentStore {
  readonly name = 'memory+forward';
  private readonly inner = new MemoryStore();

  constructor(private readonly onFrame: (key: string, bytes: Uint8Array) => void) {}

  has(key: string): Promise<boolean> {
    return this.inner.has(key);
  }

  get(key: string): Promise<Uint8Array | undefined> {
    return this.inner.get(key);
  }

  put(key: string, bytes: Uint8Array): Promise<void> {
    if (key.startsWith('frame/')) {
      this.onFrame(key.slice('frame/'.length), bytes);
      return Promise.resolve();
    }
    return this.inner.put(key, bytes);
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }

  list(prefix?: string): Promise<StoreEntry[]> {
    return this.inner.list(prefix);
  }
}

interface Session {
  readonly env: NodeEnvironment;
  readonly project: Readonly<Record<string, unknown>>;
  readonly worker: string;
  readonly temp?: TempProject;
}

async function openSession(init: InitMessage, telemetry: Telemetry, send: (m: ProtocolMessage) => void): Promise<Session> {
  const common = {
    project: init.project,
    telemetry,
    ...(init.options.trusted !== undefined ? { trusted: init.options.trusted } : {}),
    ...(init.options.offline !== undefined ? { offline: init.options.offline } : {}),
  };
  if (init.mode === 'shared') {
    const cache = createCache(storeFromEnv({ ...process.env, OPENVIDEO_CACHE_DIR: init.cacheDir }, init.projectDir));
    const env = await createNodeEnvironment({ ...common, projectDir: init.projectDir, cache });
    return { env, project: init.project, worker: init.worker };
  }
  const temp = await writeTempProject(init.files);
  try {
    const cache = createCache(
      new ForwardingStore((key, bytes) => {
        send({ type: 'frame', key, bytes });
      }),
    );
    const env = await createNodeEnvironment({ ...common, projectDir: temp.dir, cache });
    return { env, project: init.project, worker: init.worker, temp };
  } catch (error) {
    await temp.remove();
    throw error;
  }
}

async function closeSession(session: Session | undefined): Promise<void> {
  if (session === undefined) return;
  await session.env.dispose();
  await session.temp?.remove();
}

async function renderOne(session: Session, telemetry: Telemetry, m: ChunkMessage, signal: { readonly aborted: boolean }): Promise<ProtocolMessage> {
  try {
    const result = await telemetry.withRemoteParent(m.traceparent, () =>
      telemetry.withSpan('worker.chunk', { worker: session.worker, start: m.request.start, end: m.request.end }, async () => {
        const started = performance.now();
        const r = await renderChunk(session.env, session.project, m.request, signal);
        telemetry.logger.info('chunk rendered', { worker: session.worker, start: r.start, end: r.end, rendered: r.rendered, fromCache: r.fromCache, seconds: (performance.now() - started) / 1000 });
        return r;
      }),
    );
    return { type: 'result', id: m.id, result: { ...result, worker: session.worker } };
  } catch (error) {
    const diagnostic = toDiagnostic(error);
    telemetry.logger.error('chunk failed', { worker: session.worker, start: m.request.start, end: m.request.end, code: diagnostic.code, problem: diagnostic.problem });
    return { type: 'error', id: m.id, diagnostic };
  }
}

/**
 * Zerlegt Eingabe in Nachrichten. Jeder Fehler des Decoders ist ein Protokollfehler: Auch ungültiges
 * JSON im Rahmen-Kopf (roher `SyntaxError` aus `JSON.parse`) wird zu `OV_WORKER_PROTOCOL`.
 */
function decodeFrames(decoder: MessageDecoder, chunk: Uint8Array): ProtocolMessage[] {
  try {
    return decoder.push(chunk);
  } catch (error) {
    if (error instanceof OpenVideoError) throw error;
    throw new OpenVideoError({
      code: 'OV_WORKER_PROTOCOL',
      errorClass: 'WorkerError',
      problem: `The worker received a frame it cannot decode: ${error instanceof Error ? error.message : String(error)}.`,
      suggestions: ['Use the same OpenVideo version for coordinator and worker.', 'Make sure nothing else writes to the worker stdin.'],
      cause: error,
    });
  }
}

/**
 * Führt den Worker über stdio aus, bis `shutdown` kommt oder die Eingabe endet.
 * Scheitert `init`, meldet der Worker den Fehler als `error`-Nachricht und wirft ihn danach.
 *
 * Schreibt `console.log` und Verwandte auf stderr um, damit nur Protokoll-Rahmen auf stdout landen.
 *
 * @example
 * ```ts
 * await runWorkerStdio();
 * ```
 */
export async function runWorkerStdio(options: StdioWorkerOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (output === process.stdout) {
    // Bibliotheken dürfen stdout nicht mit Text verunreinigen: dort laufen nur Rahmen.
    const toStderr = (...args: unknown[]): void => {
      process.stderr.write(`${format(...args)}\n`);
    };
    console.log = toStderr;
    console.info = toStderr;
    console.debug = toStderr;
  }
  const send = (m: ProtocolMessage): void => {
    output.write(encodeMessage(m));
  };
  const telemetry = workerTelemetry((line) => {
    send({ type: 'log', line });
  });
  const decoder = new MessageDecoder();
  let session: Session | undefined;
  let initError: unknown;
  // Chunks laufen nacheinander in einer Warteschlange; die Leseschleife bleibt frei für `cancel`.
  let queue: Promise<void> = Promise.resolve();
  const flags = new Map<string, { aborted: boolean }>();
  try {
    read: for await (const chunk of input) {
      if (!(chunk instanceof Uint8Array)) continue;
      let messages: ProtocolMessage[];
      try {
        messages = decodeFrames(decoder, chunk);
      } catch (error) {
        // Kaputter Datenstrom: dem Koordinator den Grund sagen, dann beenden (keine Resynchronisation möglich).
        send({ type: 'error', diagnostic: toDiagnostic(error) });
        throw error;
      }
      for (const m of messages) {
        if (m.type === 'shutdown') {
          await queue;
          return;
        }
        if (m.type === 'cancel') {
          const flag = flags.get(m.id);
          if (flag !== undefined) flag.aborted = true;
          continue;
        }
        if (m.type === 'init') {
          if (session !== undefined) {
            send({ type: 'error', diagnostic: toDiagnostic(new OpenVideoError({ code: 'OV_WORKER_PROTOCOL', errorClass: 'WorkerError', problem: 'The worker received a second init message.', suggestions: ['Start a new worker per project.'] })) });
            continue;
          }
          try {
            session = await openSession(m, telemetry, send);
            telemetry.logger.info('worker ready', { worker: m.worker, mode: m.mode });
          } catch (error) {
            initError = error;
            send({ type: 'error', diagnostic: toDiagnostic(error) });
            break read;
          }
          continue;
        }
        if (m.type === 'chunk') {
          if (session === undefined) {
            send({ type: 'error', id: m.id, diagnostic: toDiagnostic(new OpenVideoError({ code: 'OV_WORKER_PROTOCOL', errorClass: 'WorkerError', problem: 'The worker received a chunk before init.', suggestions: ['Send init first.'] })) });
            continue;
          }
          const current = session;
          const flag = { aborted: false };
          flags.set(m.id, flag);
          const run = async (): Promise<void> => {
            try {
              send(await renderOne(current, telemetry, m, flag));
            } finally {
              flags.delete(m.id);
            }
          };
          queue = queue.then(run, run);
        }
      }
    }
  } finally {
    // Laufende Chunks zu Ende bringen (oder abbrechen lassen), bevor die Umgebung schließt.
    await queue.catch(() => undefined);
    await closeSession(session);
    await telemetry.shutdown();
    await new Promise<void>((resolve) => {
      output.write(new Uint8Array(), () => {
        resolve();
      });
    });
  }
  // Nach dem Aufräumen: der Aufrufer (bin) beendet sich mit Fehlercode.
  if (initError !== undefined) throw initError instanceof Error ? initError : new OpenVideoError(toDiagnostic(initError));
}
