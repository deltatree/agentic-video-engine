/**
 * Externe Programme: Suche, Aufruf mit Timeout und strukturierte Fehler.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, createReadStream, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { OpenVideoError } from '@agentic-video/core';

/** Standard-Timeout für Sprachsynthese in Millisekunden. */
export const DEFAULT_VOICE_TIMEOUT_MS = 120_000;
/** Standard-Timeout für Transkription in Millisekunden. */
export const DEFAULT_ASR_TIMEOUT_MS = 600_000;

/** Höchstlänge des stderr-Auszugs in Diagnosen. */
const STDERR_EXCERPT = 2000;

/** Ergebnis eines Programmaufrufs. */
export interface ToolResult {
  readonly stdout: string;
  readonly stderr: string;
}

/** Optionen für {@link runTool}. */
export interface RunToolOptions {
  /** Provider-ID für Fehlermeldungen. */
  readonly provider: string;
  readonly timeoutMs: number;
  /** Text für stdin. */
  readonly input?: string;
  /** Installationshinweise für den Fehlerfall. */
  readonly hints: readonly string[];
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

/**
 * Sucht ein Programm: expliziter Pfad, dann Umgebungsvariable, dann `PATH`.
 * Ein Name ohne Pfadtrenner wird in `PATH` gesucht.
 *
 * @example
 * ```ts
 * locateBinary(['piper'], { explicit: options.binary, envVar: 'OPENVIDEO_PIPER' });
 * ```
 */
export function locateBinary(names: readonly string[], options: { readonly explicit?: string | undefined; readonly envVar?: string } = {}): string | undefined {
  const env = options.envVar !== undefined ? process.env[options.envVar] : undefined;
  const wanted = options.explicit ?? (env !== undefined && env !== '' ? env : undefined);
  const candidates = wanted !== undefined ? [wanted] : names;
  for (const name of candidates) {
    if (name.includes('/') || name.includes('\\') || isAbsolute(name)) {
      const full = resolve(name);
      if (isExecutable(full)) return full;
      continue;
    }
    for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
      if (dir === '') continue;
      const full = join(dir, process.platform === 'win32' ? `${name}.exe` : name);
      if (isExecutable(full)) return full;
    }
  }
  return undefined;
}

/** Prüft, ob eine Datei existiert und lesbar ist. */
export function isReadableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

/**
 * SHA-256 einer Datei (gestreamt, für große Modelle), als Hex-Text.
 *
 * @example
 * ```ts
 * const hex = await fileSha256('/models/ggml-tiny.en.bin');
 * ```
 */
export function fileSha256(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => {
        resolvePromise(hash.digest('hex'));
      });
  });
}

/** Letzte Zeichen eines stderr-Textes für Diagnosen. */
export function stderrExcerpt(stderr: string): string {
  const t = stderr.trim();
  return t.length > STDERR_EXCERPT ? `…${t.slice(t.length - STDERR_EXCERPT)}` : t;
}

/**
 * Fehler: Programm oder Modell fehlt.
 *
 * @example
 * ```ts
 * throw missingError('piper', 'The piper binary was not found.', PIPER_HINTS);
 * ```
 */
export function missingError(provider: string, problem: string, hints: readonly string[]): OpenVideoError {
  return new OpenVideoError({ code: 'OV_SPEECH_MISSING', errorClass: 'SpeechError', problem, details: { provider }, suggestions: hints });
}

/** Variablen, die Sprach-Programme erben (N1). Tokens und S3-Schlüssel (`OPENVIDEO_*`, `AWS_*`) bleiben draußen. */
const TOOL_ENV_NAMES: readonly string[] = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'LD_LIBRARY_PATH', 'PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV', 'SYSTEMROOT', 'WINDIR'];
/** Präfixe für Einstellungen der Programme selbst (espeak-ng, Piper, whisper.cpp, OpenMP, CUDA). */
const TOOL_ENV_PREFIXES: readonly string[] = ['ESPEAK_', 'PIPER_', 'WHISPER_', 'GGML_', 'OMP_', 'CUDA_', 'NVIDIA_'];

/**
 * Minimale Umgebung für Piper, whisper.cpp, espeak-ng und eigene Sprach-Programme (N1, Story 16.5).
 *
 * @example
 * ```ts
 * toolEnv({ PATH: '/usr/bin', OPENVIDEO_WORKER_TOKEN: 'secret' }); // { PATH: '/usr/bin' }
 * ```
 */
export function toolEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (TOOL_ENV_NAMES.includes(name) || TOOL_ENV_PREFIXES.some((p) => name.startsWith(p))) out[name] = value;
  }
  return out;
}

/**
 * Startet ein Programm, sammelt stdout/stderr und bricht nach `timeoutMs` ab.
 * Fehler (Start, Exit-Code ≠ 0, Timeout) werden zu {@link OpenVideoError} mit stderr-Auszug
 * und Installationshinweis.
 *
 * @example
 * ```ts
 * await runTool('/usr/bin/espeak-ng', ['--version'], { provider: 'espeak-ng', timeoutMs: 5000, hints: [] });
 * ```
 */
export function runTool(binary: string, args: readonly string[], options: RunToolOptions): Promise<ToolResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env: toolEnv(process.env) });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (code: string, problem: string, extra: readonly string[] = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new OpenVideoError({
          code,
          errorClass: 'SpeechError',
          problem,
          details: { provider: options.provider, binary, args: args.join(' '), stderr: stderrExcerpt(stderr) },
          suggestions: [...extra, ...options.hints],
        }),
      );
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail('OV_SPEECH_TIMEOUT', `${options.provider} did not finish within ${options.timeoutMs} ms.`, ['Increase timeoutMs for long texts or audio files.']);
    }, options.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      stderr = (stderr + c).slice(-64 * 1024);
    });
    child.on('error', (error) => {
      fail('OV_SPEECH_MISSING', `${options.provider} could not be started: ${error.message}`);
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (code === 0) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ stdout, stderr });
        return;
      }
      const lastLine = stderr.trim().split(/\r?\n/u).pop() ?? '';
      fail('OV_SPEECH_FAILED', `${options.provider} failed (${code !== null ? `exit code ${code}` : `signal ${signal ?? 'unknown'}`}): ${lastLine === '' ? 'no error output' : lastLine}`, [
        'Read details.stderr for the full error output of the program.',
      ]);
    });
    child.stdin.on('error', (error) => {
      stderr += `\nstdin: ${error.message}`;
    });
    child.stdin.end(options.input ?? '');
  });
}
