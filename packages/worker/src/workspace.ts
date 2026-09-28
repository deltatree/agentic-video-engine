/**
 * Temporäre Projektordner und Hilfen, die Stdio- und HTTP-Worker teilen.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { OpenVideoError, type Diagnostic } from '@agentic-video/core';
import { isSafeRelativePath, type ProjectFile } from '@agentic-video/scheduler';
import { createTelemetry, type Telemetry } from '@agentic-video/telemetry';

/** Ein temporärer Projektordner mit Aufräumfunktion. */
export interface TempProject {
  readonly dir: string;
  remove(): Promise<void>;
}

/**
 * Schreibt Projektdateien in einen neuen temporären Ordner.
 *
 * @example
 * ```ts
 * const tmp = await writeTempProject([{ path: 'assets/logo.png', bytes }]);
 * try { … } finally { await tmp.remove(); }
 * ```
 */
export async function writeTempProject(files: readonly ProjectFile[]): Promise<TempProject> {
  const dir = await mkdtemp(join(tmpdir(), 'openvideo-worker-'));
  for (const f of files) {
    if (!isSafeRelativePath(f.path)) {
      await rm(dir, { recursive: true, force: true });
      throw new OpenVideoError({
        code: 'OV_WORKER_UNSAFE_PATH',
        errorClass: 'WorkerError',
        problem: `The project file path "${f.path}" leaves the project folder.`,
        suggestions: ['Use relative paths without ".." inside the project.'],
      });
    }
    const target = join(dir, f.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, f.bytes);
  }
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}

/** Macht aus einem beliebigen Fehler eine Diagnose für Protokoll und HTTP. */
export function toDiagnostic(error: unknown): Diagnostic {
  if (error instanceof OpenVideoError) return error.diagnostic;
  return {
    code: 'OV_WORKER_INTERNAL',
    severity: 'error',
    errorClass: 'WorkerError',
    problem: error instanceof Error ? error.message : String(error),
    suggestions: ['Check the worker logs.', 'Report the error with the render manifest.'],
  };
}

/**
 * Telemetrie des Workers: OTLP, wenn `OTEL_EXPORTER_OTLP_ENDPOINT` gesetzt ist, sonst ohne Export.
 * Spans entstehen trotzdem, damit Log-Zeilen `trace_id` tragen.
 *
 * @example
 * ```ts
 * const telemetry = workerTelemetry((line) => process.stderr.write(`${line}\n`));
 * ```
 */
export function workerTelemetry(logSink: (line: string) => void, env: Readonly<Record<string, string | undefined>> = process.env): Telemetry {
  const endpoint = env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  return createTelemetry({
    serviceName: 'openvideo-worker',
    exporter: endpoint !== undefined && endpoint !== '' ? 'otlp' : 'none',
    ...(endpoint !== undefined && endpoint !== '' ? { otlpEndpoint: endpoint } : {}),
    logSink,
  });
}
