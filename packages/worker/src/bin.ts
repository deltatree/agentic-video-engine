#!/usr/bin/env node
/**
 * `openvideo-worker`: startet einen Render-Worker.
 *
 * - `openvideo-worker --stdio`: Protokoll über stdin/stdout (Prozess- und Docker-Worker).
 * - `openvideo-worker --coordinator <url>`: Pull-Worker; Token aus `--token` oder `OPENVIDEO_WORKER_TOKEN`.
 *
 * Exit-Codes: 0 = sauber beendet, 1 = Fehler, 2 = falscher Aufruf.
 */
import { formatDiagnostic } from '@agentic-video/core';
import { runWorkerHttp } from './http.js';
import { runWorkerStdio } from './stdio.js';
import { toDiagnostic } from './workspace.js';

const USAGE = 'Usage: openvideo-worker --stdio | --coordinator <url> [--token <token>] [--name <worker>]\n';

function option(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(args: readonly string[]): Promise<number> {
  if (args.includes('--stdio')) {
    await runWorkerStdio();
    return 0;
  }
  const url = option(args, '--coordinator');
  if (url === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  const stop = new AbortController();
  // Kubernetes beendet Pods mit SIGTERM: laufenden Chunk abgeben, dann sauber enden.
  process.once('SIGTERM', () => {
    stop.abort();
  });
  process.once('SIGINT', () => {
    stop.abort();
  });
  const token = option(args, '--token') ?? process.env['OPENVIDEO_WORKER_TOKEN'];
  const name = option(args, '--name');
  await runWorkerHttp({ coordinatorUrl: url, signal: stop.signal, ...(token !== undefined ? { token } : {}), ...(name !== undefined ? { worker: name } : {}) });
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${formatDiagnostic(toDiagnostic(error))}\n`);
    process.exitCode = 1;
  },
);
