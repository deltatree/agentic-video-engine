/**
 * Sammelt die Projektdateien für Worker ohne gemeinsames Dateisystem (Docker, Remote).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { OpenVideoError } from '@agentic-video/core';
import type { ProjectFile } from './protocol.js';

/** Größte Summe aller Projektdateien (1 GiB); der Stream-Rahmen hat ein u32-Längenfeld je Datei. */
export const MAX_PROJECT_BYTES = 1024 * 1024 * 1024;

/** Ordner, die nie mitgeschickt werden: Ausgaben, Abhängigkeiten, Caches. */
const SKIPPED_DIRS = new Set(['node_modules', 'out']);

/**
 * Liest alle Projektdateien (ohne versteckte Einträge, `node_modules` und `out`).
 *
 * @example
 * ```ts
 * const files = await collectProjectFiles('/work/hello');
 * ```
 */
export async function collectProjectFiles(projectDir: string, maxBytes = MAX_PROJECT_BYTES): Promise<ProjectFile[]> {
  const out: ProjectFile[] = [];
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name)) await walk(full);
      } else if (e.isFile()) {
        const bytes = new Uint8Array(await readFile(full));
        total += bytes.length;
        if (total > maxBytes) {
          throw new OpenVideoError({
            code: 'OV_SCHEDULER_PROJECT_TOO_LARGE',
            errorClass: 'SchedulerError',
            problem: `The project files exceed ${String(maxBytes)} bytes and cannot be sent to the worker.`,
            details: { projectDir },
            suggestions: ['Move large unused files out of the project folder.', 'Use process workers with a shared file system instead.'],
          });
        }
        out.push({ path: relative(projectDir, full).split(sep).join('/'), bytes });
      }
    }
  };
  await walk(projectDir);
  return out;
}

/** Prüft einen relativen Projektpfad gegen Ausbrüche aus dem Zielordner. */
export function isSafeRelativePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  return path.split('/').every((p) => p !== '' && p !== '.' && p !== '..');
}
