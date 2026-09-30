/**
 * HTTP-Server der Agent API (FR-21).
 *
 * - `GET  /v1/health` → `{ ok: true }`
 * - `GET  /v1/operations` → alle Operationen mit Schemas und Beispielen
 * - `POST /v1/<operation>` → JSON-Eingabe, JSON-Ergebnis oder `{ error: Diagnostic }`
 * - `GET  /v1/jobs/<id>` → Job-Status
 * - `GET  /v1/files/<projectId>/<pfad>` → Dateien eines Projekts (Frames, Videos, Manifeste); `ETag` ist die Inhalts-Revision
 * - `GET  /v1/events?projectId=<id>` → Server-Sent Events `revision` bei jeder Änderung von `project.json` (Story 20.1)
 *
 * Optional schützt ein Bearer-Token (`OPENVIDEO_API_TOKEN`) alle Endpunkte außer `/v1/health`.
 * Ohne Token bindet der Server nur an Loopback-Adressen (B2).
 * Gegen CSRF und DNS-Rebinding (B1) gilt: POST nur mit `content-type: application/json`,
 * der `Host`-Header muss auf der Allowlist stehen, ein fremder `Origin` wird abgelehnt.
 * Ein `traceparent`-Header verbindet den Aufruf mit dem Trace des Aufrufers.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { extname } from 'node:path';
import { OpenVideoError, type Diagnostic } from '@agentic-video/core';
import { invokeOperation, type OperationDefinition } from './operation.js';
import { OPERATIONS, readProjectFile } from './operations.js';
import { PLUGIN_PANEL_PATH, servePluginPanel, type PanelResponse } from './plugins.js';
import { assertProjectAccess } from './project-access.js';
import { RevisionWatcher, revisionOf, sseMessage } from './server-events.js';
import type { AgentServices } from './services.js';

/** Optionen für {@link startAgentServer}. */
export interface AgentServerOptions {
  readonly services: AgentServices;
  readonly port?: number;
  readonly host?: string;
  /** Bearer-Token; ohne Angabe ist die API offen und bindet nur an Loopback-Adressen. */
  readonly token?: string;
  /** Erlaubter Ursprung für CORS (z. B. Studio auf anderem Port). */
  readonly corsOrigin?: string;
  /** Weitere erlaubte Host-Namen für die `Host`- und `Origin`-Prüfung, z. B. `studio.example.com`. */
  readonly allowedHosts?: readonly string[];
  /** Maximale Größe eines Anfrage-Körpers in Bytes (Standard 32 MiB). */
  readonly maxBodyBytes?: number;
  /** Gleichzeitig bearbeitete API-Anfragen (Standard 8). */
  readonly maxConcurrentRequests?: number;
  /** Wartende API-Anfragen, bevor der Server mit 503 antwortet (Standard 64). */
  readonly maxQueuedRequests?: number;
  /** Zusätzliche Operationen (z. B. Agent-Tools aus Plugins). */
  readonly extraOperations?: ReadonlyMap<string, OperationDefinition>;
  /** Höchstzahl gleichzeitig offener Ereignis-Streams (`/v1/events`, Standard 32). */
  readonly maxEventStreams?: number;
  /** Weitere Routen (z. B. Studio-Dateien); liefert `true`, wenn die Anfrage behandelt wurde. */
  readonly fallback?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
}

/** Ein laufender Server. */
export interface AgentServer {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

/** Typen, die der Browser direkt anzeigen darf. Alles andere (auch SVG) kommt als Anhang (B3). */
const INLINE_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.json': 'application/json',
  '.wav': 'audio/wav',
};
const ATTACHMENT_MIME: Readonly<Record<string, string>> = { '.svg': 'image/svg+xml' };
const SECURITY_HEADERS: Readonly<Record<string, string>> = { 'x-content-type-options': 'nosniff' };
const FILE_HEADERS: Readonly<Record<string, string>> = { ...SECURITY_HEADERS, 'content-security-policy': "sandbox; default-src 'none'" };

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(text);
}

function apiError(code: string, problem: string, suggestions: readonly string[] = []): { error: Diagnostic } {
  return { error: { code, severity: 'error', errorClass: code === 'OV_API_HOST' || code === 'OV_API_ORIGIN' || code === 'OV_API_UNAUTHORIZED' ? 'SecurityError' : 'ApiError', problem, suggestions } };
}

function statusFor(d: Diagnostic): number {
  if (d.code === 'OV_API_UNKNOWN_OPERATION' || d.code === 'OV_PROJECT_UNKNOWN' || d.code === 'OV_JOB_UNKNOWN') return 404;
  if (d.errorClass === 'InternalError') return 500;
  if (d.errorClass === 'SecurityError') return 403;
  return 400;
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const tooLarge = new OpenVideoError({ code: 'OV_API_BODY_TOO_LARGE', errorClass: 'ApiError', problem: `Request body exceeds ${String(limit)} bytes.`, suggestions: ['Send smaller requests; import large files with asset.import { path } or { url }.'] });
  const declared = Number(req.headers['content-length'] ?? '0');
  if (Number.isFinite(declared) && declared > limit) throw tooLarge;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += b.length;
    if (size > limit) throw tooLarge;
    chunks.push(b);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) throw new OpenVideoError({ code: 'OV_API_BODY', errorClass: 'ApiError', problem: 'Request body is not valid JSON.', suggestions: ['Send a JSON object.'] });
    throw error;
  }
}

function tokenOk(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Ist `host` eine Loopback-Adresse?
 *
 * @example
 * ```ts
 * isLoopbackHost('127.0.0.1'); // true
 * isLoopbackHost('0.0.0.0'); // false
 * ```
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/gu, '');
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(h);
}

/** Host-Teil einer URL für eine Bind-Adresse (`0.0.0.0` → `127.0.0.1`, IPv6 in Klammern). */
function urlHost(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '[::1]';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function isWildcard(host: string): boolean {
  return host === '0.0.0.0' || host === '::';
}

/** Begrenzt gleichzeitige Anfragen; volle Warteschlange → `undefined` (B9). */
class RequestGate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly max: number,
    private readonly maxQueued: number,
  ) {}

  async acquire(): Promise<(() => void) | undefined> {
    if (this.active < this.max) this.active++;
    else if (this.waiting.length >= this.maxQueued) return undefined;
    else await new Promise<void>((r) => this.waiting.push(r));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      // Der Platz geht direkt an den nächsten Wartenden über.
      if (next !== undefined) next();
      else this.active--;
    };
  }
}

/**
 * Startet den HTTP-Server der Agent API.
 * Ohne Token lehnt er Nicht-Loopback-Adressen mit `OV_API_TOKEN_REQUIRED` ab.
 *
 * @example
 * ```ts
 * const server = await startAgentServer({ services, port: 7788 });
 * console.log(server.url); // http://127.0.0.1:7788
 * ```
 */
export function startAgentServer(options: AgentServerOptions): Promise<AgentServer> {
  const operations = new Map<string, OperationDefinition>([...OPERATIONS, ...(options.extraOperations ?? new Map<string, OperationDefinition>())]);
  const limit = options.maxBodyBytes ?? 32 * 1024 * 1024;
  const services = options.services;
  const bindHost = options.host ?? '127.0.0.1';
  const token = options.token !== undefined && options.token !== '' ? options.token : undefined;
  if (token === undefined && !isLoopbackHost(bindHost)) {
    return Promise.reject(
      new OpenVideoError({
        code: 'OV_API_TOKEN_REQUIRED',
        errorClass: 'SecurityError',
        problem: `The Agent API would listen on ${bindHost} without a token, open to the network.`,
        suggestions: ['Set OPENVIDEO_API_TOKEN (or --token) to a long random secret.', 'Or bind to 127.0.0.1 for local use only.'],
      }),
    );
  }
  const gate = new RequestGate(options.maxConcurrentRequests ?? 8, options.maxQueuedRequests ?? 64);
  const revisions = new RevisionWatcher();
  /** Offene Ereignis-Streams; `close()` beendet sie, sonst wartet `server.close` ewig. */
  const streams = new Set<ServerResponse>();
  const maxStreams = options.maxEventStreams ?? 32;
  const allowedHosts = new Set<string>();

  const hostOk = (req: IncomingMessage): boolean => typeof req.headers.host === 'string' && allowedHosts.has(req.headers.host.toLowerCase());
  const originOk = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    if (options.corsOrigin !== undefined && origin === options.corsOrigin) return true;
    try {
      const u = new URL(origin);
      return (u.protocol === 'http:' || u.protocol === 'https:') && allowedHosts.has(u.host.toLowerCase());
    } catch (error) {
      if (error instanceof TypeError) return false;
      throw error;
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      services.telemetry.logger.error('request failed', { url: req.url, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
      if (!res.headersSent) send(res, 500, apiError('OV_INTERNAL', 'Request failed.'));
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cors: Record<string, string> = options.corsOrigin !== undefined ? { 'access-control-allow-origin': options.corsOrigin, 'access-control-allow-headers': 'content-type, authorization, traceparent', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-expose-headers': 'etag' } : {};
    if (url.pathname === '/v1/health') {
      // Öffentlicher Vertrag für Monitore: ohne Token und ohne Host-Prüfung, verrät nichts.
      send(res, 200, { ok: true }, cors);
      return;
    }
    if (!hostOk(req)) {
      send(res, 403, apiError('OV_API_HOST', `Host "${req.headers.host ?? ''}" is not allowed.`, ['Use http://localhost:<port> or add the host name with --allowed-host / OPENVIDEO_ALLOWED_HOSTS.']));
      return;
    }
    // Studio-Panels aus Plugins (Story 21.1): iframes senden kein Bearer-Token; die signierte URL
    // aus plugins.list ist die Berechtigung. Unbekannte oder falsch signierte Pfade: 404. Vor der
    // Origin-Prüfung, weil die sandboxed Panel-Seite Module mit `Origin: null` lädt (nur GET, ohne Wirkung).
    if (req.method === 'GET' && url.pathname.startsWith(PLUGIN_PANEL_PATH)) {
      let panel: PanelResponse | undefined;
      try {
        panel = await servePluginPanel(services, url.pathname);
      } catch (error) {
        if (!(error instanceof OpenVideoError)) throw error;
        panel = undefined;
      }
      if (panel === undefined) send(res, 404, apiError('OV_API_NOT_FOUND', 'Unknown plugin panel.', ['Use the url from plugins.list.']));
      else {
        res.writeHead(panel.status, panel.headers);
        res.end(panel.body);
      }
      return;
    }
    if (!originOk(req)) {
      send(res, 403, apiError('OV_API_ORIGIN', `Origin "${req.headers.origin ?? ''}" is not allowed.`, ['Call the API from the Studio on the same origin, or configure --cors-origin.']));
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (url.pathname.startsWith('/v1/') && token !== undefined && !tokenOk(req.headers.authorization, token)) {
      send(res, 401, apiError('OV_API_UNAUTHORIZED', 'Missing or wrong bearer token.', ['Send "Authorization: Bearer <OPENVIDEO_API_TOKEN>".']), cors);
      return;
    }
    if (!url.pathname.startsWith('/v1/')) {
      if (options.fallback !== undefined && (await options.fallback(req, res))) return;
      send(res, 404, apiError('OV_API_NOT_FOUND', `No route for ${req.method ?? 'GET'} ${url.pathname}.`, ['GET /v1/operations lists all operations.']), cors);
      return;
    }
    // Ereignis-Streams bleiben offen und zählen darum nicht gegen die Anfragegrenze.
    if (req.method === 'GET' && url.pathname === '/v1/events') {
      await openEvents(url, res, cors);
      return;
    }
    const release = await gate.acquire();
    if (release === undefined) {
      send(res, 503, apiError('OV_API_BUSY', 'The server is busy.', ['Retry the request in a moment.']), { ...cors, 'retry-after': '1' });
      return;
    }
    try {
      await route(req, res, url, cors);
    } finally {
      release();
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL, cors: Record<string, string>): Promise<void> {
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
      await sendFile(res, ctx, fileMatch[1], fileMatch[2], cors);
      return;
    }
    // Eingebaute Operationen `bereich.verb`; Agent Tools aus Plugins `plugin.<name>` (Story 21.1).
    const opMatch = /^\/v1\/([a-z]+\.[A-Za-z]+|plugin\.[A-Za-z][A-Za-z0-9_.-]{0,63})$/u.exec(url.pathname);
    if (req.method === 'POST' && opMatch?.[1] !== undefined) {
      const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') {
        send(res, 415, apiError('OV_API_CONTENT_TYPE', 'Operations need "content-type: application/json".', ['Send the input as JSON with the header "content-type: application/json".']), cors);
        return;
      }
      let body: unknown;
      try {
        body = await readBody(req, limit);
      } catch (error) {
        if (!(error instanceof OpenVideoError)) throw error;
        const large = error.diagnostic.code === 'OV_API_BODY_TOO_LARGE';
        send(res, large ? 413 : 400, { error: error.diagnostic }, large ? { ...cors, connection: 'close' } : cors);
        return;
      }
      const r = await invokeOperation(operations, opMatch[1], body, ctx);
      if (r.ok) send(res, 200, r.result, cors);
      else send(res, statusFor(r.error), { error: r.error }, cors);
      return;
    }
    send(res, 404, apiError('OV_API_NOT_FOUND', `No route for ${req.method ?? 'GET'} ${url.pathname}.`, ['GET /v1/operations lists all operations.']), cors);
  }

  async function openEvents(url: URL, res: ServerResponse, cors: Record<string, string>): Promise<void> {
    const projectId = url.searchParams.get('projectId') ?? '';
    let dir: string;
    try {
      dir = services.workspace.projectDir(projectId);
    } catch (error) {
      if (!(error instanceof OpenVideoError)) throw error;
      send(res, 400, { error: error.diagnostic }, cors);
      return;
    }
    if (!services.workspace.exists(projectId)) {
      send(res, 404, apiError('OV_PROJECT_UNKNOWN', `Project "${projectId}" does not exist.`, ['List projects with project.inspect.']), cors);
      return;
    }
    try {
      await assertProjectAccess(services, projectId);
    } catch (error) {
      if (!(error instanceof OpenVideoError)) throw error;
      send(res, 403, { error: error.diagnostic }, cors);
      return;
    }
    if (streams.size >= maxStreams) {
      send(res, 503, apiError('OV_API_BUSY', `Too many open event streams (${String(maxStreams)}).`, ['Close other Studio tabs, or retry in a moment.']), { ...cors, 'retry-after': '5' });
      return;
    }
    // Platz sofort belegen und das Schließen vor dem ersten await beobachten, sonst leckt ein früh
    // getrennter Client seinen Watcher.
    streams.add(res);
    // Veränderlicher Zustand in einem Objekt: der close-Listener setzt ihn zwischen den awaits.
    const life: { closed: boolean; unsubscribe?: () => void; heartbeat?: ReturnType<typeof setInterval> } = { closed: false };
    res.on('close', () => {
      life.closed = true;
      if (life.heartbeat !== undefined) clearInterval(life.heartbeat);
      life.unsubscribe?.();
      streams.delete(res);
    });
    const push = (revision: string): void => {
      res.write(sseMessage('revision', { projectId, revision }));
    };
    let unsubscribe: () => void;
    try {
      unsubscribe = await revisions.subscribe(dir, push);
    } catch (error) {
      streams.delete(res);
      services.telemetry.logger.error('event stream failed', { project: projectId, error: error instanceof Error ? error.message : String(error) });
      if (!isClosed() && !res.headersSent) send(res, 500, apiError('OV_API_EVENTS', 'Live updates are not available for this project.', ['Reload the page; the Studio works without live updates.']), cors);
      return;
    }
    if (isClosed() || res.destroyed) {
      unsubscribe();
      streams.delete(res);
      return;
    }
    life.unsubscribe = unsubscribe;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', ...SECURITY_HEADERS, ...cors });
    const current = revisions.current(dir);
    // Erste Nachricht: der Stand beim Verbinden (der Client vergleicht mit dem, was er geladen hat).
    res.write(`retry: 2000\n\n${current !== undefined ? sseMessage('revision', { projectId, revision: current }) : ''}`);
    // Kommentarzeilen halten Proxys und den Browser-Timeout offen.
    const heartbeat = setInterval(() => {
      res.write(': keep-alive\n\n');
    }, 15_000);
    heartbeat.unref();
    life.heartbeat = heartbeat;

    function isClosed(): boolean {
      return life.closed;
    }
  }

  async function sendFile(res: ServerResponse, ctx: Parameters<typeof readProjectFile>[0], projectId: string, rawPath: string, cors: Record<string, string>): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = await readProjectFile(ctx, projectId, decodeURIComponent(rawPath));
    } catch (error) {
      if (!(error instanceof OpenVideoError) && !(error instanceof URIError)) throw error;
      // Keine Host-Pfade nach außen (B3, B18).
      send(res, 404, apiError('OV_FILE_NOT_FOUND', 'File not found.', ['Use the url returned by the operation.']), cors);
      return;
    }
    const ext = extname(rawPath).toLowerCase();
    const inline = INLINE_MIME[ext];
    const headers: Record<string, string> =
      inline !== undefined ? { 'content-type': inline } : { 'content-type': ATTACHMENT_MIME[ext] ?? 'application/octet-stream', 'content-disposition': 'attachment' };
    // Die ETag ist die Inhalts-Revision; für project.json dieselbe wie in /v1/events.
    res.writeHead(200, { ...headers, 'content-length': String(bytes.length), 'cache-control': 'no-store', etag: `"${revisionOf(bytes)}"`, ...FILE_HEADERS, ...cors });
    res.end(bytes);
  }

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 7788, bindHost, () => {
      server.off('error', reject);
      // Fehler nach dem Start (z. B. EMFILE) werden protokolliert, statt den Prozess zu beenden (B13).
      server.on('error', (error) => {
        services.telemetry.logger.error('agent server error', { error: error.message });
      });
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? 7788);
      const names = ['localhost', '127.0.0.1', '[::1]', ...(isWildcard(bindHost) ? [] : [urlHost(bindHost)])];
      for (const n of names) allowedHosts.add(`${n.toLowerCase()}:${String(port)}`);
      for (const n of options.allowedHosts ?? []) {
        allowedHosts.add(n.toLowerCase());
        allowedHosts.add(`${n.toLowerCase()}:${String(port)}`);
      }
      resolvePromise({
        server,
        url: `http://${urlHost(bindHost)}:${String(port)}`,
        close: () =>
          new Promise((r, j) => {
            revisions.closeAll();
            for (const stream of streams) stream.end();
            streams.clear();
            server.close((e) => {
              if (e !== undefined) j(e);
              else r();
            });
          }),
      });
    });
  });
}
