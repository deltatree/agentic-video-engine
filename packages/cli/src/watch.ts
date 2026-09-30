/**
 * Datei-Watcher für `openvideo dev` (Story 20.1, Audit §47).
 *
 * Beobachtet `src/**`, die Entry-Datei und `project.json` eines Projektordners.
 * TSX-Projekte werden bei jeder Quelländerung neu kompiliert; die IR landet in `project.json`.
 * Der Agent-Server sieht die neue Datei und meldet dem Studio die neue Revision (`/v1/events`).
 * Bei JSON-Projekten prüft der Watcher nur, ob `project.json` lesbares JSON ist.
 */
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { isSourceEntry, type SourceService } from '@agentic-video/agent';
import type { Diagnostic } from '@agentic-video/core';

/** Meldung des Watchers. */
export type WatchEvent =
  /** TSX neu kompiliert; `changed` ist `false`, wenn die IR gleich geblieben ist. */
  | { readonly kind: 'compiled'; readonly file: string; readonly changed: boolean; readonly diagnostics: readonly Diagnostic[] }
  /** `project.json` wurde geändert (JSON-Projekt). */
  | { readonly kind: 'changed'; readonly file: string }
  /** Kompilieren oder Lesen schlug fehl; das Studio behält den letzten guten Stand. */
  | { readonly kind: 'error'; readonly file: string; readonly diagnostics: readonly Diagnostic[] };

/** Optionen für {@link watchProject}. */
export interface WatchOptions {
  /** Projektordner. */
  readonly dir: string;
  /** Entry relativ zum Projektordner (`project.json` oder eine TSX-Datei). */
  readonly entry: string;
  /** TSX-Compiler (für TSX-Projekte nötig). */
  readonly sources?: SourceService;
  /** Wartezeit nach dem letzten Dateiereignis (Standard 120 ms). */
  readonly debounceMs?: number;
  /**
   * Zusätzlich alle n Millisekunden Änderungszeit und Größe der beobachteten Dateien vergleichen.
   * Für Bind-Mounts, die Änderungen vom Host nicht als inotify-Ereignis melden (Container unter
   * macOS/Windows, ADR 0029; `OPENVIDEO_WATCH_POLL_MS`). Standard: nur Dateiereignisse.
   */
  readonly pollMs?: number;
  readonly onEvent: (event: WatchEvent) => void;
}

/** Ein laufender Watcher. */
export interface ProjectWatcher {
  close(): void;
  /** Wartet, bis eine laufende Neukompilierung fertig ist (Tests). */
  idle(): Promise<void>;
}

const IGNORED = ['out', '.openvideo', 'node_modules', '.git'];

/**
 * Abfrage-Intervall aus `OPENVIDEO_WATCH_POLL_MS` (ganze Millisekunden, mindestens 100); sonst `undefined`.
 * Der Wrapper aus `npm run setup` setzt es unter macOS und Windows (ADR 0029).
 *
 * @example
 * ```ts
 * watchPollMsFromEnv({ OPENVIDEO_WATCH_POLL_MS: '1000' }); // 1000
 * watchPollMsFromEnv({}); // undefined
 * ```
 */
export function watchPollMsFromEnv(env: Readonly<Record<string, string | undefined>>): number | undefined {
  const raw = env['OPENVIDEO_WATCH_POLL_MS'];
  if (raw === undefined || !/^[0-9]+$/u.test(raw.trim())) return undefined;
  const ms = Number(raw.trim());
  return ms === 0 ? undefined : Math.max(100, ms);
}

/** Änderungszeit und Größe je Datei (relativer Pfad) der beobachteten Orte. */
async function snapshotOf(dir: string, entry: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const note = async (rel: string): Promise<void> => {
    if (!isWatchedPath(rel, entry)) return;
    try {
      const s = await stat(join(dir, rel));
      if (s.isFile()) out.set(rel, `${String(s.mtimeMs)}:${String(s.size)}`);
    } catch (error) {
      // Zwischen readdir und stat gelöscht: fehlt im Abbild und zählt beim Vergleich als Änderung.
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  };
  const list = async (sub: string, recursive: boolean): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(sub === '' ? dir : join(dir, sub), { recursive });
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return;
      throw error;
    }
    for (const name of names) await note(normalize(sub === '' ? name : join(sub, name)).split(sep).join('/'));
  };
  await list('', false);
  await list('src', true);
  const entryDir = dirname(entry);
  if (entryDir !== '.' && !normalize(entryDir).split(sep).join('/').startsWith('src')) await list(entryDir, false);
  return out;
}

/**
 * Soll eine geänderte Datei (relativ zum Projektordner) eine Neukompilierung auslösen?
 *
 * @example
 * ```ts
 * isWatchedPath('src/scenes/intro.tsx', 'src/video.tsx'); // true
 * isWatchedPath('out/frames/main-0.png', 'src/video.tsx'); // false
 * ```
 */
export function isWatchedPath(rel: string, entry: string): boolean {
  const path = normalize(rel).split(sep).join('/');
  if (path === '' || path.startsWith('../')) return false;
  if (IGNORED.some((d) => path === d || path.startsWith(`${d}/`))) return false;
  if (path.endsWith('.tmp') || path.endsWith('~') || path.split('/').some((p) => p.startsWith('.#'))) return false;
  if (path === 'project.json' || path === 'openvideo.json') return true;
  if (path === normalize(entry).split(sep).join('/')) return true;
  return path.startsWith('src/');
}

/**
 * Startet den Watcher.
 *
 * @example
 * ```ts
 * const watcher = watchProject({ dir: '/work/demo', entry: 'src/video.tsx', sources, onEvent: (e) => console.error(e.kind) });
 * watcher.close();
 * ```
 */
export function watchProject(options: WatchOptions): ProjectWatcher {
  const { dir, entry } = options;
  const tsx = isSourceEntry(entry);
  const debounce = options.debounceMs ?? 120;
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let closed = false;
  let dirty = new Set<string>();

  const run = async (files: ReadonlySet<string>): Promise<void> => {
    if (tsx) {
      // Eigene Schreibvorgänge an project.json lösen keine neue Kompilierung aus.
      const file = [...files].find((f) => f !== 'project.json');
      if (file === undefined) return;
      const sources = options.sources;
      if (sources === undefined) {
        options.onEvent({ kind: 'error', file, diagnostics: [{ code: 'OV_SOURCE_UNAVAILABLE', severity: 'error', errorClass: 'ProjectError', problem: 'TSX projects need the compiler, which is not available.', suggestions: ['Install @agentic-video/compiler, or use a JSON project.'] }] });
        return;
      }
      const compiled = await sources.compile(dir, entry);
      if (compiled.diagnostics.some((d) => d.severity === 'error')) {
        options.onEvent({ kind: 'error', file, diagnostics: compiled.diagnostics });
        return;
      }
      const text = `${JSON.stringify(compiled.project, null, 2)}\n`;
      const target = join(dir, 'project.json');
      const before = existsSync(target) ? await readFile(target, 'utf8') : '';
      if (before !== text) await writeFile(target, text);
      options.onEvent({ kind: 'compiled', file, changed: before !== text, diagnostics: compiled.diagnostics });
      return;
    }
    const file = files.has(entry) ? entry : files.has('project.json') ? 'project.json' : undefined;
    if (file === undefined) return;
    try {
      JSON.parse(await readFile(join(dir, entry), 'utf8'));
      options.onEvent({ kind: 'changed', file });
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      options.onEvent({ kind: 'error', file, diagnostics: [{ code: 'OV_PROJECT_INVALID', severity: 'error', errorClass: 'ProjectError', problem: `${entry} is not valid JSON: ${error.message}`, suggestions: ['Fix the JSON; the Studio keeps showing the last valid state.'] }] });
    }
  };

  const trigger = (): void => {
    if (closed) return;
    if (running !== undefined) {
      again = true;
      return;
    }
    const files = dirty;
    dirty = new Set();
    const file = [...files][0] ?? entry;
    running = run(files)
      .catch((error: unknown) => {
        options.onEvent({ kind: 'error', file, diagnostics: [{ code: 'OV_WATCH_FAILED', severity: 'error', errorClass: 'ProjectError', problem: error instanceof Error ? error.message : String(error), suggestions: ['Save the file again; the watcher keeps running.'] }] });
      })
      .finally(() => {
        running = undefined;
        if (again) {
          again = false;
          trigger();
        }
      });
  };

  const onChange = (rel: string): void => {
    if (!isWatchedPath(rel, entry)) return;
    dirty.add(normalize(rel).split(sep).join('/'));
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      trigger();
    }, debounce);
  };

  const add = (path: string, recursive: boolean, prefix: string): void => {
    const w = watch(path, { recursive, persistent: false }, (_type, name) => {
      if (typeof name === 'string') onChange(prefix === '' ? name : `${prefix}/${name}`);
    });
    // Ein gelöschter Ordner beendet nur diesen Watcher.
    w.on('error', () => {
      w.close();
    });
    watchers.push(w);
  };

  add(dir, false, '');
  if (existsSync(join(dir, 'src'))) add(join(dir, 'src'), true, 'src');
  const entryDir = dirname(entry);
  const rel = relative('src', entryDir);
  // Liegt die Entry-Datei außerhalb von src/ in einem Unterordner, wird dieser zusätzlich beobachtet.
  if (entryDir !== '.' && (rel.startsWith('..') || rel === entryDir) && existsSync(join(dir, entryDir))) add(join(dir, entryDir), false, entryDir.split(sep).join('/'));

  // Abfrage für Bind-Mounts ohne Dateiereignisse: geänderte, neue und gelöschte Dateien melden.
  let poll: ReturnType<typeof setInterval> | undefined;
  if (options.pollMs !== undefined && options.pollMs > 0) {
    let previous: Map<string, string> | undefined;
    let polling = false;
    const tick = async (): Promise<void> => {
      if (polling || closed) return;
      polling = true;
      try {
        const next = await snapshotOf(dir, entry);
        if (previous !== undefined) {
          for (const [rel, sig] of next) if (previous.get(rel) !== sig) onChange(rel);
          for (const rel of previous.keys()) if (!next.has(rel)) onChange(rel);
        }
        previous = next;
      } finally {
        polling = false;
      }
    };
    const runTick = (): void => {
      tick().catch((error: unknown) => {
        options.onEvent({ kind: 'error', file: entry, diagnostics: [{ code: 'OV_WATCH_FAILED', severity: 'error', errorClass: 'ProjectError', problem: error instanceof Error ? error.message : String(error), suggestions: ['Check that the project folder is readable; the watcher keeps polling.'] }] });
      });
    };
    runTick();
    poll = setInterval(runTick, options.pollMs);
    poll.unref();
  }

  return {
    close: () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      if (poll !== undefined) clearInterval(poll);
      for (const w of watchers) w.close();
    },
    idle: async () => {
      while (running !== undefined || timer !== undefined) await (running ?? new Promise((r) => setTimeout(r, debounce)));
    },
  };
}
