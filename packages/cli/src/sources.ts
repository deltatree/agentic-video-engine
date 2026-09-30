/**
 * TSX-Quellen: Kompilieren in der Sandbox und AST-Rückschreiben (FR-17, FR-76).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceService } from '@agentic-video/agent';
import { createCache, storeFromEnv, type CacheTier } from '@agentic-video/cache';
import { applyPatchesToSource, compileTsx } from '@agentic-video/compiler';

/** Optionen für {@link createSourceService}. */
export interface SourceServiceOptions {
  /** `true` wertet auf dem Host aus (nur eigene Projekte), sonst in der Docker-Sandbox. */
  readonly trusted: boolean;
  /**
   * Cache-Ebene `compiled` je Projektordner (Story 21.2). Standard: `OPENVIDEO_CACHE_DIR` bzw.
   * `<projekt>/.openvideo/cache` aus `env`. `false` schaltet den Compiler-Cache ab.
   */
  readonly cache?: ((projectDir: string) => CacheTier) | false;
  /** Umgebungsvariablen für den Standard-Cache (Standard `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Quellcode-Dienst für TSX-Projekte. `trusted` wertet auf dem Host aus (nur eigene Projekte).
 * Der Compiler-Output landet in der Cache-Ebene `compiled`; unveränderte Quellen werden nicht
 * erneut in der Sandbox ausgewertet.
 *
 * @example
 * ```ts
 * const sources = createSourceService({ trusted: false }); // Docker-Sandbox
 * ```
 */
export function createSourceService(options: SourceServiceOptions): SourceService {
  const tiers = new Map<string, CacheTier>();
  const tierFor = (projectDir: string): CacheTier | undefined => {
    if (options.cache === false) return undefined;
    if (options.cache !== undefined) return options.cache(projectDir);
    let tier = tiers.get(projectDir);
    if (tier === undefined) {
      tier = createCache(storeFromEnv(options.env ?? process.env, projectDir)).tier('compiled');
      tiers.set(projectDir, tier);
    }
    return tier;
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
  };
}
