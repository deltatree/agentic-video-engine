/**
 * Worker-Protokoll über stdio (Prozess- und Docker-Worker).
 *
 * Jede Nachricht ist ein Rahmen: `[u32 Länge, Big Endian][JSON]`, optional gefolgt von
 * Binärdaten. Die Länge der Binärdaten steht im JSON-Feld `binaryLength`.
 *
 * Das Paket `worker` exportiert dieselben Funktionen aus `worker/src/protocol.ts`.
 * Die Quelle liegt hier, weil `worker` von `scheduler` abhängt und nicht umgekehrt (AD-14).
 */
import { OpenVideoError, isRecord, type Diagnostic } from '@agentic-video/core';
import type { ChunkRequest, ChunkResult } from '@agentic-video/render';

/** Eine Projektdatei für den Stream-Modus (Pfad relativ zum Projektordner). */
export interface ProjectFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** Optionen, die der Koordinator dem Worker mitgibt. */
export interface WorkerRunOptions {
  /** Host-Ausführung nicht vertrauenswürdigen Codes erlaubt (ADR 0008). */
  readonly trusted?: boolean;
  /** Keine Netzzugriffe für Assets (Container-Worker). */
  readonly offline?: boolean;
}

/** Gemeinsame Felder beider Init-Varianten. */
interface InitBase {
  readonly type: 'init';
  /** Name des Workers für `ChunkResult.worker` und Logs. */
  readonly worker: string;
  readonly project: Readonly<Record<string, unknown>>;
  readonly options: WorkerRunOptions;
}

/** Shared-Modus: Worker liest das Projekt aus einem vorhandenen Ordner und teilt den Cache. */
export interface SharedInitMessage extends InitBase {
  readonly mode: 'shared';
  readonly projectDir: string;
  readonly cacheDir: string;
}

/** Stream-Modus: Projektdateien kommen im Rahmen mit; Frames gehen als `frame` zurück. */
export interface StreamInitMessage extends InitBase {
  readonly mode: 'stream';
  readonly files: readonly ProjectFile[];
}

export type InitMessage = SharedInitMessage | StreamInitMessage;

/** Auftrag für einen Chunk. */
export interface ChunkMessage {
  readonly type: 'chunk';
  readonly id: string;
  readonly request: ChunkRequest;
  readonly traceparent?: string;
}

/** Ein neu gerenderter Frame (Stream-Modus): Frame-Schlüssel und OVRF-Bytes. */
export interface FrameMessage {
  readonly type: 'frame';
  readonly key: string;
  readonly bytes: Uint8Array;
}

/** Ergebnis eines Chunks. */
export interface ResultMessage {
  readonly type: 'result';
  readonly id: string;
  readonly result: ChunkResult;
}

/** Fehler; ohne `id` betrifft er den ganzen Worker (z. B. `init`). */
export interface ErrorMessage {
  readonly type: 'error';
  readonly id?: string;
  readonly diagnostic: Diagnostic;
}

/** Eine strukturierte Log-Zeile des Workers (JSON-Text aus `telemetry`). */
export interface LogMessage {
  readonly type: 'log';
  readonly line: string;
}

/** Bittet den Worker, sich zu beenden. */
export interface ShutdownMessage {
  readonly type: 'shutdown';
}

export type ProtocolMessage = InitMessage | ChunkMessage | FrameMessage | ResultMessage | ErrorMessage | LogMessage | ShutdownMessage;

/** Größte erlaubte JSON-Länge eines Rahmens (64 MiB). */
export const MAX_HEADER_BYTES = 64 * 1024 * 1024;

function protocolError(problem: string): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_WORKER_PROTOCOL',
    errorClass: 'WorkerError',
    problem,
    suggestions: ['Use the same OpenVideo version for coordinator and worker.', 'Make sure nothing else writes to the worker stdout.'],
  });
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function frameBytes(header: Readonly<Record<string, unknown>>, binary?: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(binary === undefined ? header : { ...header, binaryLength: binary.length }));
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, json.length, false);
  return concat(binary === undefined ? [prefix, json] : [prefix, json, binary]);
}

/**
 * Kodiert eine Nachricht als Rahmen.
 *
 * @example
 * ```ts
 * child.stdin.write(encodeMessage({ type: 'shutdown' }));
 * ```
 */
export function encodeMessage(message: ProtocolMessage): Uint8Array {
  if (message.type === 'frame') return frameBytes({ type: 'frame', key: message.key }, message.bytes);
  if (message.type === 'init' && message.mode === 'stream') {
    const { files, ...rest } = message;
    return frameBytes({ ...rest, files: files.map((f) => ({ path: f.path, size: f.bytes.length })) }, concat(files.map((f) => f.bytes)));
  }
  return frameBytes({ ...message });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** Prüft, ob ein Wert eine {@link Diagnostic} ist. */
export function isDiagnostic(value: unknown): value is Diagnostic {
  return (
    isRecord(value) &&
    typeof value['code'] === 'string' &&
    (value['severity'] === 'error' || value['severity'] === 'warning' || value['severity'] === 'info') &&
    typeof value['errorClass'] === 'string' &&
    typeof value['problem'] === 'string' &&
    isStringArray(value['suggestions'])
  );
}

/** Prüft, ob ein Wert ein {@link ChunkRequest} ist. */
export function isChunkRequest(value: unknown): value is ChunkRequest {
  return (
    isRecord(value) &&
    typeof value['compositionId'] === 'string' &&
    typeof value['start'] === 'number' &&
    typeof value['end'] === 'number' &&
    typeof value['scale'] === 'number' &&
    typeof value['step'] === 'number' &&
    typeof value['offset'] === 'number'
  );
}

/** Prüft, ob ein Wert ein {@link ChunkResult} ist. */
export function isChunkResult(value: unknown): value is ChunkResult {
  return (
    isRecord(value) &&
    typeof value['start'] === 'number' &&
    typeof value['end'] === 'number' &&
    isStringArray(value['frameHashes']) &&
    isStringArray(value['keys']) &&
    typeof value['rendered'] === 'number' &&
    typeof value['fromCache'] === 'number' &&
    (value['worker'] === undefined || typeof value['worker'] === 'string') &&
    Array.isArray(value['diagnostics']) &&
    value['diagnostics'].every(isDiagnostic)
  );
}

function runOptions(value: unknown): WorkerRunOptions {
  if (!isRecord(value)) throw protocolError('init.options must be an object.');
  return {
    ...(typeof value['trusted'] === 'boolean' ? { trusted: value['trusted'] } : {}),
    ...(typeof value['offline'] === 'boolean' ? { offline: value['offline'] } : {}),
  };
}

function parseInit(h: Readonly<Record<string, unknown>>, binary: Uint8Array): InitMessage {
  const worker = h['worker'];
  const project = h['project'];
  if (typeof worker !== 'string' || !isRecord(project)) throw protocolError('init needs "worker" and "project".');
  const base = { type: 'init' as const, worker, project, options: runOptions(h['options']) };
  if (h['mode'] === 'shared') {
    const projectDir = h['projectDir'];
    const cacheDir = h['cacheDir'];
    if (typeof projectDir !== 'string' || typeof cacheDir !== 'string') throw protocolError('init (shared) needs "projectDir" and "cacheDir".');
    return { ...base, mode: 'shared', projectDir, cacheDir };
  }
  if (h['mode'] !== 'stream') throw protocolError(`Unknown init mode ${JSON.stringify(h['mode'])}.`);
  const list = h['files'];
  if (!Array.isArray(list)) throw protocolError('init (stream) needs "files".');
  const files: ProjectFile[] = [];
  let offset = 0;
  for (const f of list) {
    if (!isRecord(f) || typeof f['path'] !== 'string' || typeof f['size'] !== 'number') throw protocolError('init.files entries need "path" and "size".');
    const end = offset + f['size'];
    if (end > binary.length) throw protocolError('init.files sizes exceed the binary payload.');
    files.push({ path: f['path'], bytes: binary.subarray(offset, end) });
    offset = end;
  }
  return { ...base, mode: 'stream', files };
}

/**
 * Prüft einen dekodierten Rahmen und macht daraus eine typisierte Nachricht.
 *
 * @example
 * ```ts
 * const message = parseMessage({ type: 'shutdown' }, new Uint8Array());
 * ```
 */
export function parseMessage(header: unknown, binary: Uint8Array): ProtocolMessage {
  if (!isRecord(header)) throw protocolError('A frame header must be a JSON object.');
  const h = header;
  switch (h['type']) {
    case 'init':
      return parseInit(h, binary);
    case 'chunk': {
      const id = h['id'];
      const request = h['request'];
      const tp = h['traceparent'];
      if (typeof id !== 'string' || !isChunkRequest(request)) throw protocolError('chunk needs "id" and a valid "request".');
      return { type: 'chunk', id, request, ...(typeof tp === 'string' ? { traceparent: tp } : {}) };
    }
    case 'frame': {
      const key = h['key'];
      if (typeof key !== 'string') throw protocolError('frame needs "key".');
      return { type: 'frame', key, bytes: binary };
    }
    case 'result': {
      const id = h['id'];
      const result = h['result'];
      if (typeof id !== 'string' || !isChunkResult(result)) throw protocolError('result needs "id" and a valid "result".');
      return { type: 'result', id, result };
    }
    case 'error': {
      const id = h['id'];
      const diagnostic = h['diagnostic'];
      if (!isDiagnostic(diagnostic)) throw protocolError('error needs a valid "diagnostic".');
      return { type: 'error', ...(typeof id === 'string' ? { id } : {}), diagnostic };
    }
    case 'log': {
      const line = h['line'];
      if (typeof line !== 'string') throw protocolError('log needs "line".');
      return { type: 'log', line };
    }
    case 'shutdown':
      return { type: 'shutdown' };
    default:
      throw protocolError(`Unknown message type ${JSON.stringify(h['type'])}.`);
  }
}

/**
 * Liest Rahmen aus einem Bytestrom. Teilstücke werden gepuffert, bis ein Rahmen vollständig ist.
 *
 * @example
 * ```ts
 * const decoder = new MessageDecoder();
 * child.stdout.on('data', (chunk: Buffer) => { for (const m of decoder.push(chunk)) handle(m); });
 * ```
 */
export class MessageDecoder {
  private parts: Uint8Array[] = [];
  private length = 0;
  private header: { value: Record<string, unknown>; binaryLength: number } | undefined;

  /** Fügt Bytes hinzu und gibt alle jetzt vollständigen Nachrichten zurück. */
  push(chunk: Uint8Array): ProtocolMessage[] {
    this.parts.push(chunk);
    this.length += chunk.length;
    const out: ProtocolMessage[] = [];
    for (;;) {
      if (this.header === undefined) {
        if (this.length < 4) break;
        const size = new DataView(this.take(4).buffer).getUint32(0, false);
        if (size > MAX_HEADER_BYTES) throw protocolError(`Frame header of ${String(size)} bytes exceeds the limit.`);
        if (this.length < size) {
          this.unshift(size);
          break;
        }
        const parsed: unknown = JSON.parse(new TextDecoder().decode(this.take(size)));
        if (!isRecord(parsed)) throw protocolError('A frame header must be a JSON object.');
        const binaryLength = parsed['binaryLength'];
        this.header = { value: parsed, binaryLength: typeof binaryLength === 'number' && binaryLength >= 0 ? binaryLength : 0 };
      }
      if (this.length < this.header.binaryLength) break;
      const binary = this.take(this.header.binaryLength);
      const { value } = this.header;
      this.header = undefined;
      out.push(parseMessage(value, binary));
    }
    return out;
  }

  /** Legt das bereits gelesene Längenpräfix zurück, bis der Rahmen vollständig ist. */
  private unshift(size: number): void {
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, size, false);
    this.parts.unshift(prefix);
    this.length += 4;
  }

  private take(n: number): Uint8Array {
    const all = this.parts.length === 1 ? (this.parts[0] ?? new Uint8Array()) : concat(this.parts);
    // Kopie statt Sicht: Node-Buffer teilen sich sonst einen großen Speicherpool.
    const head = new Uint8Array(all.subarray(0, n));
    const rest = all.subarray(n);
    this.parts = rest.length > 0 ? [rest] : [];
    this.length = rest.length;
    return head;
  }
}
