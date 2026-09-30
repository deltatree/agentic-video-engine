/**
 * TSX-Quellen: Kompilieren in der Sandbox und AST-Rückschreiben (FR-17, FR-76).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceService } from '@agentic-video/agent';
import { createCache, storeFromEnv, type Cache, type CacheTier } from '@agentic-video/cache';
import { applyPatchesToSource, compileTsx } from '@agentic-video/compiler';
import { observeCacheTelemetry } from '@agentic-video/render';
import type { Telemetry } from '@agentic-video/telemetry';

/** Optionen für {@link createSourceService}. */
export interface SourceServiceOptions {
  /** `true` wertet auf dem Host aus (nur eigene Projekte), sonst in der Docker-Sandbox. */
  readonly trusted: boolean;
  /**
   * Cache-Ebene `compiled` je Projektordner (Story 21.2). Standard: `OPENVIDEO_CACHE_DIR` bzw.
   * `<projekt>/.openvideo/cache` aus `env`. `false` schaltet den Compiler-Cache ab. Eine eigene
   * Ebene meldet ihre Treffer nicht an die Telemetrie; das übernimmt dann der Aufrufer.
   */
  readonly cache?: ((projectDir: string) => CacheTier) | false;
  /** Umgebungsvariablen für den Standard-Cache (Standard `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Telemetrie für Treffer und Fehlgriffe der Ebene `compiled` (`cache_hits`/`cache_misses`,
   * Attribut `tier`, ADR 0021). Später per {@link CliSourceService.useTelemetry} setzbar.
   */
  readonly telemetry?: Telemetry;
}

/** Quellcode-Dienst der CLI: {@link SourceService} plus Anbindung an die Telemetrie. */
export interface CliSourceService extends SourceService {
  /**
   * Meldet Treffer und Fehlgriffe der Ebene `compiled` ab jetzt an `telemetry` (auch für schon
   * angelegte Projekt-Caches). Mehrfacher Aufruf mit derselben Telemetrie zählt nicht doppelt.
   */
  useTelemetry(telemetry: Telemetry): void;
}

/**
 * Quellcode-Dienst für TSX-Projekte. `trusted` wertet auf dem Host aus (nur eigene Projekte).
 * Der Compiler-Output landet in der Cache-Ebene `compiled`; unveränderte Quellen werden nicht
 * erneut in der Sandbox ausgewertet. Treffer und Fehlgriffe gehen an die Telemetrie (Story 21.2).
 *
 * @example
 * ```ts
 * const sources = createSourceService({ trusted: false }); // Docker-Sandbox
 * sources.useTelemetry(services.telemetry);
 * ```
 */
export function createSourceService(options: SourceServiceOptions): CliSourceService {
  const caches = new Map<string, Cache>();
  const telemetries: Telemetry[] = options.telemetry !== undefined ? [options.telemetry] : [];
  const tierFor = (projectDir: string): CacheTier | undefined => {
    if (options.cache === false) return undefined;
    if (options.cache !== undefined) return options.cache(projectDir);
    let cache = caches.get(projectDir);
    if (cache === undefined) {
      cache = createCache(storeFromEnv(options.env ?? process.env, projectDir));
      for (const t of telemetries) observeCacheTelemetry(cache, t);
      caches.set(projectDir, cache);
    }
    return cache.tier('compiled');
  };
  return {
    async compile(projectDir, entry) {
      const cache = tierFor(projectDir);
      const r = await compileTsx(join(projectDir, entry), { projectDir, mode: options.trusted ? 'trusted-host' : 'docker', ...(cache !== undefined ? { cache } : {}) });
      return { project: { ...r.project }, diagnostics: r.diagnostics };
    },
    async writeBack(projectDir, entry, patches) {
      const file = join(projectDir, entry);
      const source = await readFile(file, 'utf8');
      const r = applyPatchesToSource(source, patches, { fileName: entry });
      if (r.source !== source) await writeFile(file, r.source);
      return { applied: r.applied.length, diagnostics: r.diagnostics };
    },
    useTelemetry(telemetry) {
      if (!telemetries.includes(telemetry)) telemetries.push(telemetry);
      for (const cache of caches.values()) observeCacheTelemetry(cache, telemetry);
    },
  };
}
