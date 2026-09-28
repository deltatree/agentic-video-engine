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
import { isLoopbackHost, startAgentServer, type AgentServices } from '@agentic-video/agent';
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
import { createTemplateCatalog } from '@agentic-video/templates';
import { checkProject, createNodeEnvironment, describeScene, inspectTimeline, profileById, renderFrame, renderVideo, sceneTree, OPENVIDEO_VERSION, type OutputProfile } from '@agentic-video/render';
import { runDoctor } from './doctor.js';
import { createProjectDir, helloProject, loadProject, singleProjectWorkspace } from './project.js';
import { createLocalServices, htmlScriptsAllowed, processRunner, type LocalServices } from './services.js';
import { createSourceService } from './sources.js';

/** Ein- und Ausgabe der CLI (für Tests austauschbar). */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Beendet `serve`, `dev` und `studio`, sobald das Versprechen erfüllt ist (Tests); sonst SIGINT/SIGTERM. */
  readonly stop?: Promise<void>;
}

class UsageError extends Error {}

const HELP = `${PRODUCT_NAME} ${OPENVIDEO_VERSION} – Video-as-Code for coding agents

Usage: ${CLI_NAME} <command> [options]

Commands:
  create <dir>          Create a project (--tsx for TypeScript/JSX, --template <name>)
  templates             List the project templates
  dev [dir]             Studio with live preview for a project
  studio [dir]          Same as dev
  validate [path]       Validate schema, assets, fonts and backends
  render [path]         Render a video (--format --codec --width --height --fps --out --workers <n>)
  render-frame [path]   Render one frame to PNG (--frame 2s --scale 0.5 --debug bounds,safe)
  inspect [path]        Project summary, scene tree (--frame) or timeline (--timeline)
  doctor                Check the environment and suggest fixes
  benchmark             Run reproducible benchmarks (--scenario --resolution --frames --compare)
  cache <stats|clear|prune>   Manage the cache (--tier frame --max-bytes 1e9)
  fonts [list|check] [path]   List or check fonts
  assets <list|import|inspect> [path]   Manage assets
  serve                 Start the Agent API (HTTP) with the Studio
  mcp                   Start the MCP server on stdio
  migrate <file>        Upgrade an older project file (--write)
  worker                Start a render worker (--stdio or --coordinator <url>)
  coordinator           Start the render coordinator for remote workers (--port --journal)

Server options (serve, dev, studio):
  --host <addr>          Bind address (default 127.0.0.1; others need a token)
  --port <n>             Port (default 7788)
  --token <secret>       Bearer token (or OPENVIDEO_API_TOKEN); dev/studio create one
  --allowed-host <name>  Extra host name for the Host/Origin check (or OPENVIDEO_ALLOWED_HOSTS)
  --workers <n>          Render videos with n local worker processes

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

const MIME: Readonly<Record<string, string>> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' };

interface ServeOptions {
  readonly port: number;
  readonly host: string;
  readonly token?: string | undefined;
  readonly allowedHosts: readonly string[];
  readonly projectId?: string;
  /** Token im Studio-Link ausgeben (dev/studio mit erzeugtem Token). */
  readonly showToken?: boolean;
}

async function serveServices(services: AgentServices, io: CliIo, options: ServeOptions): Promise<void> {
  const studio = studioDir(io.env);
  const server = await startAgentServer({
    services,
    port: options.port,
    host: options.host,
    allowedHosts: options.allowedHosts,
    ...(options.token !== undefined ? { token: options.token } : {}),
    fallback: async (req, res) => {
      if (studio === undefined || req.method !== 'GET') return false;
      const url = new URL(req.url ?? '/', 'http://localhost');
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = resolve(studio, rel);
      if (!file.startsWith(studio + sep) || !existsSync(file)) return false;
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' });
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
  await new Promise<void>((resolveStop) => {
    const stop = () => {
      void server.close().then(resolveStop);
    };
    if (io.stop !== undefined) void io.stop.then(stop);
    else {
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }
  });
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
        workspace: { type: 'string' },
        write: { type: 'boolean' },
        id: { type: 'string' },
        open: { type: 'boolean' },
        offline: { type: 'boolean' },
        stdio: { type: 'boolean' },
        coordinator: { type: 'string' },
        journal: { type: 'string' },
        scenario: { type: 'string' },
        resolution: { type: 'string' },
        frames: { type: 'string' },
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
  const sources = createSourceService({ trusted });
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
  try {
    const serverWorkers = num(values.workers, 'workers');
    const workersOption = serverWorkers !== undefined && serverWorkers > 1 ? { workers: Math.floor(serverWorkers) } : {};
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
        const token = values.token ?? io.env['OPENVIDEO_WORKER_TOKEN'];
        const host = values.host ?? '127.0.0.1';
        const port = num(values.port, 'port') ?? 8080;
        if ((token === undefined || token === '') && !isLoopbackHost(host)) {
          throw new OpenVideoError({ code: 'OV_API_TOKEN_REQUIRED', errorClass: 'SecurityError', problem: `The coordinator would listen on ${host} without a token.`, suggestions: ['Set OPENVIDEO_WORKER_TOKEN or pass --token <secret>.', 'Or bind to 127.0.0.1 for local use.'] });
        }
        const workspaceDir = resolve(io.cwd, values.workspace ?? '.');
        const store = storeFromEnv(io.env, workspaceDir);
        const coordinator = await startCoordinator({ port, host, store, journalDir: resolve(io.cwd, values.journal ?? join(workspaceDir, '.openvideo', 'journal')), ...(token !== undefined && token !== '' ? { token } : {}) });
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
          if (!json) printDiagnostics(io, r.diagnostics.filter((d) => d.severity !== 'info'));
          out({ file, frame, key: r.key, cached: r.cached, width: r.image.width, height: r.image.height, diagnostics: r.diagnostics, timings: r.timings }, `Wrote ${file} (${String(r.image.width)}×${String(r.image.height)}, frame ${String(frame)}${r.cached ? ', cached' : ''}).`);
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
          const workers = num(values.workers, 'workers');
          const runChunks = workers !== undefined && workers > 1 ? processRunner(env, loaded.project, workers, trusted) : undefined;
          const r = await renderVideo(env, loaded.project, {
            ...(runChunks !== undefined ? { runChunks } : {}),
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
        const tier = values.tier !== undefined ? CACHE_TIERS.find((t): t is CacheTierName => t === values.tier) : undefined;
        if (values.tier !== undefined && tier === undefined) throw new UsageError(`Unknown tier "${values.tier}". Use: ${CACHE_TIERS.join(', ')}.`);
        if (sub === 'stats') {
          const usage = await cache.usage();
          out(usage, CACHE_TIERS.map((t) => `${t.padEnd(12)} ${String(usage[t].entries).padStart(7)} entries ${(usage[t].bytes / 1e6).toFixed(1).padStart(10)} MB`).join('\n'));
          return 0;
        }
        if (sub === 'clear') {
          const removed = await cache.clear(tier);
          out({ removed }, `Removed ${String(removed)} entries.`);
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
        const services = await createLocalServices({ workspaceDir: join(projectPath, '.openvideo', 'workspace'), isolation, sources, allowOutsidePaths: trusted, env: io.env, ...offline });
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
        const workspaceDir = resolve(io.cwd, values.workspace ?? io.env['OPENVIDEO_WORKSPACE'] ?? '.openvideo-workspace');
        const services = await createLocalServices({ workspaceDir, isolation, sources, env: io.env, ...offline, ...workersOption });
        return await runServer(services, io, { port: num(values.port, 'port') ?? 7788, host: values.host ?? '127.0.0.1', token: values.token ?? io.env['OPENVIDEO_API_TOKEN'], allowedHosts: allowedHostsOf(values['allowed-host'], io.env) });
      }
      case 'dev':
      case 'studio': {
        const loaded = await loadProject(target, { sources });
        const { workspaceDir, projectId } = await singleProjectWorkspace(loaded.dir);
        const services = await createLocalServices({ workspaceDir, isolation, sources, env: io.env, ...offline, ...workersOption });
        // dev/studio schützen die API immer mit einem Token; ohne Vorgabe ein zufälliges (B1).
        const given = values.token ?? io.env['OPENVIDEO_API_TOKEN'];
        const token = given !== undefined && given !== '' ? given : randomBytes(32).toString('base64url');
        return await runServer(services, io, { port: num(values.port, 'port') ?? 7788, host: values.host ?? '127.0.0.1', token, allowedHosts: allowedHostsOf(values['allowed-host'], io.env), projectId, showToken: true });
      }
      case 'mcp': {
        const workspaceDir = resolve(io.cwd, values.workspace ?? io.env['OPENVIDEO_WORKSPACE'] ?? '.openvideo-workspace');
        const services = await createLocalServices({ workspaceDir, isolation, sources, env: io.env, ...offline, ...workersOption, telemetry: (await import('@agentic-video/telemetry')).createTelemetry({ serviceName: 'openvideo-mcp', exporter: 'none', logSink: (l) => { io.stderr(`${l}\n`); } }) });
        const { serveStdio } = await import('@agentic-video/mcp');
        await serveStdio(services);
        await new Promise<void>((r) => process.stdin.once('close', r));
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
