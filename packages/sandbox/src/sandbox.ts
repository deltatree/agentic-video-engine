/**
 * Ausführung nicht vertrauenswürdigen Codes (ADR 0008, FR-70..FR-72, NFR-5).
 *
 * Standard ist ein Docker-Container ohne Netz, mit schreibgeschütztem Dateisystem,
 * ohne Capabilities, mit Limits und ohne Host-Mounts. Code und Eingabe gehen über
 * stdin hinein, das Ergebnis kommt als JSON über stdout heraus.
 *
 * `trusted-host` ist eine ausdrückliche Ausnahme für eigene Projekte: ein Node-Kindprozess
 * mit Permission-Modell; das Ergebnis trägt `trusted: true`.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenVideoError, isRecord } from '@agentic-video/core';
import { BOOTSTRAP_SOURCE, RESULT_MARK } from './bootstrap.js';

/** Docker-Image der Sandbox: `node:22-alpine`, per Digest gepinnt. */
export const SANDBOX_IMAGE = 'node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402';

/** Grenzen einer Ausführung. */
export interface SandboxLimits {
  /** Harte Zeitgrenze in Millisekunden (inklusive Container-Start). */
  readonly timeoutMs: number;
  readonly memoryMb: number;
  readonly cpus: number;
  /** Höchstzahl an Prozessen und Threads im Container. */
  readonly pids: number;
}

/** Standardgrenzen. */
export const DEFAULT_LIMITS: SandboxLimits = { timeoutMs: 30_000, memoryMb: 512, cpus: 1, pids: 64 };

/** Ausführungsmodus. */
export type SandboxMode = 'docker' | 'trusted-host';

/** Anfrage an {@link runSandboxed}. */
export interface SandboxRequest {
  /** JavaScript-Skript. Sein Abschlusswert (bei einem Promise: das Ergebnis) ist die Ausgabe. */
  readonly code: string;
  /** JSON-Eingabe; im Skript als globale Variable `input` verfügbar. */
  readonly input?: unknown;
  readonly limits?: Partial<SandboxLimits>;
  /** Standard: `docker`. */
  readonly mode?: SandboxMode;
  /** Dateiname des Skripts in Stacktraces (Standard `sandbox.js`). */
  readonly filename?: string;
  /** Größte erlaubte Ausgabe in Bytes (Standard 64 MiB). */
  readonly maxOutputBytes?: number;
}

/** Ergebnis von {@link runSandboxed}. */
export interface SandboxResult {
  readonly output: unknown;
  /** Fehlerausgabe des Prozesses (gekürzt auf 64 KiB). */
  readonly stderr: string;
  readonly durationMs: number;
  /** `true`, wenn der Code ohne Container auf dem Host lief. */
  readonly trusted: boolean;
}

const STDERR_LIMIT = 64 * 1024;
const DEFAULT_OUTPUT_LIMIT = 64 * 1024 * 1024;

function sandboxError(code: string, problem: string, suggestions: readonly string[], details?: Readonly<Record<string, string | number | boolean>>): OpenVideoError {
  return new OpenVideoError({ code, errorClass: 'SandboxError', problem, suggestions, ...(details !== undefined ? { details } : {}) });
}

function unavailable(reason: string): OpenVideoError {
  return sandboxError('OV_SANDBOX_UNAVAILABLE', `Docker is not available: ${reason}`, [
    'Install Docker and make sure `docker version` works for this user.',
    'Use a JSON composition instead of TSX; it needs no code execution.',
    'For your own trusted project only: run with --trusted (host execution, marked in the manifest).',
  ]);
}

interface ProcessOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly outputTooLarge: boolean;
  readonly spawnError?: NodeJS.ErrnoException;
}

interface RunOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /** Harter Abbruch (z. B. `docker kill`). */
  readonly kill: (child: ChildProcess) => void;
}

function isErrno(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}

function runProcess(options: RunOptions): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const child = spawn(options.command, [...options.args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let outSize = 0;
    let err = '';
    let timedOut = false;
    let outputTooLarge = false;
    let spawnError: NodeJS.ErrnoException | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      options.kill(child);
    }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      outSize += chunk.length;
      if (outSize > options.maxOutputBytes) {
        if (!outputTooLarge) {
          outputTooLarge = true;
          options.kill(child);
        }
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (err.length < STDERR_LIMIT) err += chunk.toString('utf8').slice(0, STDERR_LIMIT - err.length);
    });
    child.stdin.on('error', (error) => {
      // Der Prozess kann enden, bevor er stdin gelesen hat (z. B. Docker fehlt); das Ergebnis meldet den Grund.
      err += `[stdin: ${error.message}]`;
    });
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: err,
        exitCode,
        signal,
        timedOut,
        outputTooLarge,
        ...(spawnError !== undefined ? { spawnError } : {}),
      });
    });
    child.stdin.end(options.stdin);
  });
}

function limitsOf(request: SandboxRequest): SandboxLimits {
  const l = { ...DEFAULT_LIMITS, ...(request.limits ?? {}) };
  const positive = (name: string, v: number): void => {
    if (!(Number.isFinite(v) && v > 0)) throw sandboxError('OV_SANDBOX_LIMITS', `Limit ${name} must be a positive number, got ${String(v)}.`, [`limits: { ${name}: ${String(DEFAULT_LIMITS.timeoutMs)} }`]);
  };
  positive('timeoutMs', l.timeoutMs);
  positive('memoryMb', l.memoryMb);
  positive('cpus', l.cpus);
  positive('pids', l.pids);
  return l;
}

/** Heap-Grenze für Node: drei Viertel des Speicherlimits, damit Node vor dem Kernel abbricht. */
function heapMb(memoryMb: number): number {
  return Math.max(16, Math.floor(memoryMb * 0.75));
}

let imageReady = false;

async function ensureImage(): Promise<void> {
  if (imageReady) return;
  const kill = (c: ChildProcess): void => {
    c.kill('SIGKILL');
  };
  const inspect = await runProcess({ command: 'docker', args: ['image', 'inspect', '--format', '{{.Id}}', SANDBOX_IMAGE], stdin: '', timeoutMs: 15_000, maxOutputBytes: 1 << 20, kill });
  if (inspect.spawnError !== undefined) throw unavailable(inspect.spawnError.code === 'ENOENT' ? 'the docker command was not found.' : inspect.spawnError.message);
  if (inspect.exitCode !== 0) {
    const pull = await runProcess({ command: 'docker', args: ['pull', SANDBOX_IMAGE], stdin: '', timeoutMs: 300_000, maxOutputBytes: 1 << 20, kill });
    if (pull.exitCode !== 0) throw unavailable(`cannot pull ${SANDBOX_IMAGE}: ${(pull.stderr || inspect.stderr).trim().slice(0, 500)}`);
  }
  imageReady = true;
}

/**
 * Prüft, ob Docker für die Sandbox bereitsteht (für `doctor`).
 *
 * @example
 * ```ts
 * const s = await sandboxAvailable();
 * if (!s.available) console.error(s.reason);
 * ```
 */
export async function sandboxAvailable(): Promise<{ readonly available: boolean; readonly version?: string; readonly image: string; readonly reason?: string }> {
  const r = await runProcess({
    command: 'docker',
    args: ['version', '--format', '{{.Server.Version}}'],
    stdin: '',
    timeoutMs: 10_000,
    maxOutputBytes: 1 << 16,
    kill: (c) => {
      c.kill('SIGKILL');
    },
  });
  if (r.spawnError !== undefined) return { available: false, image: SANDBOX_IMAGE, reason: r.spawnError.code === 'ENOENT' ? 'docker command not found' : r.spawnError.message };
  if (r.timedOut) return { available: false, image: SANDBOX_IMAGE, reason: 'docker version timed out' };
  if (r.exitCode !== 0) return { available: false, image: SANDBOX_IMAGE, reason: r.stderr.trim().slice(0, 500) || `docker version exited with ${String(r.exitCode)}` };
  return { available: true, version: r.stdout.trim(), image: SANDBOX_IMAGE };
}

/**
 * Baut die Argumente für `docker run` (ohne Mounts, ohne Netz, schreibgeschützt).
 *
 * @example
 * ```ts
 * dockerRunArgs('ov-sandbox-1a2b', DEFAULT_LIMITS);
 * ```
 */
export function dockerRunArgs(name: string, limits: SandboxLimits): string[] {
  const memory = `${String(Math.ceil(limits.memoryMb))}m`;
  return [
    'run', '--rm', '-i',
    '--name', name,
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(Math.floor(limits.pids)),
    '--memory', memory,
    '--memory-swap', memory,
    '--cpus', String(limits.cpus),
    '--user', '65534:65534',
    '--ulimit', 'nofile=64',
    '--workdir', '/tmp',
    SANDBOX_IMAGE,
    'node', `--max-old-space-size=${String(heapMb(limits.memoryMb))}`, '-e', BOOTSTRAP_SOURCE,
  ];
}

function parseEnvelope(stdout: string): Record<string, unknown> | undefined {
  const at = stdout.lastIndexOf(RESULT_MARK);
  if (at < 0) return undefined;
  const line = stdout.slice(at + RESULT_MARK.length).split('\n')[0] ?? '';
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function tail(text: string): string {
  return text.length > 2000 ? text.slice(-2000) : text;
}

function interpret(outcome: ProcessOutcome, limits: SandboxLimits, mode: SandboxMode, maxOutputBytes: number): unknown {
  const common = { mode, exitCode: outcome.exitCode ?? -1, stderr: tail(outcome.stderr) };
  if (outcome.outputTooLarge) {
    throw sandboxError('OV_SANDBOX_CRASH', `The sandbox output exceeds ${String(maxOutputBytes)} bytes.`, ['Return a smaller result.', 'Reduce frame-sampled properties; use animate() or keyframes() instead.'], common);
  }
  if (outcome.timedOut) {
    throw sandboxError('OV_SANDBOX_TIMEOUT', `The code did not finish within ${String(limits.timeoutMs)} ms and was killed.`, ['Look for an endless loop in the code.', `Raise limits.timeoutMs above ${String(limits.timeoutMs)} for long compositions.`], common);
  }
  const envelope = parseEnvelope(outcome.stdout);
  if (envelope?.['ok'] === true) return envelope['output'];
  const error = envelope?.['error'];
  if (isRecord(error)) {
    if (error['code'] === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      throw sandboxError('OV_SANDBOX_TIMEOUT', `The code did not finish within ${String(limits.timeoutMs)} ms.`, ['Look for an endless loop in the code.'], common);
    }
    const message = String(error['message']);
    const details: Record<string, string | number | boolean> = { ...common, errorName: String(error['name']), errorMessage: message, stack: String(error['stack']) };
    if (isRecord(error['diagnostic'])) details['diagnostic'] = JSON.stringify(error['diagnostic']);
    if (/heap out of memory|Invalid array length|Array buffer allocation failed/iu.test(message)) {
      throw sandboxError('OV_SANDBOX_MEMORY', `The code ran out of memory (limit ${String(limits.memoryMb)} MB).`, ['Reduce memory use of the composition.', `Raise limits.memoryMb above ${String(limits.memoryMb)}.`], details);
    }
    throw sandboxError('OV_SANDBOX_CRASH', `The code threw ${String(error['name'])}: ${message}`, ['Fix the error at the reported location.'], details);
  }
  if (/heap out of memory|Allocation failed|OOM/iu.test(outcome.stderr) || outcome.exitCode === 134 || outcome.exitCode === 137 || outcome.signal === 'SIGKILL') {
    throw sandboxError('OV_SANDBOX_MEMORY', `The code ran out of memory (limit ${String(limits.memoryMb)} MB).`, ['Reduce memory use of the composition.', `Raise limits.memoryMb above ${String(limits.memoryMb)}.`], common);
  }
  throw sandboxError('OV_SANDBOX_CRASH', `The sandbox process ended without a result (exit code ${String(outcome.exitCode)}).`, ['Check stderr in the diagnostic details.', 'Make sure the code does not call process.exit().'], common);
}

/**
 * Führt Code isoliert aus und liefert seinen Abschlusswert als JSON.
 *
 * @example
 * ```ts
 * const r = await runSandboxed({ code: 'input.a + 1', input: { a: 41 }, limits: { timeoutMs: 10_000 } });
 * r.output; // 42
 * ```
 */
export async function runSandboxed(request: SandboxRequest): Promise<SandboxResult> {
  const limits = limitsOf(request);
  const mode = request.mode ?? 'docker';
  const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT;
  const payload = JSON.stringify({ code: request.code, input: request.input ?? null, isolated: mode === 'trusted-host', timeoutMs: Math.ceil(limits.timeoutMs), filename: request.filename ?? 'sandbox.js' });
  const started = performance.now();

  if (mode === 'docker') {
    await ensureImage();
    const name = `ov-sandbox-${randomBytes(8).toString('hex')}`;
    const outcome = await runProcess({
      command: 'docker',
      args: dockerRunArgs(name, limits),
      stdin: payload,
      timeoutMs: limits.timeoutMs,
      maxOutputBytes,
      kill: (child) => {
        // Harter Abbruch des Containers; danach endet auch der docker-Client.
        const killer = spawn('docker', ['kill', name], { stdio: 'ignore' });
        killer.on('error', () => child.kill('SIGKILL'));
        killer.on('close', () => child.kill('SIGKILL'));
      },
    });
    if (outcome.spawnError !== undefined) throw unavailable(outcome.spawnError.code === 'ENOENT' ? 'the docker command was not found.' : outcome.spawnError.message);
    if (!outcome.timedOut && outcome.exitCode === 125) throw unavailable(outcome.stderr.trim().slice(0, 500));
    const output = interpret(outcome, limits, mode, maxOutputBytes);
    return { output, stderr: outcome.stderr, durationMs: Math.round(performance.now() - started), trusted: false };
  }

  const dir = await mkdtemp(join(tmpdir(), 'ov-trusted-'));
  try {
    const script = join(dir, 'bootstrap.cjs');
    await writeFile(script, BOOTSTRAP_SOURCE, 'utf8');
    const outcome = await runProcess({
      command: process.execPath,
      args: ['--permission', `--allow-fs-read=${dir}`, `--max-old-space-size=${String(heapMb(limits.memoryMb))}`, '--disable-warning=ExperimentalWarning', script],
      stdin: payload,
      timeoutMs: limits.timeoutMs,
      maxOutputBytes,
      kill: (child) => child.kill('SIGKILL'),
    });
    if (outcome.spawnError !== undefined) {
      const e = outcome.spawnError;
      throw sandboxError('OV_SANDBOX_CRASH', `Cannot start the host process: ${e.message}`, ['Check that Node.js can start child processes.'], { mode, errno: isErrno(e) ? String(e.code) : 'unknown' });
    }
    const output = interpret(outcome, limits, mode, maxOutputBytes);
    return { output, stderr: outcome.stderr, durationMs: Math.round(performance.now() - started), trusted: true };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
