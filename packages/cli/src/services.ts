/**
 * Lokale Verdrahtung der Agent-Dienste (für CLI, `openvideo serve`, Studio und MCP).
 */
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { importAsset, resolveProjectAssets } from '@agentic-video/assets';
import { JobManager, Workspace, type AgentServices, type SourceService, type TemplateCatalog } from '@agentic-video/agent';
import { FileStore, createCache, storeFromEnv, type Cache } from '@agentic-video/cache';
import { OpenVideoError, contentHash, isRecord } from '@agentic-video/core';
import { encodePng } from '@agentic-video/png';
import { createNodeEnvironment, type BackendProvider, type ChunkRunner, type NodeEnvironment, type RenderEnvironment } from '@agentic-video/render';
import { createTelemetry, type Telemetry } from '@agentic-video/telemetry';

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
  readonly benchmark?: (input: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly maxConcurrentJobs?: number;
  readonly offline?: boolean;
}

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
  const cache = options.cache ?? createCache(process.env['OPENVIDEO_S3_ENDPOINT'] !== undefined ? storeFromEnv(process.env, options.workspaceDir) : new FileStore(join(options.workspaceDir, 'cache')));
  const jobs = new JobManager(join(options.workspaceDir, 'jobs'), telemetry, options.maxConcurrentJobs ?? 1);
  await jobs.restore();
  const envs = new Map<string, Promise<NodeEnvironment>>();
  const order: string[] = [];
  const isolation = options.isolation ?? 'container';

  const environment = (projectDir: string, project: Readonly<Record<string, unknown>>): Promise<RenderEnvironment> => {
    const key = `${projectDir}|${contentHash({ assets: project['assets'] ?? [], fonts: project['fonts'] ?? [], settings: project['settings'] ?? {} })}`;
    let hit = envs.get(key);
    if (hit === undefined) {
      hit = createNodeEnvironment({
        projectDir,
        project,
        cache,
        telemetry,
        trusted: isolation === 'trusted',
        ...(options.offline !== undefined ? { offline: options.offline } : {}),
        ...(options.providers !== undefined ? { providers: options.providers() } : {}),
      });
      envs.set(key, hit);
      order.push(key);
      while (order.length > 4) {
        const old = order.shift();
        if (old === undefined) break;
        const env = envs.get(old);
        envs.delete(old);
        if (env !== undefined) void env.then((e) => e.dispose());
      }
    }
    return hit;
  };

  return {
    workspace: new Workspace(options.workspaceDir),
    jobs,
    telemetry,
    isolation,
    environment,
    encodePng: (image) => encodePng(image),
    ...(options.templates !== undefined ? { templates: options.templates } : {}),
    ...(options.sources !== undefined ? { sources: options.sources } : {}),
    ...(options.chunkRunner !== undefined ? { chunkRunner: options.chunkRunner } : {}),
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
          { cache, allowOutsidePaths: isolation === 'trusted' },
        );
        return r;
      },
      async inspect(projectDir, project, assetId) {
        const resolved = await resolveProjectAssets(projectDir, project, { cache, allowOutsidePaths: isolation === 'trusted' });
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
      for (const env of envs.values()) await (await env).dispose();
      envs.clear();
      await telemetry.shutdown();
    },
  };
}
