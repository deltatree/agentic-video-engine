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
import { createNodeEnvironment, type BackendProvider, type ChunkRunner, type NodeEnvironment, type NodeEnvironmentOptions, type RenderEnvironment } from '@agentic-video/render';
import { createProcessChunkRunner } from '@agentic-video/scheduler';
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
  /** Anzahl lokaler Worker-Prozesse für Video-Renders (`--workers`). Ohne Angabe rendert der Server selbst. */
  readonly workers?: number;
  readonly benchmark?: (input: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly maxConcurrentJobs?: number;
  readonly offline?: boolean;
  /**
   * Asset-Pfade außerhalb des Projektordners erlauben. Nur für direkte CLI-Befehle mit `--trusted`,
   * nie für `serve`, `dev`, `studio` oder `mcp` (B6). Standard `false`.
   */
  readonly allowOutsidePaths?: boolean;
  /** Umgebungsvariablen (Standard `process.env`), z. B. `OPENVIDEO_CONTAINER_IMAGE`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Fabrik für Render-Umgebungen (Standard {@link createNodeEnvironment}); Tests ersetzen sie. */
  readonly createEnvironment?: (options: NodeEnvironmentOptions) => Promise<NodeEnvironment>;
}

/**
 * Dürfen HTML-Skripte laufen (ADR 0008)? Nur mit `--trusted` oder im Container
 * (`OPENVIDEO_CONTAINER_IMAGE` gesetzt).
 *
 * @example
 * ```ts
 * htmlScriptsAllowed('container', process.env); // true nur im Container-Image
 * ```
 */
export function htmlScriptsAllowed(isolation: 'container' | 'trusted', env: Readonly<Record<string, string | undefined>>): boolean {
  const image = env['OPENVIDEO_CONTAINER_IMAGE'];
  return isolation === 'trusted' || (image !== undefined && image !== '');
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
  const telemetry = options.telemetry ?? createTelemetry({ serviceName: 'openvideo', exporter: 'none' });
  // Immer storeFromEnv: lokal und mit S3 derselbe Pfad (`<workspace>/.openvideo/cache` oder OPENVIDEO_CACHE_DIR).
  const cache = options.cache ?? createCache(storeFromEnv(options.env ?? process.env, options.workspaceDir));
  const jobs = new JobManager(join(options.workspaceDir, 'jobs'), telemetry, options.maxConcurrentJobs ?? 1);
  await jobs.restore();
  const isolation = options.isolation ?? 'container';
  const allowOutsidePaths = options.allowOutsidePaths === true;
  const allowHtmlScripts = htmlScriptsAllowed(isolation, options.env ?? process.env);
  const create = options.createEnvironment ?? createNodeEnvironment;
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
      : options.workers !== undefined
        ? { chunkRunner: (env: RenderEnvironment, project: Readonly<Record<string, unknown>>) => processRunner(env, project, options.workers ?? 1, isolation === 'trusted') }
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
 * Chunk-Runner mit lokalen Worker-Prozessen für eine Node-Umgebung (`--workers`).
 *
 * @example
 * ```ts
 * const runChunks = processRunner(env, project, 4, false);
 * ```
 */
export function processRunner(env: RenderEnvironment, project: Readonly<Record<string, unknown>>, workers: number, trusted: boolean): ChunkRunner {
  const projectDir = 'projectDir' in env && typeof env.projectDir === 'string' ? env.projectDir : undefined;
  if (projectDir === undefined) {
    throw new OpenVideoError({ code: 'OV_SCHEDULER_ENV', errorClass: 'SchedulerError', problem: 'Worker processes need a Node render environment with a project directory.', suggestions: ['Create the environment with createNodeEnvironment({ projectDir, project }).'] });
  }
  return createProcessChunkRunner({ concurrency: workers, projectDir, project, cache: env.cache, telemetry: env.telemetry, trusted });
}
