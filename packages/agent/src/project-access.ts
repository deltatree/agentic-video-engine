/**
 * Zugriffsprüfung für eingebundene Projekte (Review M3).
 *
 * `project.open` bindet Ordner per Symlink in den Workspace ein. Die Wurzelprüfung darf nicht nur beim
 * Öffnen gelten: Nach einem Neustart mit anderen (oder ohne) `projectRoots` bliebe ein früher geöffneter
 * Ordner sonst weiter erreichbar. Darum prüft jede Operation, jeder Datei-Abruf und jeder Ereignis-Stream
 * das echte Ziel eines Symlink-Projekts erneut gegen die aktuellen Wurzeln.
 */
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import { OpenVideoError } from '@agentic-video/core';
import type { AgentServices } from './services.js';

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function hasCode(error: unknown): boolean {
  return error instanceof Error && 'code' in error;
}

/**
 * Wirft `OV_PATH_OUTSIDE`, wenn ein Projekt ein Symlink auf einen Ordner außerhalb der erlaubten Wurzeln
 * (`projectRoots`, `hostProjectDirs`) ist. Echte Projektordner im Workspace sind immer erlaubt;
 * fehlende Projekte meldet die jeweilige Operation selbst.
 *
 * @example
 * ```ts
 * await assertProjectAccess(services, 'launch-video');
 * ```
 */
export async function assertProjectAccess(services: Pick<AgentServices, 'workspace' | 'projectRoots' | 'hostProjectDirs'>, projectId: string): Promise<void> {
  const dir = services.workspace.projectDir(projectId);
  try {
    if (!(await lstat(dir)).isSymbolicLink()) return;
  } catch (error) {
    if (hasCode(error)) return;
    throw error;
  }
  const denied = new OpenVideoError({
    code: 'OV_PATH_OUTSIDE',
    errorClass: 'SecurityError',
    problem: `Project "${projectId}" is a linked folder outside the allowed project roots of this server.`,
    suggestions: ['Restart the server with --project <dir> or OPENVIDEO_PROJECT_ROOTS including that folder, then call project.open again.', 'Or create a new project with project.create.'],
  });
  let target: string;
  try {
    target = await realpath(dir);
  } catch (error) {
    // Verwaistes Ziel: wie ein fremder Ordner behandeln, ohne den Host-Pfad zu verraten.
    if (hasCode(error)) throw denied;
    throw error;
  }
  const allowed = [...(services.projectRoots ?? []), ...(services.hostProjectDirs ?? [])];
  const real = await Promise.all(allowed.map((r) => realpath(r).catch(() => undefined)));
  if (!real.some((r) => r !== undefined && inside(r, target))) throw denied;
}
