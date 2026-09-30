/**
 * Lokale Verdrahtung der Agent-Dienste (für CLI, `openvideo serve`, Studio und MCP).
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { importAsset, resolveProjectAssets } from '@agentic-video/assets';
import { JobManager, Workspace, type AgentServices, type SourceService, type TemplateCatalog } from '@agentic-video/agent';
import { createCache, storeFromEnv, type Cache } from '@agentic-video/cache';
import { OpenVideoError, contentHash, isRecord } from '@agentic-video/core';
import { encodePng } from '@agentic-video/png';
import { createNodeEnvironment, renderChunk, type BackendProvider, type ChunkResult, type ChunkRunner, type NodeEnvironment, type NodeEnvironmentOptions, type RenderEnvironment } from '@agentic-video/render';
import { createProcessChunkRunner, createRemoteChunkRunner, defaultWorkerCount } from '@agentic-video/scheduler';
import { createTelemetry, type Telemetry } from '@agentic-video/telemetry';
import { createTemplateCatalog } from '@agentic-video/templates';

/** Optionen für {@link createLocalServices}. */
export interface LocalServicesOptions {
  /** Workspace-Ordner (Projekte, Jobs). */
  readonly workspaceDir: string;
  /** `trusted` erlaubt Agent-Code auf dem Host (`--trusted`). Standard `container`. */
  readonly isolation?: 'container' | 'trusted';
  readonly telemetry?: Telemetry;
  readonly cache?: Cache;
  readonly templates?: TemplateCatalog;
  readonly sources?: SourceService;
  /** Backends mit eigenem Prozess (Browser, Blender). */
  readonly providers?: () => readonly BackendProvider[];
  readonly chunkRunner?: (env: RenderEnvironment, project: Readonly<Record<string, unknown>>) => ChunkRunner;
  /**
   * Anzahl lokaler Worker-Prozesse für Video-Renders (`--workers`). `1` rendert im Server-Prozess.
   * Ohne Angabe: {@link defaultWorkerCount} (Kerne und Speicher, Story 18.7).
   */
  readonly workers?: number;
  readonly benchmark?: (input: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly maxConcurrentJobs?: number;
  readonly offline?: boolean;
  /**
   * Asset-Pfade außerhalb des Projektordners erlauben. Nur für direkte CLI-Befehle mit `--trusted`,
   * nie für `serve`, `dev`, `studio` oder `mcp` (B6). Standard `false`.
   */
  readonly allowOutsidePaths?: boolean;
  /** Umgebungsvariablen (Standard `process.env`), z. B. `OPENVIDEO_ALLOW_HTML_SCRIPTS`, `OPENVIDEO_COORDINATOR_URL`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Fabrik für Render-Umgebungen (Standard {@link createNodeEnvironment}); Tests ersetzen sie. */
  readonly createEnvironment?: (options: NodeEnvironmentOptions) => Promise<NodeEnvironment>;
}

/**
 * Dürfen HTML-Skripte laufen (ADR 0008, Story 16.1)? Nur ausdrücklich: mit `--trusted` oder
 * `OPENVIDEO_ALLOW_HTML_SCRIPTS=1`. `OPENVIDEO_CONTAINER_IMAGE` erlaubt nichts mehr (H1): die
 * Variable steht in jedem Image, auch im API-Pod. Auch mit Erlaubnis laufen Skripte nur, wenn
 * Chromium mit der OS-Sandbox startet; sonst bricht der Browser-Host mit `OV_BROWSER_NO_OS_SANDBOX` ab.
 *
 * @example
 * ```ts
 * htmlScriptsAllowed('container', { OPENVIDEO_ALLOW_HTML_SCRIPTS: '1' }); // true
 * htmlScriptsAllowed('container', { OPENVIDEO_CONTAINER_IMAGE: 'ghcr.io/x/openvideo-render-cpu:1' }); // false
 * ```
 */
export function htmlScriptsAllowed(isolation: 'container' | 'trusted', env: Readonly<Record<string, string | undefined>>): boolean {
  return isolation === 'trusted' || env['OPENVIDEO_ALLOW_HTML_SCRIPTS'] === '1';
}

/** Eine zwischengespeicherte Umgebung mit Referenzzähler. */
interface EnvEntry {
  readonly promise: Promise<NodeEnvironment>;
  refs: number;
}

/** Höchstzahl ungenutzter Umgebungen im LRU. */
const MAX_IDLE_ENVIRONMENTS = 4;

/** Dienste mit Aufräumfunktion. */
export interface LocalServices extends AgentServices {
  dispose(): Promise<void>;
}

/**
 * Baut die Agent-Dienste für einen lokalen Workspace.
 * Render-Umgebungen werden je Projekt und Asset-/Font-Stand wiederverwendet.
 *
 * @example
 * ```ts
 * const services = await createLocalServices({ workspaceDir: '.openvideo-workspace' });
 * await startAgentServer({ services });
 * ```
 */
export async function createLocalServices(options: LocalServicesOptions): Promise<LocalServices> {
  mkdirSync(options.workspaceDir, { recursive: true });
  const telemetry = options.telemetry ?? telemetryFromEnv(options.env ?? process.env);
  // Immer storeFromEnv: lokal und mit S3 derselbe Pfad (`<workspace>/.openvideo/cache` oder OPENVIDEO_CACHE_DIR).
  const cache = options.cache ?? createCache(storeFromEnv(options.env ?? process.env, options.workspaceDir));
  const jobs = new JobManager(join(options.workspaceDir, 'jobs'), telemetry, options.maxConcurrentJobs ?? 1);
  await jobs.restore();
  const isolation = options.isolation ?? 'container';
  const allowOutsidePaths = options.allowOutsidePaths === true;
  const allowHtmlScripts = htmlScriptsAllowed(isolation, options.env ?? process.env);
  // Im Cluster rendern die Worker am Koordinator; der Cache muss dann der gemeinsame S3-Speicher sein.
  const coordinatorUrl = nonEmpty((options.env ?? process.env)['OPENVIDEO_COORDINATOR_URL']);
  // Rolle `submit` (Story 16.3); ein gemeinsames Token (`openvideo coordinator --token`) bleibt als Rückfall.
  const coordinatorToken = nonEmpty((options.env ?? process.env)['OPENVIDEO_SUBMIT_TOKEN']) ?? nonEmpty((options.env ?? process.env)['OPENVIDEO_WORKER_TOKEN']);
  const create = options.createEnvironment ?? createNodeEnvironment;
  // Lokale Worker (Story 18.7): `--workers`, sonst `OPENVIDEO_WORKERS`, sonst nach Kernen und Speicher.
  const localWorkers = options.workers ?? workersFromEnv(options.env ?? process.env) ?? defaultWorkerCount();
  // LRU mit Referenzzählung (B14): Die Map-Reihenfolge ist die Nutzungsreihenfolge.
  const envs = new Map<string, EnvEntry>();

  const disposeEntry = async (key: string, entry: EnvEntry): Promise<void> => {
    try {
      await (await entry.promise).dispose();
    } catch (error) {
      telemetry.logger.warn('render environment dispose failed', { environment: key, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const evictIdle = (): void => {
    let idle = 0;
    for (const e of envs.values()) if (e.refs === 0) idle++;
    for (const [key, entry] of envs) {
      if (idle <= MAX_IDLE_ENVIRONMENTS) break;
      if (entry.refs > 0) continue;
      envs.delete(key);
      idle--;
      void disposeEntry(key, entry);
    }
  };

  const withEnvironment = async <T>(projectDir: string, project: Readonly<Record<string, unknown>>, fn: (env: RenderEnvironment) => Promise<T>): Promise<T> => {
    const key = `${projectDir}|${contentHash({ assets: project['assets'] ?? [], fonts: project['fonts'] ?? [], settings: project['settings'] ?? {} })}`;
    let entry = envs.get(key);
    if (entry === undefined) {
      const promise = create({
        projectDir,
        project,
        cache,
        telemetry,
        trusted: isolation === 'trusted',
        allowHtmlScripts,
        ...(options.offline !== undefined ? { offline: options.offline } : {}),
        ...(options.providers !== undefined ? { providers: options.providers() } : {}),
      });
      entry = { promise, refs: 0 };
      envs.set(key, entry);
    } else {
      envs.delete(key);
      envs.set(key, entry);
    }
    entry.refs++;
    const current = entry;
    try {
      let env: NodeEnvironment;
      try {
        env = await current.promise;
      } catch (error) {
        // Eine abgelehnte Umgebung bleibt nicht im Cache; der nächste Aufruf versucht es neu.
        if (envs.get(key) === current) envs.delete(key);
        throw error;
      }
      return await fn(env);
    } finally {
      current.refs--;
      evictIdle();
    }
  };

  return {
    workspace: new Workspace(options.workspaceDir),
    jobs,
    telemetry,
    isolation,
    withEnvironment,
    encodePng: (image) => encodePng(image),
    templates: options.templates ?? createTemplateCatalog(),
    ...(options.sources !== undefined ? { sources: options.sources } : {}),
    ...(options.chunkRunner !== undefined
      ? { chunkRunner: options.chunkRunner }
      : coordinatorUrl !== undefined
        ? { chunkRunner: (env: RenderEnvironment, project: Readonly<Record<string, unknown>>) => remoteRunner(env, project, coordinatorUrl, coordinatorToken) }
        : localWorkers > 1
        ? { chunkRunner: (env: RenderEnvironment, project: Readonly<Record<string, unknown>>) => processRunner(env, project, localWorkers, isolation === 'trusted') }
        : {}),
    ...(options.benchmark !== undefined ? { benchmark: options.benchmark } : {}),
    assets: {
      async import(projectDir, input) {
        const r = await importAsset(
          projectDir,
          {
            ...(input.path !== undefined ? { path: input.path } : {}),
            ...(input.url !== undefined ? { url: input.url } : {}),
            ...(input.base64 !== undefined ? { base64: input.base64 } : {}),
            ...(input.fileName !== undefined ? { fileName: input.fileName } : {}),
            ...(input.id !== undefined ? { id: input.id } : {}),
            ...(input.type !== undefined ? { type: input.type } : {}),
          },
          { cache, allowOutsidePaths, ...(options.offline !== undefined ? { offline: options.offline } : {}) },
        );
        return r;
      },
      async inspect(projectDir, project, assetId) {
        const resolved = await resolveProjectAssets(projectDir, project, { cache, allowOutsidePaths, ...(options.offline !== undefined ? { offline: options.offline } : {}) });
        try {
          const a = resolved.get(assetId);
          if (a === undefined) {
            const d = resolved.diagnostics.find((x) => x.problem.includes(`"${assetId}"`));
            throw new OpenVideoError(d ?? { code: 'OV_ASSET_UNKNOWN', errorClass: 'AssetError', problem: `Asset "${assetId}" is not declared.`, suggestions: ['Use asset.import.'] });
          }
          return { ...a, metadata: isRecord(a.metadata) ? { ...a.metadata } : {} };
        } finally {
          await resolved.close();
        }
      },
    },
    async dispose() {
      const all = [...envs.entries()];
      envs.clear();
      await Promise.all(all.map(([key, entry]) => disposeEntry(key, entry)));
      await telemetry.shutdown();
    },
  };
}

/**
 * Telemetrie nach Umgebung: `OPENVIDEO_METRICS` = `prometheus` (Port `OPENVIDEO_METRICS_PORT`, Standard 9464),
 * `otlp` (`OTEL_EXPORTER_OTLP_ENDPOINT`) oder `console`. Ohne Angabe gibt es keinen Export.
 *
 * @example
 * ```ts
 * const telemetry = telemetryFromEnv({ OPENVIDEO_METRICS: 'prometheus' });
 * ```
 */
export function telemetryFromEnv(env: Readonly<Record<string, string | undefined>>): Telemetry {
  const kind = nonEmpty(env['OPENVIDEO_METRICS']) ?? 'none';
  const exporter = (['none', 'console', 'otlp', 'prometheus'] as const).find((k) => k === kind);
  if (exporter === undefined) {
    throw new OpenVideoError({ code: 'OV_TELEMETRY_EXPORTER', errorClass: 'ConfigError', problem: `OPENVIDEO_METRICS="${kind}" is not a known exporter.`, suggestions: ['Use one of: none, console, otlp, prometheus.'] });
  }
  const port = Number(env['OPENVIDEO_METRICS_PORT'] ?? '9464');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new OpenVideoError({ code: 'OV_TELEMETRY_EXPORTER', errorClass: 'ConfigError', problem: `OPENVIDEO_METRICS_PORT="${String(env['OPENVIDEO_METRICS_PORT'])}" is not a TCP port.`, suggestions: ['Set a port between 1 and 65535, e.g. 9464.'] });
  }
  return createTelemetry({ serviceName: 'openvideo', exporter, ...(exporter === 'prometheus' ? { prometheusPort: port } : {}) });
}

/**
 * Worker-Zahl aus `OPENVIDEO_WORKERS` (ganze Zahl ≥ 1), sonst `undefined`. In Containern, deren
 * CPU- oder Speichergrenze Node nicht sieht, legt die Variable die Zahl fest.
 *
 * @example
 * ```ts
 * workersFromEnv({ OPENVIDEO_WORKERS: '2' }); // 2
 * ```
 */
export function workersFromEnv(env: Readonly<Record<string, string | undefined>>): number | undefined {
  const n = Number(env['OPENVIDEO_WORKERS'] ?? '');
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
}

function projectDirOf(env: RenderEnvironment): string {
  const projectDir = 'projectDir' in env && typeof env.projectDir === 'string' ? env.projectDir : undefined;
  if (projectDir === undefined) {
    throw new OpenVideoError({ code: 'OV_SCHEDULER_ENV', errorClass: 'SchedulerError', problem: 'Worker processes need a Node render environment with a project directory.', suggestions: ['Create the environment with createNodeEnvironment({ projectDir, project }).'] });
  }
  return projectDir;
}

/**
 * Chunk-Runner mit Pull-Workern am Koordinator (`OPENVIDEO_COORDINATOR_URL`, Kubernetes).
 * Der Runner prüft die Frames der Worker im Speicher der Umgebung (Präfix und SHA-256, T8).
 *
 * @example
 * ```ts
 * const runChunks = remoteRunner(env, project, 'http://coordinator:8080', process.env.OPENVIDEO_SUBMIT_TOKEN);
 * ```
 */
export function remoteRunner(env: RenderEnvironment, project: Readonly<Record<string, unknown>>, coordinatorUrl: string, token: string | undefined): ChunkRunner {
  return createRemoteChunkRunner({ coordinatorUrl, store: env.cache.store, projectDir: projectDirOf(env), project, telemetry: env.telemetry, ...(token !== undefined ? { token } : {}) });
}

/**
 * Chunk-Runner mit lokalen Worker-Prozessen für eine Node-Umgebung (`--workers`).
 *
 * @example
 * ```ts
 * const runChunks = processRunner(env, project, 4, false);
 * ```
 */
export function processRunner(env: RenderEnvironment, project: Readonly<Record<string, unknown>>, workers: number, trusted: boolean): ChunkRunner {
  // Chunk-Timeout (Story 18.8): hängende Worker nach OPENVIDEO_CHUNK_TIMEOUT_MS beenden, Chunk wiederholen.
  const timeout = Number(process.env['OPENVIDEO_CHUNK_TIMEOUT_MS'] ?? '');
  const pool = createProcessChunkRunner({ concurrency: workers, projectDir: projectDirOf(env), project, cache: env.cache, telemetry: env.telemetry, trusted, ...(Number.isFinite(timeout) && timeout > 0 ? { chunkTimeoutMs: timeout } : {}) });
  // Ein einzelner Chunk lohnt keinen Worker-Start (Node, Skia, Chromium): dann im eigenen Prozess.
  return async (chunks, onDone, run) => {
    if (chunks.length > 1) return pool(chunks, onDone, run);
    const results: ChunkResult[] = [];
    for (const c of chunks) {
      const r = await renderChunk(env, project, c, run?.signal);
      onDone(r);
      results.push(r);
    }
    return results;
  };
}
