/**
 * TSX-Quellen: Kompilieren in der Sandbox und AST-Rückschreiben (FR-17, FR-76).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceService } from '@agentic-video/agent';
import { applyPatchesToSource, compileTsx } from '@agentic-video/compiler';

/**
 * Quellcode-Dienst für TSX-Projekte. `trusted` wertet auf dem Host aus (nur eigene Projekte).
 *
 * @example
 * ```ts
 * const sources = createSourceService({ trusted: false }); // Docker-Sandbox
 * ```
 */
export function createSourceService(options: { readonly trusted: boolean }): SourceService {
  return {
    async compile(projectDir, entry) {
      const r = await compileTsx(join(projectDir, entry), { projectDir, mode: options.trusted ? 'trusted-host' : 'docker' });
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
