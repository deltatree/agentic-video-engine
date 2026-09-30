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
import { readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

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

interface Subscriber {
  readonly onRevision: Listener;
  readonly onEnd: (() => void) | undefined;
}

interface Watched {
  readonly watcher: FSWatcher;
  readonly listeners: Set<Subscriber>;
  /** Inode des beobachteten Ordners: Ein ersetzter Ordner (gleicher Pfad, neuer Inode) beendet die Beobachtung. */
  readonly ino: number;
  revision: string | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Abfrage-Intervall, wenn Dateiereignisse fehlen können (`pollMs`). */
  poll: ReturnType<typeof setInterval> | undefined;
}

/** Inode eines Ordners; `undefined`, wenn er fehlt. */
async function inodeOf(dir: string): Promise<number | undefined> {
  try {
    return (await stat(dir)).ino;
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return undefined;
    throw error;
  }
}

/**
 * Beobachtet Projektordner und meldet neue Revisionen. Ein Ordner wird nur beobachtet,
 * solange mindestens ein Abonnent da ist.
 *
 * Endet die Beobachtung von selbst (Watcher-Fehler, Ordner gelöscht oder durch einen neuen ersetzt),
 * erfahren das alle Abonnenten über `onEnd`: Ein SSE-Strom schließt dann, und der Client verbindet neu
 * (und beobachtet so den neuen Ordner), statt still „live“ zu bleiben, ohne je wieder etwas zu hören.
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

  /**
   * @param debounceMs Wartezeit nach dem letzten Dateiereignis (atomare Schreibvorgänge erzeugen mehrere).
   * @param pollMs Zusätzlich alle n Millisekunden prüfen (Bind-Mounts ohne inotify-Ereignisse, ADR 0029).
   */
  constructor(
    private readonly debounceMs = 40,
    private readonly pollMs?: number,
  ) {}

  /**
   * Abonniert Revisionsänderungen eines Ordners; liefert die Abmeldung. `onEnd` läuft einmal, wenn die
   * Beobachtung von selbst endet (Fehler, Ordner gelöscht oder ersetzt) – nicht bei Abmeldung oder `closeAll`.
   */
  async subscribe(dir: string, listener: Listener, onEnd?: () => void): Promise<() => void> {
    let entry = this.watched.get(dir);
    if (entry === undefined) {
      const [revision, ino] = await Promise.all([projectRevision(dir), inodeOf(dir)]);
      // Zwischen `await` und hier kann ein anderer Abonnent den Ordner schon angemeldet haben.
      entry = this.watched.get(dir);
      if (entry === undefined) {
        const created: Watched = { watcher: watch(dir, { persistent: false }), listeners: new Set(), ino: ino ?? -1, revision, timer: undefined, poll: undefined };
        if (this.pollMs !== undefined && this.pollMs > 0) {
          created.poll = setInterval(() => {
            void this.check(dir, created);
          }, this.pollMs);
          created.poll.unref();
        }
        const self = basename(dir);
        created.watcher.on('change', (_type, name) => {
          // `project.json` oder der Ordner selbst (gelöscht/umbenannt meldet Linux mit seinem Namen).
          if (typeof name === 'string' && name !== 'project.json' && name !== self) return;
          this.schedule(dir, created);
        });
        // Ein gelöschter oder unlesbarer Ordner beendet nur die Beobachtung, nicht den Server.
        created.watcher.on('error', () => {
          this.end(dir, created);
        });
        this.watched.set(dir, created);
        entry = created;
      }
    }
    const active = entry;
    const subscriber: Subscriber = { onRevision: listener, onEnd };
    active.listeners.add(subscriber);
    return () => {
      active.listeners.delete(subscriber);
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
    let ino: number | undefined;
    try {
      [revision, ino] = await Promise.all([projectRevision(dir), inodeOf(dir)]);
    } catch {
      // Unlesbar (z. B. mitten in einem Schreibvorgang): das nächste Ereignis prüft erneut.
      return;
    }
    if (this.watched.get(dir) !== entry) return;
    // Ordner gelöscht oder ersetzt: Der Watcher hängt am alten Inode und hört nie wieder etwas.
    if (ino !== entry.ino) {
      this.end(dir, entry);
      return;
    }
    if (revision === undefined || revision === entry.revision) return;
    entry.revision = revision;
    for (const l of entry.listeners) l.onRevision(revision);
  }

  /** Beendet eine Beobachtung, die von selbst abgebrochen ist, und sagt es allen Abonnenten. */
  private end(dir: string, entry: Watched): void {
    if (this.watched.get(dir) !== entry) return;
    const subscribers = [...entry.listeners];
    entry.listeners.clear();
    this.close(dir);
    for (const s of subscribers) s.onEnd?.();
  }

  private close(dir: string): void {
    const entry = this.watched.get(dir);
    if (entry === undefined) return;
    this.watched.delete(dir);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    if (entry.poll !== undefined) clearInterval(entry.poll);
    entry.watcher.close();
  }
}
