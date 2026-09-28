/**
 * HTTP-Server der Agent API (FR-21).
 *
 * - `GET  /v1/health` → `{ ok: true }`
 * - `GET  /v1/operations` → alle Operationen mit Schemas und Beispielen
 * - `POST /v1/<operation>` → JSON-Eingabe, JSON-Ergebnis oder `{ error: Diagnostic }`
 * - `GET  /v1/jobs/<id>` → Job-Status
 * - `GET  /v1/files/<projectId>/<pfad>` → Dateien eines Projekts (Frames, Videos, Manifeste)
 *
 * Optional schützt ein Bearer-Token (`OPENVIDEO_API_TOKEN`) alle Endpunkte außer `/v1/health`.
 * Ein `traceparent`-Header verbindet den Aufruf mit dem Trace des Aufrufers.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { extname } from 'node:path';
import type { Diagnostic } from '@agentic-video/core';
import { invokeOperation, type OperationDefinition } from './operation.js';
import { OPERATIONS, readProjectFile } from './operations.js';
import type { AgentServices } from './services.js';

/** Optionen für {@link startAgentServer}. */
export interface AgentServerOptions {
  readonly services: AgentServices;
  readonly port?: number;
  readonly host?: string;
  /** Bearer-Token; ohne Angabe ist die API offen (nur für localhost empfohlen). */
  readonly token?: string;
  /** Erlaubter Ursprung für CORS (z. B. Studio auf anderem Port). */
  readonly corsOrigin?: string;
  /** Maximale Größe eines Anfrage-Körpers in Bytes (Standard 64 MiB). */
  readonly maxBodyBytes?: number;
  /** Zusätzliche Operationen (z. B. Agent-Tools aus Plugins). */
  readonly extraOperations?: ReadonlyMap<string, OperationDefinition>;
  /** Weitere Routen (z. B. Studio-Dateien); liefert `true`, wenn die Anfrage behandelt wurde. */
  readonly fallback?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
}

/** Ein laufender Server. */
export interface AgentServer {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

const MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.json': 'application/json',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
};

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(text);
}

function statusFor(d: Diagnostic): number {
  if (d.code === 'OV_API_UNKNOWN_OPERATION' || d.code === 'OV_PROJECT_UNKNOWN' || d.code === 'OV_JOB_UNKNOWN') return 404;
  if (d.errorClass === 'InternalError') return 500;
  if (d.errorClass === 'SecurityError') return 403;
  return 400;
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += b.length;
    if (size > limit) throw new Error(`Request body exceeds ${String(limit)} bytes.`);
    chunks.push(b);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  return JSON.parse(text);
}

function tokenOk(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Startet den HTTP-Server der Agent API.
 *
 * @example
 * ```ts
 * const server = await startAgentServer({ services, port: 7788 });
 * console.log(server.url); // http://127.0.0.1:7788
 * ```
 */
export function startAgentServer(options: AgentServerOptions): Promise<AgentServer> {
  const operations = new Map<string, OperationDefinition>([...OPERATIONS, ...(options.extraOperations ?? new Map<string, OperationDefinition>())]);
  const limit = options.maxBodyBytes ?? 64 * 1024 * 1024;
  const services = options.services;
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      services.telemetry.logger.error('request failed', { url: req.url, error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) send(res, 500, { error: { code: 'OV_INTERNAL', severity: 'error', errorClass: 'InternalError', problem: 'Request failed.', suggestions: [] } });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cors: Record<string, string> = options.corsOrigin !== undefined ? { 'access-control-allow-origin': options.corsOrigin, 'access-control-allow-headers': 'content-type, authorization, traceparent', 'access-control-allow-methods': 'GET, POST, OPTIONS' } : {};
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (url.pathname === '/v1/health') {
      send(res, 200, { ok: true }, cors);
      return;
    }
    if (url.pathname.startsWith('/v1/') && options.token !== undefined && !tokenOk(req.headers.authorization, options.token)) {
      send(res, 401, { error: { code: 'OV_API_UNAUTHORIZED', severity: 'error', errorClass: 'SecurityError', problem: 'Missing or wrong bearer token.', suggestions: ['Send "Authorization: Bearer <OPENVIDEO_API_TOKEN>".'] } }, cors);
      return;
    }
    const traceHeader = req.headers['traceparent'];
    const traceparent = typeof traceHeader === 'string' ? traceHeader : undefined;
    const ctx = { services, via: 'http' as const, ...(traceparent !== undefined ? { traceparent } : {}) };
    if (req.method === 'GET' && url.pathname === '/v1/operations') {
      send(
        res,
        200,
        {
          operations: [...operations.values()].map((op) => ({ name: op.name, summary: op.summary, job: op.job === true, input: op.input, output: op.output, example: op.example })),
        },
        cors,
      );
      return;
    }
    const jobMatch = /^\/v1\/jobs\/([A-Za-z0-9-]+)$/u.exec(url.pathname);
    if (req.method === 'GET' && jobMatch?.[1] !== undefined) {
      const r = await invokeOperation(operations, 'render.status', { jobId: jobMatch[1] }, ctx);
      if (r.ok) send(res, 200, r.result, cors);
      else send(res, statusFor(r.error), { error: r.error }, cors);
      return;
    }
    const fileMatch = /^\/v1\/files\/([a-z0-9-]+)\/(.+)$/u.exec(url.pathname);
    if (req.method === 'GET' && fileMatch?.[1] !== undefined && fileMatch[2] !== undefined) {
      try {
        const bytes = await readProjectFile(ctx, fileMatch[1], decodeURIComponent(fileMatch[2]));
        res.writeHead(200, { 'content-type': MIME[extname(fileMatch[2]).toLowerCase()] ?? 'application/octet-stream', 'content-length': String(bytes.length), ...cors });
        res.end(bytes);
      } catch (error) {
        send(res, 404, { error: { code: 'OV_FILE_NOT_FOUND', severity: 'error', errorClass: 'ApiError', problem: error instanceof Error ? error.message : 'File not found.', suggestions: [] } }, cors);
      }
      return;
    }
    const opMatch = /^\/v1\/([a-z]+\.[A-Za-z]+)$/u.exec(url.pathname);
    if (req.method === 'POST' && opMatch?.[1] !== undefined) {
      let body: unknown;
      try {
        body = await readBody(req, limit);
      } catch (error) {
        send(res, 400, { error: { code: 'OV_API_BODY', severity: 'error', errorClass: 'ApiError', problem: error instanceof Error ? error.message : 'Invalid body.', suggestions: ['Send a JSON object.'] } }, cors);
        return;
      }
      const r = await invokeOperation(operations, opMatch[1], body, ctx);
      if (r.ok) send(res, 200, r.result, cors);
      else send(res, statusFor(r.error), { error: r.error }, cors);
      return;
    }
    if (options.fallback !== undefined && (await options.fallback(req, res))) return;
    send(res, 404, { error: { code: 'OV_API_NOT_FOUND', severity: 'error', errorClass: 'ApiError', problem: `No route for ${req.method ?? 'GET'} ${url.pathname}.`, suggestions: ['GET /v1/operations lists all operations.'] } }, cors);
  }

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 7788, options.host ?? '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : options.port ?? 7788;
      resolvePromise({
        server,
        url: `http://${options.host ?? '127.0.0.1'}:${String(port)}`,
        close: () =>
          new Promise((r, j) => {
            server.close((e) => {
              if (e !== undefined) j(e);
              else r();
            });
          }),
      });
    });
  });
}
