/**
 * Die Kommandozeile `openvideo` (FR-77, FR-78, A28).
 *
 * Exit-Codes (API, siehe README):
 * - 0: Erfolg
 * - 1: Das Projekt oder der Render hat Fehler (Diagnosen stehen in der Ausgabe)
 * - 2: Falsche Bedienung (unbekannter Befehl, fehlende Option)
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { OPERATIONS, isLoopbackHost, startAgentServer, type AgentServices, type InvocationResult } from '@agentic-video/agent';
import { createCache, storeFromEnv, CACHE_TIERS, type CacheTierName } from '@agentic-video/cache';
import {
  CLI_NAME,
  OpenVideoError,
  PRODUCT_NAME,
  compositionDurationFrames,
  findComposition,
  formatDiagnostic,
  isRecord,
  migrateProject,
  resolveMarkers,
  toFrames,
  type DebugOptions,
  type Diagnostic,
} from '@agentic-video/core';
import { encodePng } from '@agentic-video/png';
import { defaultWorkerCount } from '@agentic-video/scheduler';
import { createTemplateCatalog } from '@agentic-video/templates';
import { buildFrameManifest, cacheMaxBytesFromEnv, checkProject, createNodeEnvironment, describeScene, encoderThreadsFor, inspectTimeline, profileById, renderFrame, renderVideo, sceneTree, OPENVIDEO_VERSION, type OutputProfile } from '@agentic-video/render';
import { cannotOpenReason, openBrowser } from './browser.js';
import { runDoctor } from './doctor.js';
import { createProjectDir, helloProject, loadProject, singleProjectWorkspace } from './project.js';
import { createLocalServices, dockerRunner, dockerSettingsFromEnv, htmlScriptsAllowed, processRunner, renderIsolationFromEnv, workersFromEnv, type LocalServices, type RenderIsolation } from './services.js';
import { createSourceService } from './sources.js';
import { LEGACY_CACHE_TIERS, cacheTierByName, clearCache } from './cache-clear.js';
import { importInput, isProjectDir, parseInputArg, projectContext, projectRootsOf, resultFailed, runOperation, withDefaults } from './ops.js';
import { watchProject, type WatchEvent } from './watch.js';
import { stdinClosed } from './stdin.js';

/** Ein- und Ausgabe der CLI (für Tests austauschbar). */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Beendet `serve`, `dev` und `studio`, sobald das Versprechen erfüllt ist (Tests); sonst SIGINT/SIGTERM. */
  readonly stop?: Promise<void>;
  /** Öffnet eine URL im Browser (Tests ersetzen das); liefert bei Fehlern den Grund. */
  readonly openUrl?: (url: string) => Promise<string | undefined>;
  /** Plattform für `--open` (Tests); Standard `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

class UsageError extends Error {}

const HELP = `${PRODUCT_NAME} ${OPENVIDEO_VERSION} – Video-as-Code for coding agents

Usage: ${CLI_NAME} <command> [options]

Commands:
  create <dir>          Create a project (--tsx for TypeScript/JSX, --template <name>)
  templates             List the project templates
  dev [dir]             Studio with live preview; watches src/** and project.json, opens the browser (--no-open)
  studio [dir]          Same as dev
  validate [path]       Validate schema, assets, fonts and backends
  render [path]         Render a video (--format --codec --width --height --fps --out --workers <n>, default by cores and memory;
                        --isolation docker renders chunks in containers: --image <worker image> --gpus all|1|device=0)
  render-frame [path]   Render one frame to PNG (--frame 2s --scale 0.5 --debug bounds,safe; --manifest writes <out>.manifest.json)
  inspect [path]        Project summary, scene tree (--frame) or timeline (--timeline)
  op <name>             Run any Agent API operation, same as HTTP/MCP (--input <json|@file>; op --list)
  patch [path]          Apply semantic patches (--input <json|@file> with a patch list; --dry-run)
  contact-sheet [path]  Render several frames into one image (--frames 0,2s,4s | --count 8 --out sheet.png; --manifest writes <out>.manifest.json)
  import <file> [path]  Import SVG, Lottie, glTF, HTML, anime/motion-canvas JSON (--format --id-prefix)
  doctor                Check the environment and suggest fixes
  benchmark             Run reproducible benchmarks (--scenario --resolution --frames --compare)
  cache <stats|clear|prune>   Manage the cache (--tier frame --max-bytes 1e9; clear also removes retired tiers)
  fonts [list|check] [path]   List or check fonts
  assets <list|import|inspect> [path]   Manage assets
  serve                 Start the Agent API (HTTP) with the Studio (--project <dir> opens a project)
  mcp                   Start the MCP server on stdio (--project <dir> opens a project)
  migrate <file>        Upgrade an older project file (--write)
  worker                Start a render worker (--stdio or --coordinator <url>)
  coordinator           Start the render coordinator for remote workers (--port --journal; role tokens OPENVIDEO_SUBMIT_TOKEN, OPENVIDEO_WORKER_TOKEN, OPENVIDEO_METRICS_TOKEN)

Server options (serve, dev, studio):
  --host <addr>          Bind address (default 127.0.0.1; others need a token)
  --port <n>             Port (default 7788)
  --token <secret>       Bearer token (or OPENVIDEO_API_TOKEN); dev/studio create one
  --allowed-host <name>  Extra host name for the Host/Origin check (or OPENVIDEO_ALLOWED_HOSTS)
  --trust-proxy          Trust X-Forwarded-Proto from any peer, e.g. behind a TLS proxy on another host
                         (or OPENVIDEO_TRUST_PROXY=1; default: only from loopback)
  --workers <n>          Render videos with n local worker processes (default by cores and memory; 1 = in process)
  --isolation <mode>     Where video chunks render: process (default) or docker (OPENVIDEO_RENDER_ISOLATION;
                         image OPENVIDEO_WORKER_IMAGE / --image, GPU quota OPENVIDEO_WORKER_GPUS / --gpus)
  --open / --no-open     Open the Studio in the browser (default on for dev/studio, off for serve)

Project and workspace (serve, mcp, op):
  --project <dir>        Open this project folder (project.open may open folders inside it)
  --workspace <dir>      Workspace folder (or OPENVIDEO_WORKSPACE; default .openvideo-workspace)
  OPENVIDEO_PROJECT_ROOTS  Comma-separated folders that project.open may open

Global options:
  --json      Machine-readable output
  --trusted   Allow TSX and HTML scripts of YOUR OWN project to run on this host
  --help      Show help

Exit codes: 0 success, 1 project or render errors, 2 usage errors.`;

function frameOf(project: Readonly<Record<string, unknown>>, compositionId: string | undefined, value: string): number {
  const comp = findComposition(project, compositionId);
  const fps = Number(comp['fps']);
  const markers = resolveMarkers(Array.isArray(comp['markers']) ? comp['markers'].filter(isRecord).map((m) => ({ id: String(m['id']), time: typeof m['time'] === 'number' ? m['time'] : String(m['time']) })) : [], fps);
  return Math.round(toFrames(/^[0-9]+$/u.test(value) ? Number(value) : value, { fps, markers }));
}

function debugOf(value: string | undefined): DebugOptions | undefined {
  if (value === undefined) return undefined;
  const map: Readonly<Record<string, keyof DebugOptions>> = { bounds: 'showBounds', anchors: 'showAnchors', safe: 'showSafeArea', baseline: 'showBaseline', grid: 'showGrid', ids: 'showNodeIds', frustum: 'showCameraFrustum', lights: 'showLightHelpers' };
  const out: Record<string, boolean> = {};
  for (const part of value.split(',')) {
    const key = map[part.trim()];
    if (key === undefined) throw new UsageError(`Unknown debug overlay "${part}". Use: ${Object.keys(map).join(', ')}.`);
    out[key] = true;
  }
  return out;
}

function num(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number.`);
  return n;
}

function studioDir(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [env['OPENVIDEO_STUDIO_DIR'], join(here, '..', 'studio'), join(here, '..', '..', '..', 'apps', 'studio', 'dist')];
  return candidates.find((c): c is string => c !== undefined && existsSync(join(c, 'index.html')));
}

/**
 * Sicherheits-Header der Studio-Dateien (Story 16.7, N3): kein Einbetten in fremde Seiten
 * (`frame-ancestors 'none'`), kein Referer, Skripte nur von der eigenen Origin. Monaco braucht
 * Inline-Styles, Worker aus `blob:` und Bilder aus `data:`.
 */
export const STUDIO_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

const MIME: Readonly<Record<string, string>> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };

interface ServeOptions {
  readonly port: number;
  readonly host: string;
  readonly token?: string | undefined;
  readonly allowedHosts: readonly string[];
  readonly projectId?: string;
  /** Token im Studio-Link ausgeben (dev/studio mit erzeugtem Token). */
  readonly showToken?: boolean;
  /** Studio im Browser öffnen (Story 20.1). */
  readonly open?: boolean;
  /** `X-Forwarded-Proto` jeder Gegenstelle vertrauen (`--trust-proxy`, `OPENVIDEO_TRUST_PROXY=1`). */
  readonly trustProxy?: boolean;
  /** Projektordner beobachten und TSX neu kompilieren (`openvideo dev`). */
  readonly watch?: { readonly dir: string; readonly entry: string; readonly sources: SourceServiceOf };
}

type SourceServiceOf = ReturnType<typeof createSourceService>;

/**
 * Meldung des Datei-Watchers für das Terminal. Gültige JSON-Änderungen und Kompilate ohne neue IR bleiben
 * still: Jede Studio-Änderung schreibt `project.json`, das Terminal soll dabei nicht mitlaufen.
 */
function watchMessage(event: WatchEvent): string {
  if (event.kind === 'compiled') return event.changed ? `Recompiled after ${event.file} changed; the Studio reloads.\n` : '';
  if (event.kind === 'changed') return '';
  return `${event.file}: ${event.diagnostics.filter((d) => d.severity === 'error').map((d) => formatDiagnostic(d)).join('\n\n')}\n`;
}

async function serveServices(services: AgentServices, io: CliIo, options: ServeOptions): Promise<void> {
  const studio = studioDir(io.env);
  const server = await startAgentServer({
    services,
    port: options.port,
    host: options.host,
    allowedHosts: options.allowedHosts,
    trustProxy: options.trustProxy === true,
    ...(options.token !== undefined ? { token: options.token } : {}),
    fallback: async (req, res) => {
      if (studio === undefined || req.method !== 'GET') return false;
      const url = new URL(req.url ?? '/', 'http://localhost');
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = resolve(studio, rel);
      if (!file.startsWith(studio + sep) || !existsSync(file)) return false;
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', ...STUDIO_HEADERS });
      res.end(await readFile(file));
      return true;
    },
  });
  const query = new URLSearchParams(options.projectId !== undefined ? { project: options.projectId } : {}).toString();
  // Das Token steht im Fragment: Der Browser sendet es nie an einen Server, auch nicht im Referer.
  const fragment = options.showToken === true && options.token !== undefined ? `#token=${encodeURIComponent(options.token)}` : '';
  const link = `${server.url}/${query !== '' ? `?${query}` : ''}${fragment}`;
  io.stdout(`${PRODUCT_NAME} API: ${server.url}/v1/operations\n`);
  if (options.showToken === true && options.token !== undefined) io.stdout(`API token (send as "Authorization: Bearer <token>"): token=${options.token}\n`);
  io.stdout(studio !== undefined ? `${PRODUCT_NAME} Studio: ${link}\n` : 'Studio files not found (build apps/studio or set OPENVIDEO_STUDIO_DIR).\n');
  const watcher =
    options.watch !== undefined
      ? watchProject({
          ...options.watch,
          onEvent: (event) => {
            const text = watchMessage(event);
            if (text !== '') (event.kind === 'error' ? io.stderr : io.stdout)(text);
          },
        })
      : undefined;
  if (watcher !== undefined) io.stdout(`Watching ${options.watch?.entry === 'project.json' ? 'project.json' : 'src/** and project.json'} for changes.\n`);
  if (options.open === true && studio !== undefined) {
    const reason = io.openUrl !== undefined ? undefined : cannotOpenReason(io.platform ?? process.platform, io.env);
    const problem = reason !== undefined ? `not opened: ${reason}` : await (io.openUrl ?? ((u: string) => openBrowser(u, io.platform ?? process.platform)))(link);
    if (problem !== undefined) io.stderr(`Browser ${problem.startsWith('not opened') ? problem : `not opened: ${problem}`}. Open the Studio link above.\n`);
  }
  await new Promise<void>((resolveStop) => {
    const stop = () => {
      watcher?.close();
      void server.close().then(resolveStop);
    };
    if (io.stop !== undefined) void io.stop.then(stop);
    else {
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }
  });
}

/** Cache-Obergrenze aus `OPENVIDEO_CACHE_MAX_BYTES` als Render-Option (Story 18.9). */
function cacheBudget(env: Readonly<Record<string, string | undefined>>): { cacheMaxBytes?: number } {
  const max = cacheMaxBytesFromEnv(env);
  return max !== undefined ? { cacheMaxBytes: max } : {};
}

/**
 * Proxy-Vertrauen für `serve`, `dev` und `studio`: `--trust-proxy` oder `OPENVIDEO_TRUST_PROXY`
 * (`1`/`true`/`yes`). Dann zählt `X-Forwarded-Proto` jeder Gegenstelle (z. B. TLS-Proxy auf einem
 * anderen Rechner) für die Studio-Origin; sonst nur von Loopback.
 *
 * @example
 * ```ts
 * trustProxyOf(undefined, { OPENVIDEO_TRUST_PROXY: '1' }); // true
 * ```
 */
export function trustProxyOf(flag: boolean | undefined, env: Readonly<Record<string, string | undefined>>): boolean {
  if (flag === true) return true;
  const raw = env['OPENVIDEO_TRUST_PROXY']?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/** Erlaubte Host-Namen aus `--allowed-host` und `OPENVIDEO_ALLOWED_HOSTS` (kommagetrennt). */
function allowedHostsOf(values: readonly string[] | undefined, env: Readonly<Record<string, string | undefined>>): string[] {
  const fromEnv = (env['OPENVIDEO_ALLOWED_HOSTS'] ?? '').split(',').map((h) => h.trim()).filter((h) => h !== '');
  return [...(values ?? []), ...fromEnv];
}

/** Führt einen Server mit Diensten aus und räumt die Dienste immer auf. */
async function runServer(services: LocalServices, io: CliIo, options: ServeOptions): Promise<number> {
  try {
    await serveServices(services, io, options);
    return 0;
  } finally {
    await services.dispose();
  }
}

function printDiagnostics(io: CliIo, diagnostics: readonly Diagnostic[]): void {
  for (const d of diagnostics) io.stderr(`[${d.severity}] ${formatDiagnostic(d)}\n\n`);
}

/**
 * Führt die CLI aus und liefert den Exit-Code.
 *
 * @example
 * ```ts
 * const code = await runCli(['validate', 'examples/hello', '--json'], { stdout: console.log, stderr: console.error, cwd: process.cwd(), env: process.env });
 * ```
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  // Benchmark-Optionen wertet openvideo-bench selbst aus; darum vor dem Parsen weiterreichen.
  if (argv[0] === 'benchmark') return runBenchmark(argv.slice(1), io);
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        trusted: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        tsx: { type: 'boolean' },
        template: { type: 'string' },
        name: { type: 'string' },
        composition: { type: 'string', short: 'c' },
        format: { type: 'string', short: 'f' },
        codec: { type: 'string' },
        width: { type: 'string' },
        height: { type: 'string' },
        fps: { type: 'string' },
        quality: { type: 'string' },
        alpha: { type: 'boolean' },
        profile: { type: 'string' },
        out: { type: 'string', short: 'o' },
        start: { type: 'string' },
        end: { type: 'string' },
        workers: { type: 'string' },
        frame: { type: 'string' },
        scale: { type: 'string' },
        debug: { type: 'string' },
        timeline: { type: 'boolean' },
        tier: { type: 'string' },
        'max-bytes': { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        token: { type: 'string' },
        'allowed-host': { type: 'string', multiple: true },
        'trust-proxy': { type: 'boolean' },
        workspace: { type: 'string' },
        write: { type: 'boolean' },
        id: { type: 'string' },
        open: { type: 'boolean' },
        'no-open': { type: 'boolean' },
        offline: { type: 'boolean' },
        stdio: { type: 'boolean' },
        coordinator: { type: 'string' },
        journal: { type: 'string' },
        scenario: { type: 'string' },
        resolution: { type: 'string' },
        frames: { type: 'string' },
        input: { type: 'string', short: 'i' },
        project: { type: 'string', short: 'p' },
        list: { type: 'boolean' },
        'dry-run': { type: 'boolean' },
        'id-prefix': { type: 'string' },
        count: { type: 'string' },
        isolation: { type: 'string' },
        image: { type: 'string' },
        gpus: { type: 'string' },
        manifest: { type: 'boolean' },
      },
    });
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  const json = values.json === true;
  const trusted = values.trusted === true;
  const out = (data: unknown, text: string): void => {
    io.stdout(json ? `${JSON.stringify(data, null, 2)}\n` : text.endsWith('\n') ? text : `${text}\n`);
  };
  if (values.version === true) {
    out({ version: OPENVIDEO_VERSION }, OPENVIDEO_VERSION);
    return 0;
  }
  if (values.help === true || command === undefined || command === 'help') {
    io.stdout(`${HELP}\n`);
    return command === undefined && values.help !== true ? 2 : 0;
  }
  const target = resolve(io.cwd, rest[0] ?? '.');
  const sources = createSourceService({ trusted, env: io.env });
  // Dienste mit Telemetrie: Die Ebene `compiled` der Quellen meldet an dieselbe Telemetrie (ADR 0021).
  const localServices = async (options: Parameters<typeof createLocalServices>[0]): Promise<LocalServices> => {
    const services = await createLocalServices(options);
    sources.useTelemetry(services.telemetry);
    return services;
  };
  const isolation = trusted ? 'trusted' : 'container';
  const offline = values.offline === true ? { offline: true } : {};
  const withEnv = async <T>(fn: (loaded: Awaited<ReturnType<typeof loadProject>>, env: Awaited<ReturnType<typeof createNodeEnvironment>>) => Promise<T>): Promise<T> => {
    const loaded = await loadProject(target, { sources });
    // Direkte CLI-Befehle dürfen mit --trusted Pfade außerhalb nutzen; Server-Befehle nie (B6).
    const env = await createNodeEnvironment({ projectDir: loaded.dir, project: loaded.project, trusted, ...offline, allowOutsidePaths: trusted, allowHtmlScripts: htmlScriptsAllowed(isolation, io.env) });
    try {
      return await fn(loaded, env);
    } finally {
      await env.dispose();
    }
  };
  const isolationValue = values.isolation;
  if (isolationValue !== undefined && isolationValue !== 'process' && isolationValue !== 'docker') {
    io.stderr(`--isolation must be "process" or "docker".\n\n${HELP}\n`);
    return 2;
  }
  // Render-Isolation (Story 21.3): Flag vor OPENVIDEO_RENDER_ISOLATION; Docker-Einstellungen aus --image/--gpus und Umgebung.
  const renderIsolationOption = (): { renderIsolation?: RenderIsolation; docker?: { image?: string; gpus?: string } } => {
    const mode: RenderIsolation | undefined = isolationValue ?? renderIsolationFromEnv(io.env);
    return {
      ...(mode !== undefined ? { renderIsolation: mode } : {}),
      ...(values.image !== undefined || values.gpus !== undefined ? { docker: { ...(values.image !== undefined ? { image: values.image } : {}), ...(values.gpus !== undefined ? { gpus: values.gpus } : {}) } } : {}),
    };
  };
  try {
    const serverWorkers = num(values.workers, 'workers');
    // `--workers 1` rendert im Server-Prozess; ohne Angabe gilt die Standardzahl (Story 18.7).
    const workersOption = serverWorkers !== undefined && serverWorkers >= 1 ? { workers: Math.floor(serverWorkers) } : {};
    switch (command) {
      case 'create': {
        if (rest[0] === undefined) throw new UsageError('Usage: openvideo create <dir> [--tsx] [--template <name>]');
        const name = values.name ?? rest[0].split('/').pop() ?? 'hello';
        let dir: string;
        if (values.template !== undefined) {
          // Template: TSX-Quelle, README und geprüfte IR (project.json) aus dem Katalog.
          const { project, files } = await createTemplateCatalog().get(values.template);
          const { ['src/video.tsx']: source, ...other } = files;
          dir = await createProjectDir(target, { name, project: { ...project }, files: other, ...(source !== undefined ? { source } : {}) });
        } else {
          const project = helloProject(name.charAt(0).toUpperCase() + name.slice(1));
          const source = values.tsx === true ? helloSource(name) : undefined;
          dir = await createProjectDir(target, { name, project, ...(source !== undefined ? { source } : {}) });
        }
        out({ projectDir: dir }, `Created ${dir}\n\nNext:\n  cd ${rest[0]}\n  ${CLI_NAME} dev\n`);
        return 0;
      }
      case 'templates': {
        const list = createTemplateCatalog().list();
        out({ templates: list }, list.map((t) => `${t.name.padEnd(24)} ${t.description}`).join('\n'));
        return 0;
      }
      case 'worker': {
        const worker = await import('@agentic-video/worker');
        if (values.stdio === true) {
          await worker.runWorkerStdio();
          return 0;
        }
        if (values.coordinator === undefined) throw new UsageError('Usage: openvideo worker --stdio | --coordinator <url> [--token <token>] [--name <worker>]');
        const stop = new AbortController();
        // Kubernetes beendet Pods mit SIGTERM: laufenden Chunk abgeben, dann sauber enden.
        process.once('SIGTERM', () => {
          stop.abort();
        });
        process.once('SIGINT', () => {
          stop.abort();
        });
        const token = values.token ?? io.env['OPENVIDEO_WORKER_TOKEN'];
        await worker.runWorkerHttp({ coordinatorUrl: values.coordinator, signal: stop.signal, ...(token !== undefined ? { token } : {}), ...(values.name !== undefined ? { worker: values.name } : {}) });
        return 0;
      }
      case 'coordinator': {
        const { startCoordinator } = await import('@agentic-video/scheduler');
        // Rollen-Tokens wie in scheduler/src/coordinator.ts (Story 16.3): submit (API), worker, metrics (KEDA).
        // `--token` ist ein gemeinsames Token für alle Rollen (nur lokaler Betrieb).
        const nonEmpty = (v: string | undefined): string | undefined => (v !== undefined && v !== '' ? v : undefined);
        const shared = nonEmpty(values.token);
        const submitToken = nonEmpty(io.env['OPENVIDEO_SUBMIT_TOKEN']);
        const workerToken = nonEmpty(io.env['OPENVIDEO_WORKER_TOKEN']);
        const metricsToken = nonEmpty(io.env['OPENVIDEO_METRICS_TOKEN']);
        const tokens = {
          ...(submitToken !== undefined ? { submit: submitToken } : {}),
          ...(workerToken !== undefined ? { worker: workerToken } : {}),
          ...(metricsToken !== undefined ? { metrics: metricsToken } : {}),
        };
        const host = values.host ?? '127.0.0.1';
        const port = num(values.port, 'port') ?? 8080;
        if (shared === undefined && Object.keys(tokens).length === 0 && !isLoopbackHost(host)) {
          throw new OpenVideoError({
            code: 'OV_API_TOKEN_REQUIRED',
            errorClass: 'SecurityError',
            problem: `The coordinator would listen on ${host} without a token.`,
            suggestions: ['Set OPENVIDEO_SUBMIT_TOKEN, OPENVIDEO_WORKER_TOKEN and OPENVIDEO_METRICS_TOKEN (one random token per role).', 'Or pass --token <secret> for a single shared token (local use).', 'Or bind to 127.0.0.1 for local use.'],
          });
        }
        const workspaceDir = resolve(io.cwd, values.workspace ?? '.');
        const store = storeFromEnv(io.env, workspaceDir);
        const coordinator = await startCoordinator({ port, host, store, journalDir: resolve(io.cwd, values.journal ?? join(workspaceDir, '.openvideo', 'journal')), ...(shared !== undefined ? { token: shared } : {}), ...(Object.keys(tokens).length > 0 ? { tokens } : {}) });
        out({ url: coordinator.url, store: store.name }, `${PRODUCT_NAME} coordinator: ${coordinator.url} (store ${store.name})`);
        await new Promise<void>((resolveStop) => {
          const stop = () => {
            void coordinator.close().then(resolveStop);
          };
          if (io.stop !== undefined) void io.stop.then(stop);
          else {
            process.once('SIGINT', stop);
            process.once('SIGTERM', stop);
          }
        });
        return 0;
      }
      case 'validate': {
        const diagnostics = await withEnv((loaded, env) => Promise.resolve([...env.assetDiagnostics, ...checkProject(env, loaded.project)]));
        const errors = diagnostics.filter((d) => d.severity === 'error').length;
        if (json) out({ ok: errors === 0, diagnostics }, '');
        else {
          printDiagnostics(io, diagnostics);
          io.stdout(errors === 0 ? `Valid (${String(diagnostics.length)} notes).\n` : `${String(errors)} error(s).\n`);
        }
        return errors === 0 ? 0 : 1;
      }
      case 'render-frame': {
        if (values.frame === undefined) throw new UsageError('Usage: openvideo render-frame [path] --frame <number|time> [--scale 0.5] [--out frame.png]');
        return await withEnv(async (loaded, env) => {
          const frame = frameOf(loaded.project, values.composition, values.frame ?? '0');
          const debug = debugOf(values.debug);
          const r = await renderFrame(env, loaded.project, { ...(values.composition !== undefined ? { compositionId: values.composition } : {}), frame, scale: num(values.scale, 'scale') ?? 1, ...(debug !== undefined ? { debug } : {}) });
          const file = resolve(io.cwd, values.out ?? join(loaded.dir, 'out', `frame-${String(frame)}.png`));
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, encodePng(r.image));
          // Kurzmanifest (Story 21.5): Eingabe-Hashes, Pixel-Hash, genutzte Backends, Grafik, Chromium, GPU.
          const manifestFile = values.manifest === true ? `${file}.manifest.json` : undefined;
          if (manifestFile !== undefined) await writeFile(manifestFile, `${JSON.stringify(await buildFrameManifest(env, loaded.project, [{ frame, ...r }], num(values.scale, 'scale') ?? 1), null, 2)}\n`);
          if (!json) printDiagnostics(io, r.diagnostics.filter((d) => d.severity !== 'info'));
          out({ file, frame, key: r.key, cached: r.cached, width: r.image.width, height: r.image.height, diagnostics: r.diagnostics, timings: r.timings, ...(manifestFile !== undefined ? { manifest: manifestFile } : {}) }, `Wrote ${file} (${String(r.image.width)}×${String(r.image.height)}, frame ${String(frame)}${r.cached ? ', cached' : ''}).${manifestFile !== undefined ? `\nManifest: ${manifestFile}` : ''}`);
          return r.diagnostics.some((d) => d.severity === 'error') ? 1 : 0;
        });
      }
      case 'render': {
        return await withEnv(async (loaded, env) => {
          const pre = checkProject(env, loaded.project).filter((d) => d.severity === 'error');
          if (pre.length > 0) {
            if (json) out({ ok: false, diagnostics: pre }, '');
            else printDiagnostics(io, pre);
            return 1;
          }
          const fromProfile = values.profile !== undefined ? profileById(loaded.project, values.profile) : undefined;
          if (values.profile !== undefined && fromProfile === undefined) throw new UsageError(`Render profile "${values.profile}" does not exist in project.renderProfiles.`);
          const width = num(values.width, 'width');
          const height = num(values.height, 'height');
          const fps = num(values.fps, 'fps');
          const quality = num(values.quality, 'quality');
          const profile: OutputProfile = {
            ...(fromProfile ?? { format: 'mp4' }),
            ...(values.format !== undefined ? { format: values.format } : {}),
            ...(values.codec !== undefined ? { codec: values.codec } : {}),
            ...(width !== undefined ? { width } : {}),
            ...(height !== undefined ? { height } : {}),
            ...(fps !== undefined ? { fps } : {}),
            ...(quality !== undefined ? { quality } : {}),
            ...(values.alpha === true ? { alpha: true } : {}),
          };
          const comp = findComposition(loaded.project, values.composition);
          const ext = profile.format.endsWith('-sequence') ? '' : `.${profile.format}`;
          const outPath = resolve(io.cwd, values.out ?? join(loaded.dir, 'out', `${String(comp['id'])}${ext}`));
          const range = values.start !== undefined || values.end !== undefined ? { start: values.start !== undefined ? frameOf(loaded.project, values.composition, values.start) : 0, end: values.end !== undefined ? frameOf(loaded.project, values.composition, values.end) : compositionDurationFrames(comp) } : undefined;
          let last = '';
          // Standard: mehrere Worker-Prozesse nach Kernen und Speicher (Story 18.7); `--workers 1` rendert im Prozess.
          const workers = Math.max(1, Math.floor(num(values.workers, 'workers') ?? workersFromEnv(io.env) ?? defaultWorkerCount()));
          // `--isolation docker` (Story 21.3): Chunks in Containern, optional mit GPU-Quota (`--gpus`).
          const isolationChoice = renderIsolationOption();
          const runChunks =
            isolationChoice.renderIsolation === 'docker'
              ? dockerRunner(env, loaded.project, workers, dockerSettingsFromEnv(io.env, isolationChoice.docker ?? {}))
              : workers > 1
                ? processRunner(env, loaded.project, workers, trusted)
                : undefined;
          const r = await renderVideo(env, loaded.project, {
            ...(runChunks !== undefined ? { runChunks, localRenderProcesses: isolationChoice.renderIsolation === 'docker' ? 0 : workers } : {}),
            // Encoder-Threads nach freien Kernen (Story 18.6) und Cache-Budget (Story 18.9) aus der Umgebung des Aufrufs.
            encoderThreads: encoderThreadsFor(workers, io.env),
            ...cacheBudget(io.env),
            ...(values.composition !== undefined ? { compositionId: values.composition } : {}),
            outPath,
            profile,
            ...(range !== undefined ? { range } : {}),
            onProgress: (p) => {
              if (json) return;
              const line = `${p.stage} ${String(p.done)}/${String(p.total)}`;
              if (line !== last && (p.done === p.total || p.done % 10 === 0)) io.stderr(`\r${line}   `);
              last = line;
            },
          });
          if (!json) io.stderr('\n');
          out({ outputs: r.outputs, manifest: r.manifestPath, frames: r.manifest.frames.count, framesRendered: r.manifest.cache.framesRendered, framesFromCache: r.manifest.cache.framesFromCache, diagnostics: r.diagnostics }, `Wrote ${r.outputs.join(', ')}\nManifest: ${r.manifestPath}\nFrames: ${String(r.manifest.frames.count)} (${String(r.manifest.cache.framesFromCache)} from cache)`);
          return 0;
        });
      }
      case 'inspect': {
        return await withEnv(async (loaded, env) => {
          if (values.timeline === true) {
            const t = inspectTimeline(loaded.project, values.composition);
            out(t, [`Composition ${t.compositionId}: ${String(t.durationFrames)} frames (${t.durationSmpte}) at ${String(t.fps)} fps`, ...t.markers.map((m) => `  marker ${m.id} @ ${m.smpte}`), ...t.nodes.map((n) => `${'  '.repeat(n.depth + 1)}${n.type} ${n.id} [${String(n.start)}–${String(n.end)})${n.animated.length > 0 ? ` animates ${n.animated.map((a) => a.property).join(', ')}` : ''}`)].join('\n'));
            return 0;
          }
          if (values.frame !== undefined) {
            const { evaluateScene, computeBounds } = await import('@agentic-video/core');
            const frame = frameOf(loaded.project, values.composition, values.frame);
            await env.prepare?.(loaded.project);
            const scene = evaluateScene(loaded.project, values.composition, frame, { registry: env.registry });
            const bounds = computeBounds(scene, env.measurer);
            out({ frame, tree: sceneTree(scene, bounds) }, describeScene(scene, bounds));
            return 0;
          }
          const comps = Array.isArray(loaded.project['compositions']) ? loaded.project['compositions'].filter(isRecord) : [];
          const summary = { dir: loaded.dir, entry: loaded.entry, compositions: comps.map((c) => ({ id: c['id'], width: c['width'], height: c['height'], fps: c['fps'], durationFrames: compositionDurationFrames(c) })), assets: env.assets.all().map((a) => ({ id: a.id, type: a.type, hash: a.hash, dimensions: a.dimensions, duration: a.duration })), fonts: [...new Set(env.fonts.all().map((f) => f.family))], backends: [...env.registry.backends.keys()] };
          out(summary, [`Project ${loaded.dir} (${loaded.entry})`, ...summary.compositions.map((c) => `  composition ${String(c.id)}: ${String(c.width)}×${String(c.height)} @ ${String(c.fps)} fps, ${String(c.durationFrames)} frames`), `  assets: ${String(summary.assets.length)}, fonts: ${summary.fonts.join(', ')}`, `  backends: ${summary.backends.join(', ')}`].join('\n'));
          return 0;
        });
      }
      case 'op':
      case 'patch':
      case 'contact-sheet':
      case 'import': {
        if (command === 'op' && values.list === true) {
          const ops = [...OPERATIONS.values()];
          out(ops.map((o) => ({ name: o.name, summary: o.summary, job: o.job === true, example: o.example.input })), ops.map((o) => `${o.name.padEnd(24)} ${o.summary}`).join('\n'));
          return 0;
        }
        // Projektkontext: --project, sonst bei Kurzbefehlen der Pfad, bei `op` der aktuelle Ordner, falls er ein Projekt ist.
        const importFile = command === 'import' ? rest[0] : undefined;
        const pathArg = command === 'op' ? undefined : command === 'import' ? rest[1] : rest[0];
        const projectArg = values.project ?? (command === 'op' ? (values.workspace === undefined && isProjectDir(io.cwd) ? '.' : undefined) : (pathArg ?? '.'));
        const context = await projectContext({ project: projectArg, workspace: values.workspace, cwd: io.cwd, env: io.env });
        const base = await localServices({ workspaceDir: context.workspaceDir, isolation, sources, allowOutsidePaths: trusted, env: io.env, ...offline, ...renderIsolationOption() });
        const services: LocalServices = { ...base, projectRoots: projectRootsOf(context.projectDir !== undefined ? [context.projectDir] : [], io.env, io.cwd) };
        try {
          const projectId = await context.link(services);
          let name: string;
          let input: unknown;
          if (command === 'op') {
            if (rest[0] === undefined) throw new UsageError('Usage: openvideo op <operation> [--input <json|@file>] [--project <dir>]  (openvideo op --list)');
            name = rest[0];
            input = withDefaults(name, await parseInputArg(values.input, io.cwd), projectId);
          } else if (command === 'patch') {
            if (values.input === undefined) throw new UsageError('Usage: openvideo patch [path] --input <json|@file>  (a patch list, or { "patches": [...] })');
            const raw = await parseInputArg(values.input, io.cwd);
            name = 'composition.patch';
            input = withDefaults(name, { ...(Array.isArray(raw) ? { patches: raw } : isRecord(raw) ? raw : {}), ...(values['dry-run'] === true ? { dryRun: true } : {}) }, projectId);
          } else if (command === 'contact-sheet') {
            const count = num(values.count, 'count');
            name = 'preview.contactSheet';
            input = withDefaults(name, { ...(values.frames !== undefined ? { frames: values.frames.split(',').map((f) => (/^[0-9]+$/u.test(f.trim()) ? Number(f.trim()) : f.trim())) } : {}), ...(count !== undefined ? { count } : {}), ...(values.composition !== undefined ? { compositionId: values.composition } : {}) }, projectId);
          } else {
            if (importFile === undefined) throw new UsageError('Usage: openvideo import <file> [path] [--format svg|lottie|gltf|html|anime|motion-canvas] [--id-prefix logo] [--dry-run]');
            name = 'project.import';
            const parts = await importInput(resolve(io.cwd, importFile), context.projectDir ?? io.cwd, { format: values.format, idPrefix: values['id-prefix'] });
            input = withDefaults(name, { ...parts, ...(values['dry-run'] === true ? { dryRun: true } : {}), ...(values.composition !== undefined ? { compositionId: values.composition } : {}) }, projectId);
          }
          const r: InvocationResult = await runOperation(services, name, input);
          if (!r.ok) throw new OpenVideoError(r.error);
          const result = r.result;
          // Kontaktbogen: auf Wunsch an einen eigenen Ort kopieren.
          if (command === 'contact-sheet' && values.out !== undefined && isRecord(result) && isRecord(result['image']) && typeof result['image']['file'] === 'string') {
            const target = resolve(io.cwd, values.out);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, await readFile(result['image']['file']));
            result['image'] = { ...result['image'], file: target };
          }
          // Kurzmanifest des Kontaktbogens (Story 21.5) neben das Bild schreiben.
          if (command === 'contact-sheet' && values.manifest === true && isRecord(result) && isRecord(result['manifest']) && isRecord(result['image']) && typeof result['image']['file'] === 'string') {
            const manifestFile = `${result['image']['file']}.manifest.json`;
            await writeFile(manifestFile, `${JSON.stringify(result['manifest'], null, 2)}\n`);
            result['manifestFile'] = manifestFile;
          }
          const diagnostics = isRecord(result) && Array.isArray(result['diagnostics']) ? result['diagnostics'].filter((d): d is Diagnostic => isRecord(d) && typeof d['code'] === 'string' && typeof d['problem'] === 'string') : [];
          if (!json && command !== 'op') printDiagnostics(io, diagnostics.filter((d) => d.severity !== 'info'));
          io.stdout(`${JSON.stringify(result, null, 2)}\n`);
          return resultFailed(result) ? 1 : 0;
        } finally {
          await services.dispose();
        }
      }
      case 'doctor': {
        const checks = await runDoctor({ projectDir: io.cwd });
        const failed = checks.filter((c) => c.status === 'fail').length;
        out({ ok: failed === 0, checks }, checks.map((c) => `${c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗'} ${c.name.padEnd(18)} ${c.detail}${c.fix !== undefined ? `\n    → ${c.fix}` : ''}`).join('\n'));
        return failed === 0 ? 0 : 1;
      }
      case 'cache': {
        const sub = rest[0] ?? 'stats';
        const projectDir = resolve(io.cwd, rest[1] ?? '.');
        const cache = createCache(storeFromEnv(io.env, projectDir));
        // Alte Ebenen (font, geometry, shader, composition) nur für `clear` (ADR 0021).
        const named = values.tier !== undefined ? cacheTierByName(values.tier) : undefined;
        const tier = CACHE_TIERS.find((t): t is CacheTierName => t === named);
        if (values.tier !== undefined && (named === undefined || (tier === undefined && sub !== 'clear'))) {
          throw new UsageError(`Unknown tier "${values.tier}". Use: ${CACHE_TIERS.join(', ')}${sub === 'clear' ? ` (clear also accepts the retired tiers ${LEGACY_CACHE_TIERS.join(', ')})` : ''}.`);
        }
        if (sub === 'stats') {
          const usage = await cache.usage();
          out(usage, CACHE_TIERS.map((t) => `${t.padEnd(12)} ${String(usage[t].entries).padStart(7)} entries ${(usage[t].bytes / 1e6).toFixed(1).padStart(10)} MB`).join('\n'));
          return 0;
        }
        if (sub === 'clear') {
          const r = await clearCache(cache, named);
          out(r, `Removed ${String(r.removed)} entries${r.legacyRemoved > 0 ? ` (${String(r.legacyRemoved)} from retired tiers ${LEGACY_CACHE_TIERS.join(', ')})` : ''}.`);
          return 0;
        }
        if (sub === 'prune') {
          const max = num(values['max-bytes'], 'max-bytes');
          if (max === undefined) throw new UsageError('Usage: openvideo cache prune --max-bytes <bytes>');
          const removed = await cache.prune(max);
          out({ removed }, `Removed ${String(removed)} least recently used entries.`);
          return 0;
        }
        throw new UsageError('Usage: openvideo cache <stats|clear|prune>');
      }
      case 'fonts': {
        const sub = rest[0] === 'list' || rest[0] === 'check' ? rest[0] : 'list';
        const path = resolve(io.cwd, rest[0] === 'list' || rest[0] === 'check' ? (rest[1] ?? '.') : (rest[0] ?? '.'));
        const loaded = existsSync(join(path, 'openvideo.json')) || existsSync(join(path, 'project.json')) ? await loadProject(path, { sources }) : undefined;
        const { loadFontSet } = await import('@agentic-video/fonts');
        const fonts = await loadFontSet({ projectDir: loaded?.dir ?? path, ...(loaded !== undefined && Array.isArray(loaded.project['fonts']) ? { fonts: loaded.project['fonts'].filter(isRecord).map((f) => ({ family: String(f['family']), ...(typeof f['src'] === 'string' ? { src: f['src'] } : {}) })) } : {}) });
        if (sub === 'check') {
          if (loaded === undefined) throw new UsageError('Usage: openvideo fonts check <project>');
          const diagnostics = await withEnv((l, env) => Promise.resolve(checkProject(env, l.project).filter((d) => d.code.startsWith('OV_FONT'))));
          if (!json) printDiagnostics(io, diagnostics);
          out({ ok: diagnostics.length === 0, diagnostics }, diagnostics.length === 0 ? 'All fonts are available.' : `${String(diagnostics.length)} problem(s).`);
          return diagnostics.some((d) => d.severity === 'error') ? 1 : 0;
        }
        out(
          fonts.all().map((f) => ({ family: f.family, weight: f.weight, style: f.style, variable: f.variable, hash: f.hash })),
          fonts.all().map((f) => `${f.family.padEnd(24)} ${String(f.weight).padEnd(10)} ${f.style.padEnd(7)} ${f.variable ? 'variable' : ''}`).join('\n'),
        );
        return 0;
      }
      case 'assets': {
        const sub = rest[0] ?? 'list';
        const projectPath = resolve(io.cwd, sub === 'import' || sub === 'inspect' ? (rest[2] ?? '.') : (rest[1] ?? '.'));
        const services = await localServices({ workspaceDir: join(projectPath, '.openvideo', 'workspace'), isolation, sources, allowOutsidePaths: trusted, env: io.env, ...offline });
        try {
          const loaded = await loadProject(projectPath, { sources });
          if (sub === 'import') {
            if (rest[1] === undefined) throw new UsageError('Usage: openvideo assets import <file> [project]');
            const asset = await services.assets?.import(loaded.dir, { path: resolve(io.cwd, rest[1]), ...(values.id !== undefined ? { id: values.id } : {}) });
            if (asset === undefined) return 1;
            const list = Array.isArray(loaded.project['assets']) ? loaded.project['assets'].filter(isRecord).filter((a) => a['id'] !== asset.id) : [];
            const project = { ...loaded.project, assets: [...list, { id: asset.id, type: asset.type, src: asset.src, hash: asset.hash }] };
            await writeFile(join(loaded.dir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
            out(asset, `Imported ${asset.id} (${asset.type}) → ${asset.src}`);
            return 0;
          }
          if (sub === 'inspect') {
            if (rest[1] === undefined) throw new UsageError('Usage: openvideo assets inspect <id> [project]');
            const info = await services.assets?.inspect(loaded.dir, loaded.project, rest[1]);
            out(info, JSON.stringify(info, null, 2));
            return 0;
          }
          const all = await services.withEnvironment(loaded.dir, loaded.project, (env) => Promise.resolve(env.assets.all()));
          out(all, all.map((a) => `${a.id.padEnd(20)} ${a.type.padEnd(9)} ${a.src}`).join('\n') || 'No assets.');
          return 0;
        } finally {
          await services.dispose();
        }
      }
      case 'migrate': {
        if (rest[0] === undefined) throw new UsageError('Usage: openvideo migrate <file> [--write]');
        const file = resolve(io.cwd, rest[0]);
        const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
        const r = migrateProject(raw);
        if (values.write === true && r.diagnostics.every((d) => d.severity !== 'error')) await writeFile(file, `${JSON.stringify(r.project, null, 2)}\n`);
        if (!json) printDiagnostics(io, r.diagnostics);
        out({ from: r.from, to: r.to, diagnostics: r.diagnostics }, `Schema ${r.from} → ${r.to}${values.write === true ? ' (written)' : ' (use --write to save)'}`);
        return r.diagnostics.some((d) => d.severity === 'error') ? 1 : 0;
      }
      case 'serve': {
        const context = await projectContext({ project: values.project, workspace: values.workspace, cwd: io.cwd, env: io.env });
        const base = await localServices({ workspaceDir: context.workspaceDir, isolation, sources, env: io.env, ...offline, ...workersOption, ...renderIsolationOption() });
        const services: LocalServices = { ...base, projectRoots: projectRootsOf(context.projectDir !== undefined ? [context.projectDir] : [], io.env, io.cwd) };
        const projectId = await context.link(services);
        return await runServer(services, io, { port: num(values.port, 'port') ?? 7788, host: values.host ?? '127.0.0.1', token: values.token ?? io.env['OPENVIDEO_API_TOKEN'], allowedHosts: allowedHostsOf(values['allowed-host'], io.env), trustProxy: trustProxyOf(values['trust-proxy'], io.env), ...(projectId !== undefined ? { projectId } : {}), open: values.open === true && values['no-open'] !== true });
      }
      case 'dev':
      case 'studio': {
        const loaded = await loadProject(target, { sources });
        const { workspaceDir, projectId } = await singleProjectWorkspace(loaded.dir);
        // Der eingebundene Projektordner bleibt nur für diesen Host erreichbar (Review M3).
        const services: LocalServices = { ...(await localServices({ workspaceDir, isolation, sources, env: io.env, ...offline, ...workersOption, ...renderIsolationOption() })), hostProjectDirs: [loaded.dir] };
        // dev/studio schützen die API immer mit einem Token; ohne Vorgabe ein zufälliges (B1).
        const given = values.token ?? io.env['OPENVIDEO_API_TOKEN'];
        const token = given !== undefined && given !== '' ? given : randomBytes(32).toString('base64url');
        // Story 20.1: Watcher auf src/** und project.json; der Browser öffnet sich, außer mit --no-open.
        return await runServer(services, io, {
          port: num(values.port, 'port') ?? 7788,
          host: values.host ?? '127.0.0.1',
          token,
          allowedHosts: allowedHostsOf(values['allowed-host'], io.env),
          trustProxy: trustProxyOf(values['trust-proxy'], io.env),
          projectId,
          showToken: true,
          open: values['no-open'] !== true,
          watch: { dir: loaded.dir, entry: loaded.entry, sources },
        });
      }
      case 'mcp': {
        const context = await projectContext({ project: values.project, workspace: values.workspace, cwd: io.cwd, env: io.env });
        const base = await localServices({ workspaceDir: context.workspaceDir, isolation, sources, env: io.env, ...offline, ...workersOption, ...renderIsolationOption(), telemetry: (await import('@agentic-video/telemetry')).createTelemetry({ serviceName: 'openvideo-mcp', exporter: 'none', logSink: (l) => { io.stderr(`${l}\n`); } }) });
        const services: LocalServices = { ...base, projectRoots: projectRootsOf(context.projectDir !== undefined ? [context.projectDir] : [], io.env, io.cwd) };
        const projectId = await context.link(services);
        const { serveStdio } = await import('@agentic-video/mcp');
        await serveStdio(services, projectId !== undefined ? { projectId } : {});
        await stdinClosed(process.stdin);
        await services.dispose();
        return 0;
      }
      default:
        throw new UsageError(`Unknown command "${command}".`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n\nRun "${CLI_NAME} --help" for usage.\n`);
      return 2;
    }
    if (error instanceof OpenVideoError) {
      if (json) io.stdout(`${JSON.stringify({ ok: false, error: error.diagnostic }, null, 2)}\n`);
      else io.stderr(`${formatDiagnostic(error.diagnostic)}\n`);
      return 1;
    }
    throw error;
  }
}

/** TSX-Quelle für `openvideo create --tsx`. */
export function helloSource(name: string): string {
  const title = name.charAt(0).toUpperCase() + name.slice(1);
  return `import { composition, Scene, Ellipse, Text, keyframes } from '@agentic-video/sdk';

// Eine Composition ist Daten: JSX beschreibt Nodes, Animationen sind Werte.
export default composition({
  id: 'main',
  width: 1920,
  height: 1080,
  fps: 30,
  duration: '5s',
  scene: (
    <Scene background="#0B0D12">
      <Ellipse
        id="glow"
        x={660}
        y={240}
        width={600}
        height={600}
        fill={{ type: 'radial', stops: [{ offset: 0, color: '#FF5A1F66' }, { offset: 1, color: '#FF5A1F00' }] }}
      />
      <Text
        id="headline"
        text="${title.replace(/"/gu, '')}"
        fontSize={120}
        fontWeight={800}
        x={96}
        width={1728}
        textAlign="center"
        y={440}
        fill="#F5F7FF"
        textAnimation={{ unit: 'char', stagger: 2, duration: 18, from: { opacity: 0, y: 40 } }}
      />
      <Text
        id="subline"
        text="Made with OpenVideo"
        fontSize={40}
        x={96}
        width={1728}
        textAlign="center"
        y={600}
        fill="#FF5A1F"
        opacity={keyframes([{ t: '0.8s', v: 0 }, { t: '1.4s', v: 1, ease: 'easeOutCubic' }])}
      />
    </Scene>
  ),
});
`;
}


/** Startet `openvideo-bench` in einem eigenen Prozess und reicht Ausgabe und Exit-Code durch. */
async function runBenchmark(args: readonly string[], io: CliIo): Promise<number> {
  const bin = fileURLToPath(new URL('bin.js', import.meta.resolve('@agentic-video/benchmarks')));
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [bin, ...args], { cwd: io.cwd, env: { ...io.env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk: Buffer) => {
    io.stdout(chunk.toString());
  });
  child.stderr.on('data', (chunk: Buffer) => {
    io.stderr(chunk.toString());
  });
  return new Promise<number>((resolveExit) => {
    child.once('error', (error) => {
      io.stderr(`openvideo-bench could not start: ${error.message}\n`);
      resolveExit(1);
    });
    child.once('close', (code) => {
      resolveExit(code ?? 1);
    });
  });
}
