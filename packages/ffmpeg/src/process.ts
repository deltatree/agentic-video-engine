/**
 * Prozessaufrufe für FFmpeg und ffprobe: Timeout, stderr-Auswertung und
 * strukturierte Fehler ({@link OpenVideoError}).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { OpenVideoError } from '@agentic-video/core';

/** Standard-Timeout für kurze Aufrufe (Inspektion, Probe) in Millisekunden. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** Höchstmenge an stderr-Text, die ein Aufruf behält (Ende des Textes). */
const STDERR_LIMIT = 64 * 1024;

/** Ergebnis eines abgeschlossenen Prozessaufrufs. */
export interface ProcessResult {
  readonly stdout: Buffer;
  readonly stderr: string;
}

/** Optionen für {@link runProcess}. */
export interface RunOptions {
  /** Timeout in Millisekunden (Standard {@link DEFAULT_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
  /** Bytes, die auf stdin geschrieben werden. */
  readonly input?: Uint8Array;
  /** Lösungsvorschläge für den Fehlerfall; ersetzen die allgemeinen Vorschläge. */
  readonly suggestions?: readonly string[];
}

/**
 * Liefert die letzte nicht leere Zeile eines stderr-Textes.
 *
 * @example
 * ```ts
 * lastLine('a\nb\n\n'); // 'b'
 * ```
 */
export function lastLine(text: string): string {
  const lines = text.split(/\r?\n|\r/u).map((l) => l.trim()).filter((l) => l.length > 0);
  return lines[lines.length - 1] ?? '';
}

/** Hängt Text an einen begrenzten stderr-Puffer an. */
export function appendLimited(buffer: string, chunk: string): string {
  const next = buffer + chunk;
  return next.length > STDERR_LIMIT ? next.slice(next.length - STDERR_LIMIT) : next;
}

/** Baut den Fehler für einen fehlgeschlagenen Prozess. */
export function processError(binary: string, args: readonly string[], stderr: string, exit: string, suggestions?: readonly string[]): OpenVideoError {
  const line = lastLine(stderr);
  return new OpenVideoError({
    code: 'OV_FFMPEG_FAILED',
    errorClass: 'FfmpegError',
    problem: `${binary} failed (${exit}): ${line === '' ? 'no error output' : line}`,
    details: { binary, exit, lastStderr: line, args: args.join(' ') },
    suggestions: suggestions ?? [
      'Check that the input file exists and is a supported media file.',
      'Run the command from details.args manually to see the full FFmpeg output.',
      'Update FFmpeg to version 6 or newer.',
    ],
  });
}

/** Baut den Fehler für einen Prozess, der das Zeitlimit überschritten hat. */
export function timeoutError(binary: string, args: readonly string[], stderr: string, timeoutMs: number): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_FFMPEG_TIMEOUT',
    errorClass: 'FfmpegError',
    problem: `${binary} did not finish within ${String(timeoutMs)} ms.`,
    details: { binary, timeoutMs, lastStderr: lastLine(stderr), args: args.join(' ') },
    suggestions: ['Increase the timeoutMs option.', 'Shorten the media or lower the resolution.', 'Check that the input is not a stalled network stream.'],
  });
}

/** Fehler, wenn das Programm nicht startet (z. B. ENOENT). */
export function spawnError(binary: string, error: unknown): OpenVideoError {
  const message = error instanceof Error ? error.message : String(error);
  return new OpenVideoError({
    code: 'OV_FFMPEG_MISSING',
    errorClass: 'FfmpegError',
    problem: `Cannot start ${binary}: ${message}`,
    details: { binary, lastStderr: message },
    suggestions: installHints(),
    cause: error,
  });
}

/**
 * Installationshinweise je Betriebssystem.
 *
 * @example
 * ```ts
 * installHints('darwin')[0]; // 'Install FFmpeg: brew install ffmpeg'
 * ```
 */
export function installHints(platform: NodeJS.Platform = process.platform): string[] {
  const hint =
    platform === 'darwin'
      ? 'Install FFmpeg: brew install ffmpeg'
      : platform === 'win32'
        ? 'Install FFmpeg: winget install Gyan.FFmpeg (or choco install ffmpeg)'
        : 'Install FFmpeg: sudo apt install ffmpeg (Debian/Ubuntu), sudo dnf install ffmpeg (Fedora) or sudo pacman -S ffmpeg (Arch)';
  return [hint, 'Or set OPENVIDEO_FFMPEG and OPENVIDEO_FFPROBE to the full paths of the binaries.', 'Or pass the ffmpegPath option.'];
}

/** Wartet auf das Ende eines Prozesses und liefert Exit-Code oder Signal als Text. */
export function waitForExit(child: ChildProcess): Promise<string> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(`exit code ${String(child.exitCode)}`);
      return;
    }
    if (child.signalCode !== null) {
      resolve(`signal ${child.signalCode}`);
      return;
    }
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
      resolve(code !== null ? `exit code ${String(code)}` : `signal ${signal ?? 'unknown'}`);
    });
  });
}

/**
 * Führt ein Programm aus und sammelt stdout und stderr. Ein Exit-Code ungleich 0,
 * ein Startfehler oder ein Timeout werfen einen {@link OpenVideoError}.
 *
 * @example
 * ```ts
 * const { stdout } = await runProcess('/usr/bin/ffprobe', ['-version']);
 * ```
 */
export function runProcess(binary: string, args: readonly string[], options: RunOptions = {}): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => { reject(timeoutError(binary, args, stderr, timeoutMs)); });
    }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => { stderr = appendLimited(stderr, c); });
    child.on('error', (error) => { finish(() => { reject(spawnError(binary, error)); }); });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      finish(() => {
        if (code === 0) resolve({ stdout: Buffer.concat(chunks), stderr });
        else reject(processError(binary, args, stderr, code !== null ? `exit code ${String(code)}` : `signal ${signal ?? 'unknown'}`, options.suggestions));
      });
    });
    // Ein Prozess, der stdin nicht liest, darf keinen unbehandelten EPIPE auslösen.
    child.stdin.on('error', (error) => {
      stderr = appendLimited(stderr, `\nstdin: ${error.message}`);
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}
