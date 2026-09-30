/**
 * Projektrevisionen und Live-Ereignisse (Story 20.1).
 *
 * Die Revision eines Projekts ist ein kurzer Inhalts-Hash von `project.json`. Sie ändert sich bei jeder
 * Änderung, egal woher sie kommt (Studio, Agent, CLI, Editor, `openvideo dev`-Watcher), und bleibt gleich,
 * wenn dieselbe Datei nur neu geschrieben wird (TSX-Projekte schreiben die kompilierte IR bei jedem Laden).
 * Der Server beobachtet den Projektordner und schickt neue Revisionen als Server-Sent Events
 * (`GET /v1/events?projectId=<id>`).
 */
import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Revision eines Dateiinhalts (16 Hex-Zeichen SHA-256).
 *
 * @example
 * ```ts
 * revisionOf(new TextEncoder().encode('{}')); // '44136fa355b3678a'
 * ```
 */
export function revisionOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/**
 * Liest die aktuelle Revision eines Projektordners; ohne `project.json` `undefined`.
 *
 * @example
 * ```ts
 * await projectRevision('/ws/projects/demo'); // 'a1b2c3d4e5f60718'
 * ```
 */
export async function projectRevision(dir: string): Promise<string | undefined> {
  try {
    return revisionOf(await readFile(join(dir, 'project.json')));
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined;
    throw error;
  }
}

/**
 * Formatiert ein Server-Sent Event.
 *
 * @example
 * ```ts
 * sseMessage('revision', { revision: 'abc' }); // 'event: revision\ndata: {"revision":"abc"}\n\n'
 * ```
 */
export function sseMessage(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

type Listener = (revision: string) => void;

interface Watched {
  readonly watcher: FSWatcher;
  readonly listeners: Set<Listener>;
  revision: string | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Beobachtet Projektordner und meldet neue Revisionen. Ein Ordner wird nur beobachtet,
 * solange mindestens ein Abonnent da ist.
 *
 * @example
 * ```ts
 * const revisions = new RevisionWatcher();
 * const stop = await revisions.subscribe('/ws/projects/demo', (rev) => console.log(rev));
 * stop();
 * ```
 */
export class RevisionWatcher {
  private readonly watched = new Map<string, Watched>();

  /** @param debounceMs Wartezeit nach dem letzten Dateiereignis (atomare Schreibvorgänge erzeugen mehrere). */
  constructor(private readonly debounceMs = 40) {}

  /** Abonniert Revisionsänderungen eines Ordners; liefert die Abmeldung. */
  async subscribe(dir: string, listener: Listener): Promise<() => void> {
    let entry = this.watched.get(dir);
    if (entry === undefined) {
      const revision = await projectRevision(dir);
      // Zwischen `await` und hier kann ein anderer Abonnent den Ordner schon angemeldet haben.
      entry = this.watched.get(dir);
      if (entry === undefined) {
        const created: Watched = { watcher: watch(dir, { persistent: false }), listeners: new Set(), revision, timer: undefined };
        created.watcher.on('change', (_type, name) => {
          if (typeof name === 'string' && name !== 'project.json') return;
          this.schedule(dir, created);
        });
        // Ein gelöschter oder unlesbarer Ordner beendet nur die Beobachtung, nicht den Server.
        created.watcher.on('error', () => {
          this.close(dir);
        });
        this.watched.set(dir, created);
        entry = created;
      }
    }
    const active = entry;
    active.listeners.add(listener);
    return () => {
      active.listeners.delete(listener);
      // Nur den eigenen Watcher schließen: Nach einem Fehler kann für denselben Ordner schon ein neuer laufen.
      if (active.listeners.size === 0 && this.watched.get(dir) === active) this.close(dir);
    };
  }

  /** Aktuell bekannte Revision (nach dem letzten Ereignis). */
  current(dir: string): string | undefined {
    return this.watched.get(dir)?.revision;
  }

  /** Beendet alle Beobachtungen. */
  closeAll(): void {
    for (const dir of [...this.watched.keys()]) this.close(dir);
  }

  private schedule(dir: string, entry: Watched): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.check(dir, entry);
    }, this.debounceMs);
  }

  private async check(dir: string, entry: Watched): Promise<void> {
    let revision: string | undefined;
    try {
      revision = await projectRevision(dir);
    } catch {
      // Unlesbar (z. B. mitten in einem Schreibvorgang): das nächste Ereignis prüft erneut.
      return;
    }
    if (revision === undefined || revision === entry.revision || this.watched.get(dir) !== entry) return;
    entry.revision = revision;
    for (const l of entry.listeners) l(revision);
  }

  private close(dir: string): void {
    const entry = this.watched.get(dir);
    if (entry === undefined) return;
    this.watched.delete(dir);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.watcher.close();
  }
}
