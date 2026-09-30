/**
 * Zustand des Studios. Die Wahrheit liegt auf dem Server: Der Store lädt die IR,
 * schickt jede Änderung als Patch und hält nur Ansichtszustand (Auswahl, Frame, Zoom, Undo-Stapel).
 *
 * Schreibende Aufrufe laufen über eine serielle Warteschlange (Story 20.3); der Server meldet jede
 * neue Revision von `project.json` als Ereignis, Fremdänderungen laden neu (Story 20.1).
 */
import { isRecord, type Diagnostic } from '@agentic-video/core';
import { ApiError, call, errorText, fetchText, fetchTextWithRevision } from './api.js';
import { AudioPlayer, addAudioClipPatches, editClip, forgetDecodedAudio, planClips, type ClipEdit } from './audio.js';
import { clipboardText, parseClipboard } from './clipboard.js';
import { alignDeltas, distributeDeltas, type AlignMode, type Box, type Delta } from './geometry.js';
import { History, type HistoryEntry } from './history.js';
import { allIds, cloneWithNewIds, findNode, frames, setNumberAt, timeInfo, topLevel, uniqueId, valueAt, walkNodes } from './ir.js';
import { num, rec, records, str, toDiagnostic, toDiagnostics, type PatchJson, type Rec } from './json.js';
import { layerPatches, siblingsOf, ungroupPatches, type LayerCommand } from './layers.js';
import { multiSetPatches } from './multi.js';
import { LatestOnly, SerialQueue } from './queue.js';
import { RevisionTracker, subscribeRevisions, type LiveState } from './sync.js';
import { addMarker, advanceFrame, keyframeJump, moveKeyframe, removeMarker, renameMarker, shuttle } from './timeline-logic.js';
import { resizePatches, rotateBy } from './transform.js';

/** Knoten aus `scene.tree` (mit Bounds in Composition-Pixeln). */
export interface TreeNode {
  readonly id: string;
  readonly type: string;
  readonly bounds?: Box;
  readonly localFrame: number;
  readonly source?: { readonly file: string; readonly line: number; readonly column: number };
  readonly children: readonly TreeNode[];
}

/** Eintrag aus `timeline.inspect`. */
export interface TimelineNode {
  readonly id: string;
  readonly type: string;
  readonly depth: number;
  readonly start: number;
  readonly end: number;
  readonly animated: readonly { readonly property: string; readonly kind: string; readonly keyframes: readonly number[] }[];
}

/** Ergebnis von `timeline.inspect`. */
export interface TimelineInfo {
  readonly fps: number;
  readonly durationFrames: number;
  readonly markers: readonly { readonly id: string; readonly frame: number; readonly label: string }[];
  readonly nodes: readonly TimelineNode[];
}

/** Sicht auf einen Render-Job. */
export interface JobView {
  readonly id: string;
  readonly label: string;
  readonly state: string;
  readonly stage: string;
  readonly done: number;
  readonly total: number;
  readonly outputs: readonly string[];
  readonly error?: string;
}

/** Meldung in der Statuszeile. */
export interface Message {
  readonly kind: 'error' | 'info';
  readonly text: string;
}

/** Die Tabs der unteren Leiste. */
export type BottomTab = 'code' | 'diagnostics' | 'queue';

/** Ladezustand (Story 20.3). */
export type BootStatus = 'loading' | 'error' | 'ready';

/** Gesamter Zustand. */
export interface StudioState {
  readonly projectId: string;
  readonly status: BootStatus;
  readonly loadError: string | undefined;
  readonly kind: 'json' | 'tsx';
  readonly entry: string;
  readonly project: Rec | undefined;
  readonly projectText: string;
  readonly sourceText: string | undefined;
  readonly comp: Rec | undefined;
  readonly frame: number;
  readonly playing: boolean;
  /** Tempo der Wiedergabe (J/K/L): 1 normal, negativ rückwärts. */
  readonly speed: number;
  readonly exact: boolean;
  readonly muted: boolean;
  readonly inPoint: number | undefined;
  readonly outPoint: number | undefined;
  readonly selection: readonly string[];
  readonly tree: readonly TreeNode[];
  /** Frame, zu dem `tree` gehört (während eines Sprungs kann der Baum noch vom alten Frame sein). */
  readonly treeFrame: number;
  readonly timeline: TimelineInfo | undefined;
  readonly diagnostics: readonly Diagnostic[];
  readonly image: { readonly src: string; readonly frame: number; readonly preview?: boolean } | undefined;
  readonly resolution: number;
  readonly zoom: number;
  readonly debug: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly message: Message | undefined;
  readonly jobs: readonly JobView[];
  readonly bottomTab: BottomTab;
  readonly reveal: { readonly nodeId?: string; readonly pointer?: string; readonly line?: number; readonly nonce: number } | undefined;
  readonly busy: boolean;
  /** Verbindung für Live-Updates. */
  readonly live: LiveState;
  /** Die Datei hat sich von außen geändert, während ein Code-Entwurf offen ist. */
  readonly draftConflict: boolean;
  /** Zähler, der bei ungespeichertem Code-Entwurf steigt (für `beforeunload` und Anzeige). */
  readonly draftDirty: boolean;
}

/** Eine Render-Voreinstellung der Render Queue. */
export interface RenderPreset {
  readonly key: string;
  readonly label: string;
  readonly operation: 'preview.render' | 'video.render';
  readonly input: Readonly<Rec>;
}

/** Eingebaute Voreinstellungen (alle mit den Encodern von `openvideo doctor` prüfbar). */
export const RENDER_PRESETS: readonly RenderPreset[] = [
  { key: 'preview', label: 'Preview (MP4, 25 %)', operation: 'preview.render', input: { scale: 0.25 } },
  { key: 'mp4', label: 'MP4 (H.264)', operation: 'video.render', input: { profile: { format: 'mp4', codec: 'h264' } } },
  { key: 'webm', label: 'WebM (VP9)', operation: 'video.render', input: { profile: { format: 'webm', codec: 'vp9' } } },
  { key: 'gif', label: 'GIF', operation: 'video.render', input: { profile: { format: 'gif', codec: 'gif' } } },
];

const JOB_LABELS_KEY = 'openvideo.studio.jobs';
const MUTED_KEY = 'openvideo.studio.muted';

function parseTree(value: unknown): TreeNode[] {
  return records(value).map((n) => {
    const b = rec(n['bounds']);
    const s = n['source'];
    return {
      id: str(n['id'], ''),
      type: str(n['type'], ''),
      ...(isRecord(n['bounds']) ? { bounds: { x: num(b['x'], 0), y: num(b['y'], 0), width: num(b['width'], 0), height: num(b['height'], 0) } } : {}),
      localFrame: num(n['localFrame'], 0),
      ...(isRecord(s) ? { source: { file: str(s['file'], ''), line: num(s['line'], 1), column: num(s['column'], 1) } } : {}),
      children: parseTree(n['children']),
    };
  });
}

function parseTimeline(value: Rec, comp: Rec | undefined): TimelineInfo {
  const labels = new Map(records(comp?.['markers']).map((m) => [str(m['id'], ''), str(m['label'], '')]));
  return {
    fps: num(value['fps'], 30),
    durationFrames: num(value['durationFrames'], 1),
    markers: records(value['markers']).map((m) => {
      const id = str(m['id'], '');
      const label = labels.get(id) ?? '';
      return { id, frame: num(m['frame'], 0), label: label !== '' ? label : id };
    }),
    nodes: records(value['nodes']).map((n) => ({
      id: str(n['id'], ''),
      type: str(n['type'], ''),
      depth: num(n['depth'], 0),
      start: num(n['start'], 0),
      end: num(n['end'], 0),
      animated: records(n['animated']).map((a) => ({
        property: str(a['property'], ''),
        kind: str(a['kind'], ''),
        keyframes: Array.isArray(a['keyframes']) ? a['keyframes'].map((k) => num(k, 0)) : [],
      })),
    })),
  };
}

function parseJob(value: Rec, label: string): JobView {
  const progress = rec(value['progress']);
  const result = rec(value['result']);
  const error = value['error'];
  return {
    id: str(value['id'], ''),
    label,
    state: str(value['state'], 'queued'),
    stage: str(progress['stage'], ''),
    done: num(progress['done'], 0),
    total: num(progress['total'], 0),
    outputs: records(result['outputs']).map((o) => str(o['url'], '')).filter((u) => u !== ''),
    ...(isRecord(error) ? { error: toDiagnostic(error).problem } : {}),
  };
}

/** Flacht einen Szenenbaum ab (Zeichenreihenfolge). */
export function flattenTree(tree: readonly TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const visit = (list: readonly TreeNode[]): void => {
    for (const n of list) {
      out.push(n);
      visit(n.children);
    }
  };
  visit(tree);
  return out;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function readStorage(storage: 'local' | 'session', key: string): string | null {
  try {
    return (storage === 'local' ? localStorage : sessionStorage).getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(storage: 'local' | 'session', key: string, value: string): void {
  try {
    (storage === 'local' ? localStorage : sessionStorage).setItem(key, value);
  } catch (error) {
    console.warn('OpenVideo Studio: storage unavailable', error);
  }
}

/**
 * Der Store des Studios (für `useSyncExternalStore`).
 *
 * @example
 * ```ts
 * const studio = new Studio('demo');
 * await studio.load();
 * await studio.patch([{ op: 'setProperty', nodeId: 'title', property: 'x', value: 100 }]);
 * ```
 */
export class Studio {
  private state: StudioState;
  private readonly listeners = new Set<() => void>();
  private readonly history = new History();
  private readonly queue = new SerialQueue();
  private readonly revisions = new RevisionTracker();
  private readonly audio = new AudioPlayer();
  private readonly preview: LatestOnly<readonly PatchJson[]>;
  private imageSeq = 0;
  private treeSeq = 0;
  private diagTimer: ReturnType<typeof setTimeout> | undefined;
  private jobTimer: ReturnType<typeof setInterval> | undefined;
  private clipboard: Rec[] = [];
  private stopLive: (() => void) | undefined;
  private previewing = false;
  /** Ungespeicherter Text des Code-Editors (überlebt Tab-Wechsel). */
  private draft: string | undefined;

  constructor(projectId: string) {
    this.state = {
      projectId,
      status: 'loading',
      loadError: undefined,
      kind: 'json',
      entry: 'project.json',
      project: undefined,
      projectText: '',
      sourceText: undefined,
      comp: undefined,
      frame: 0,
      playing: false,
      speed: 1,
      exact: false,
      muted: readStorage('local', MUTED_KEY) === '1',
      inPoint: undefined,
      outPoint: undefined,
      selection: [],
      tree: [],
      treeFrame: -1,
      timeline: undefined,
      diagnostics: [],
      image: undefined,
      resolution: 1,
      zoom: 0.5,
      debug: false,
      canUndo: false,
      canRedo: false,
      message: undefined,
      jobs: [],
      bottomTab: 'code',
      reveal: undefined,
      busy: false,
      live: 'connecting',
      draftConflict: false,
      draftDirty: false,
    };
    this.audio.setMuted(this.state.muted);
    // Live-Vorschau beim Ziehen (Story 20.5): höchstens ein Render gleichzeitig, der neueste gewinnt.
    this.preview = new LatestOnly((patches) => this.renderPreview(patches), 60);
  }

  /** Für `useSyncExternalStore`. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Für `useSyncExternalStore`. */
  readonly getState = (): StudioState => this.state;

  private set(partial: Partial<StudioState>): void {
    this.state = { ...this.state, ...partial };
    for (const l of this.listeners) l();
  }

  private fail(error: unknown): void {
    this.set({ message: { kind: 'error', text: errorText(error) } });
  }

  /** Zeigt eine Meldung in der Statuszeile. */
  notify(kind: Message['kind'], text: string): void {
    this.set({ message: { kind, text } });
  }

  /** Blendet die Meldung aus. */
  dismissMessage(): void {
    this.set({ message: undefined });
  }

  private get input(): Rec {
    return { projectId: this.state.projectId };
  }

  /** Länge der Composition in Frames. */
  get durationFrames(): number {
    return Math.max(1, this.state.timeline?.durationFrames ?? 1);
  }

  /** Ungespeicherter Code-Entwurf. */
  get codeDraft(): string | undefined {
    return this.draft;
  }

  set codeDraft(text: string | undefined) {
    this.draft = text;
    if ((text !== undefined) !== this.state.draftDirty || (text === undefined && this.state.draftConflict)) this.set({ draftDirty: text !== undefined, ...(text === undefined ? { draftConflict: false } : {}) });
  }

  /** Muss die Seite vor dem Verlassen warnen (offener Entwurf oder laufende Speicherung)? */
  hasUnsavedWork(): boolean {
    return this.draft !== undefined || this.queue.pending > 0;
  }

  // -------------------------------------------------------------------------
  // Laden und Live-Sync
  // -------------------------------------------------------------------------

  /** Lädt Projekt, IR, Timeline und den aktuellen Frame; Fehler zeigen einen Retry-Zustand. */
  async load(): Promise<void> {
    this.set({ status: 'loading', loadError: undefined });
    try {
      const info = await call('project.inspect', this.input);
      this.set({ kind: info['kind'] === 'tsx' ? 'tsx' : 'json', entry: str(info['entry'], 'project.json') });
      await this.reload();
      this.set({ status: 'ready' });
      this.stopLive ??= subscribeRevisions(
        this.state.projectId,
        (revision) => {
          this.onRemoteRevision(revision);
        },
        (live) => {
          if (live !== this.state.live) this.set({ live });
        },
      );
      void this.restoreJobs();
    } catch (error) {
      this.set({ status: 'error', loadError: errorText(error) });
    }
  }

  /** Beendet Live-Updates, Wiedergabe und Abfragen (beim Verlassen der Seite). */
  dispose(): void {
    this.stopLive?.();
    this.stopLive = undefined;
    this.audio.stop();
    if (this.jobTimer !== undefined) clearInterval(this.jobTimer);
    this.jobTimer = undefined;
  }

  /** Lädt alles nach einer Änderung neu. */
  async reload(): Promise<void> {
    const [comp, timeline, file] = await Promise.all([call('composition.get', this.input), call('timeline.inspect', this.input), fetchTextWithRevision(this.state.projectId, 'project.json')]);
    let project: Rec | undefined;
    try {
      const parsed: unknown = JSON.parse(file.text);
      project = isRecord(parsed) ? parsed : undefined;
    } catch (error) {
      this.fail(error);
    }
    const sourceText = this.state.kind === 'tsx' ? await fetchText(this.state.projectId, this.state.entry) : undefined;
    this.revisions.loaded(file.revision);
    const ids = allIds(comp);
    const parsedTimeline = parseTimeline(timeline, comp);
    const last = Math.max(0, parsedTimeline.durationFrames - 1);
    this.set({
      comp,
      project,
      projectText: file.text,
      sourceText,
      timeline: parsedTimeline,
      frame: Math.min(this.state.frame, last),
      inPoint: this.state.inPoint !== undefined ? Math.min(this.state.inPoint, last) : undefined,
      outPoint: this.state.outPoint !== undefined ? Math.min(this.state.outPoint, last) : undefined,
      selection: this.state.selection.filter((id) => ids.has(id)),
    });
    await this.refreshFrame();
    this.scheduleDiagnostics(0);
  }

  /** Der Server meldet eine neue Revision von `project.json`. */
  onRemoteRevision(revision: string): void {
    if (this.revisions.remote(revision, this.queue.pending > 0 || this.state.status !== 'ready')) void this.applyForeignChange();
  }

  /**
   * Fremdänderung: neu laden, Undo/Redo verwerfen (die Umkehrungen beziehen sich auf den alten Stand)
   * und bei offenem Code-Entwurf warnen, statt ihn zu überschreiben.
   */
  private async applyForeignChange(): Promise<void> {
    const hadHistory = this.history.canUndo || this.history.canRedo;
    this.history.clear();
    forgetDecodedAudio();
    const conflict = this.draft !== undefined;
    await this.write(async () => {
      await this.reload();
      return true;
    }, false);
    this.set({
      canUndo: false,
      canRedo: false,
      draftConflict: conflict,
      message: conflict
        ? { kind: 'error', text: 'The project changed outside the Studio while the Code panel has unsaved edits. Save overwrites the outside change; Discard loads it.' }
        : { kind: 'info', text: `The project changed outside the Studio and was reloaded${hadHistory ? '; undo history was cleared' : ''}.` },
    });
  }

  // -------------------------------------------------------------------------
  // Frames
  // -------------------------------------------------------------------------

  /** Skalierung für `frame.render`: Auflösungswahl, aber nicht größer als der Zoom braucht. */
  renderScale(): number {
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    const needed = Math.ceil(this.state.zoom * dpr * 20) / 20;
    return Math.max(0.05, Math.min(this.state.resolution, needed));
  }

  private renderInput(frame: number, patches?: readonly PatchJson[]): Rec {
    return {
      ...this.input,
      frame,
      scale: this.renderScale(),
      inline: true,
      ...(this.state.debug ? { debug: { showBounds: true, showAnchors: true, showNodeIds: true } } : {}),
      ...(patches !== undefined && patches.length > 0 ? { patches } : {}),
    };
  }

  private async renderImage(frame: number): Promise<void> {
    const seq = ++this.imageSeq;
    const r = await call('frame.render', this.renderInput(frame));
    if (seq !== this.imageSeq) return;
    const image = rec(r['image']);
    this.set({ image: { src: `data:image/png;base64,${str(image['base64'], '')}`, frame } });
  }

  private async refreshTree(frame: number): Promise<void> {
    const seq = ++this.treeSeq;
    const r = await call('scene.tree', { ...this.input, frame });
    if (seq === this.treeSeq) this.set({ tree: parseTree(r['tree']), treeFrame: frame });
  }

  /** Lädt Bild und Szenenbaum des aktuellen Frames. */
  async refreshFrame(): Promise<void> {
    const frame = this.state.frame;
    try {
      await Promise.all([this.renderImage(frame), this.refreshTree(frame)]);
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Zeigt einen transienten Zwischenstand (Ziehen, Slider): `frame.render` mit `patches`, nichts wird gespeichert.
   * Gedrosselt: höchstens ein Render läuft, danach nur der neueste Stand.
   */
  previewPatches(patches: readonly PatchJson[]): void {
    if (patches.length === 0) return;
    this.previewing = true;
    this.preview.push(patches);
  }

  /** Beendet die Live-Vorschau (danach kommt der gespeicherte Stand). */
  endPreview(): void {
    this.previewing = false;
    this.preview.cancel();
  }

  /** Verwirft einen Zwischenstand (z. B. abgelehntes Ziehen) und zeigt wieder den gespeicherten Frame. */
  cancelPreview(): void {
    this.endPreview();
    if (this.state.image?.preview === true) void this.refreshFrame();
  }

  private isPreviewing(): boolean {
    return this.previewing;
  }

  private async renderPreview(patches: readonly PatchJson[]): Promise<void> {
    if (!this.previewing) return;
    const seq = ++this.imageSeq;
    const frame = this.state.frame;
    try {
      const r = await call('frame.render', this.renderInput(frame, patches));
      if (seq !== this.imageSeq || !this.isPreviewing()) return;
      this.set({ image: { src: `data:image/png;base64,${str(rec(r['image'])['base64'], '')}`, frame, preview: true } });
    } catch (error) {
      // Ein abgelehnter Zwischenstand (z. B. ungültiger Wert) ist kein Fehler des Nutzers: das letzte Bild bleibt.
      if (!(error instanceof ApiError)) this.fail(error);
    }
  }

  /** Lädt die Diagnosen des aktuellen Frames (verzögert, damit Scrubben flüssig bleibt). */
  scheduleDiagnostics(delay = 250): void {
    if (this.diagTimer !== undefined) clearTimeout(this.diagTimer);
    this.diagTimer = setTimeout(() => {
      void this.refreshDiagnostics();
    }, delay);
  }

  /** Lädt die Diagnosen sofort. */
  async refreshDiagnostics(): Promise<void> {
    try {
      const r = await call('diagnostics.get', { ...this.input, frame: this.state.frame });
      this.set({ diagnostics: toDiagnostics(r['diagnostics']) });
    } catch (error) {
      this.fail(error);
    }
  }

  /** Springt zu einem Frame. */
  seek(frame: number): void {
    const f = Math.max(0, Math.min(this.durationFrames - 1, Math.round(frame)));
    if (f === this.state.frame && this.state.image?.frame === f && this.state.image.preview !== true) return;
    this.set({ frame: f });
    if (!this.state.playing) {
      void this.refreshFrame();
      this.scheduleDiagnostics();
    }
  }

  /** Geht Frames vor oder zurück. */
  step(delta: number): void {
    this.seek(this.state.frame + delta);
  }

  // -------------------------------------------------------------------------
  // Wiedergabe (Story 20.2, 20.6)
  // -------------------------------------------------------------------------

  /** Startet oder stoppt die Wiedergabe (normales Tempo). */
  togglePlay(): void {
    if (this.state.playing) {
      this.set({ playing: false });
      return;
    }
    this.set({ playing: true, speed: 1 });
    void this.playLoop();
  }

  /** J/K/L-Shuttle. */
  shuttle(key: 'j' | 'k' | 'l'): void {
    const speed = shuttle(this.state.playing ? this.state.speed : 0, key);
    if (speed === 0) {
      this.set({ playing: false });
      return;
    }
    const wasPlaying = this.state.playing;
    this.set({ playing: true, speed });
    if (!wasPlaying) void this.playLoop();
  }

  /** Setzt In- oder Out-Punkt am Playhead (`undefined` löscht). */
  setRange(which: 'in' | 'out' | 'clear'): void {
    if (which === 'clear') {
      this.set({ inPoint: undefined, outPoint: undefined });
      return;
    }
    const f = this.state.frame;
    if (which === 'in') this.set({ inPoint: f, ...(this.state.outPoint !== undefined && this.state.outPoint < f ? { outPoint: undefined } : {}) });
    else this.set({ outPoint: f, ...(this.state.inPoint !== undefined && this.state.inPoint > f ? { inPoint: undefined } : {}) });
  }

  /** Ton an/aus (gespeichert). */
  setMuted(muted: boolean): void {
    writeStorage('local', MUTED_KEY, muted ? '1' : '0');
    this.audio.setMuted(muted);
    this.set({ muted });
  }

  /**
   * Wiedergabe als fortlaufende Frame-Anfragen. Mit Ton gibt die Audiouhr den Takt vor (Frames werden
   * übersprungen, wenn das Rendern langsamer ist); ohne Ton folgt die Rate der Antwortzeit.
   * „Exact“ zeigt jeden Frame (dann ohne Ton, weil er nicht synchron bleiben könnte).
   */
  private async playLoop(): Promise<void> {
    const fps = this.state.timeline?.fps ?? 30;
    const range = (): { lo: number; hi: number } => {
      const d = this.durationFrames;
      const lo = Math.max(0, Math.min(this.state.inPoint ?? 0, d - 1));
      return { lo, hi: Math.max(lo, Math.min(this.state.outPoint ?? d - 1, d - 1)) };
    };
    const clips = planClips(this.state.comp, this.state.project);
    const startAudio = async (frame: number): Promise<boolean> => {
      if (this.state.exact || this.state.speed !== 1 || clips.length === 0) return false;
      try {
        return await this.audio.start(this.state.projectId, clips, frame / fps);
      } catch (error) {
        this.notify('error', `Audio preview unavailable: ${errorText(error)}`);
        return false;
      }
    };
    // Außerhalb von In/Out beginnt die Wiedergabe am In-Punkt.
    const { lo, hi } = range();
    if (this.state.frame < lo || this.state.frame > hi) this.set({ frame: lo });
    let audioClock = await startAudio(this.state.frame);
    let expected = this.state.frame;
    try {
      while (this.isPlaying()) {
        const started = performance.now();
        // Springt der Nutzer während der Wiedergabe, folgt der Ton.
        if (this.state.frame !== expected && audioClock) audioClock = await startAudio(this.state.frame);
        const frame = this.state.frame;
        await this.renderImage(frame);
        const speed = this.state.speed;
        const frameMs = 1000 / (fps * Math.abs(speed));
        const elapsed = performance.now() - started;
        if (elapsed < frameMs) await sleep(frameMs - elapsed);
        // Während des Wartens kann Pause gedrückt worden sein.
        if (!this.isPlaying()) break;
        const r = range();
        let next: number;
        if (audioClock && speed === 1) {
          next = Math.max(frame + 1, Math.floor(this.audio.position() * fps));
          if (next > r.hi) {
            next = r.lo;
            audioClock = await startAudio(next);
          }
        } else {
          const advance = this.state.exact ? 1 : Math.max(1, Math.round((performance.now() - started) / frameMs));
          next = advanceFrame(frame, Math.sign(speed) * advance, this.durationFrames, r.lo === 0 && this.state.inPoint === undefined ? undefined : r.lo, this.state.outPoint === undefined ? undefined : r.hi);
          // Mit Ton ohne Audiouhr (Tempo ≠ 1): Ton aus, bis wieder normal gespielt wird.
          if (speed === 1 && !audioClock && !this.state.exact && clips.length > 0 && !this.audio.playing) audioClock = await startAudio(next);
        }
        if (speed !== 1 && this.audio.playing) {
          this.audio.stop();
          audioClock = false;
        }
        expected = next;
        this.set({ frame: next });
      }
    } catch (error) {
      this.set({ playing: false });
      this.fail(error);
    }
    this.audio.stop();
    await this.refreshFrame();
    this.scheduleDiagnostics();
  }

  private isPlaying(): boolean {
    return this.state.playing;
  }

  /** Setzt „Exact“ (keine übersprungenen Frames). */
  setExact(exact: boolean): void {
    this.set({ exact });
  }

  /** Ändert die Auswahl. */
  select(ids: readonly string[], mode: 'replace' | 'toggle' | 'add' = 'replace'): void {
    let next: string[];
    if (mode === 'replace') next = [...ids];
    else if (mode === 'add') next = [...new Set([...this.state.selection, ...ids])];
    else {
      const current = new Set(this.state.selection);
      for (const id of ids) {
        if (current.has(id)) current.delete(id);
        else current.add(id);
      }
      next = [...current];
    }
    this.history.seal();
    this.set({ selection: next });
  }

  /** Wählt einen Tab der unteren Leiste. */
  setBottomTab(tab: BottomTab): void {
    this.set({ bottomTab: tab });
  }

  /** Setzt Zoom der Bühne (0.05 … 8). */
  setZoom(zoom: number): void {
    const z = Math.max(0.05, Math.min(8, zoom));
    const before = this.renderScale();
    this.set({ zoom: z });
    if (this.renderScale() !== before && !this.state.playing) void this.refreshFrame();
  }

  /** Setzt die Vorschau-Auflösung (0.25, 0.5, 1). */
  setResolution(resolution: number): void {
    this.set({ resolution });
    if (!this.state.playing) void this.refreshFrame();
  }

  /** Schaltet die Debug-Overlays von `frame.render`. */
  setDebug(debug: boolean): void {
    this.set({ debug });
    if (!this.state.playing) void this.refreshFrame();
  }

  // -------------------------------------------------------------------------
  // Schreiben: serielle Warteschlange und Verlauf (Story 20.3)
  // -------------------------------------------------------------------------

  /** Führt einen schreibenden Schritt in der Warteschlange aus; danach prüft der Store auf Fremdänderungen. */
  private write<T>(task: () => Promise<T>, fallback: T): Promise<T> {
    this.set({ busy: true });
    const result = this.queue.run(async () => {
      try {
        return await task();
      } catch (error) {
        this.fail(error);
        return fallback;
      }
    });
    void this.queue.idle().then(() => {
      if (this.queue.pending > 0) return;
      this.set({ busy: false });
      if (this.revisions.pending()) void this.applyForeignChange();
    });
    return result;
  }

  private syncHistory(): void {
    this.set({ canUndo: this.history.canUndo, canRedo: this.history.canRedo });
  }

  /** Schickt Patches an den Server (ohne Warteschlange; nur aus `write` aufrufen). */
  private async sendPatches(patches: readonly PatchJson[]): Promise<PatchJson[] | undefined> {
    const r = await call('composition.patch', { ...this.input, patches });
    if (r['ok'] !== true) {
      const first = toDiagnostics(r['diagnostics']).find((d) => d.severity === 'error');
      this.set({ message: { kind: 'error', text: first !== undefined ? `${first.code}: ${first.problem}` : 'The change was rejected.' } });
      return undefined;
    }
    return records(r['inverse']);
  }

  /** Ersetzt die IR über `project.update` (ohne Warteschlange). */
  private async sendProject(project: Readonly<Rec>): Promise<boolean> {
    const r = await call('project.update', { ...this.input, project });
    const diagnostics = toDiagnostics(r['diagnostics']);
    if (r['ok'] !== true) {
      this.set({ diagnostics, bottomTab: 'diagnostics', message: { kind: 'error', text: `Not saved: ${String(diagnostics.filter((d) => d.severity === 'error').length)} error(s). See Diagnostics.` } });
      return false;
    }
    return true;
  }

  /**
   * Schickt Patches an `composition.patch`. Erfolgreiche Änderungen landen mit ihren
   * `inverse`-Patches auf dem Undo-Stapel. Gleiche `mergeKey` innerhalb einer Sekunde ergeben einen Schritt.
   */
  patch(patches: readonly PatchJson[] | (() => readonly PatchJson[]), options: { readonly mergeKey?: string } = {}): Promise<boolean> {
    this.endPreview();
    if (typeof patches !== 'function' && patches.length === 0) {
      if (this.state.image?.preview === true) void this.refreshFrame();
      return Promise.resolve(false);
    }
    return this.write(async () => {
      // Relative Änderungen (Nudges, Verschieben) rechnen erst hier, auf dem Stand nach allen früheren Schritten.
      const list = typeof patches === 'function' ? patches() : patches;
      if (list.length === 0) {
        if (this.state.image?.preview === true) await this.refreshFrame();
        return false;
      }
      const inverse = await this.sendPatches(list);
      if (inverse === undefined) {
        // Das Vorschaubild zeigt vielleicht einen abgelehnten Stand.
        if (this.state.image?.preview === true) await this.refreshFrame();
        return false;
      }
      this.history.record({ kind: 'patches', patches: inverse }, options.mergeKey, performance.now());
      this.set({ message: undefined });
      this.syncHistory();
      await this.reload();
      return true;
    }, false);
  }

  /** Führt einen Verlaufsschritt aus und liefert seine Umkehrung. */
  private async applyEntry(entry: HistoryEntry): Promise<HistoryEntry | undefined> {
    if (entry.kind === 'patches') {
      const inverse = await this.sendPatches(entry.patches);
      return inverse !== undefined ? { kind: 'patches', patches: inverse } : undefined;
    }
    const before = this.state.project;
    if (before === undefined || !(await this.sendProject(entry.project))) return undefined;
    return { kind: 'project', project: before };
  }

  /** Macht die letzte Änderung rückgängig. */
  undo(): Promise<void> {
    return this.write(async () => {
      const entry = this.history.popUndo();
      if (entry === undefined) return;
      const inverse = await this.applyEntry(entry);
      if (inverse === undefined) this.history.restore('undo', entry);
      else this.history.pushRedo(inverse);
      this.syncHistory();
      if (inverse !== undefined) await this.reload();
    }, undefined);
  }

  /** Stellt die zuletzt rückgängig gemachte Änderung wieder her. */
  redo(): Promise<void> {
    return this.write(async () => {
      const entry = this.history.popRedo();
      if (entry === undefined) return;
      const inverse = await this.applyEntry(entry);
      if (inverse === undefined) this.history.restore('redo', entry);
      else this.history.pushUndo(inverse);
      this.syncHistory();
      if (inverse !== undefined) await this.reload();
    }, undefined);
  }

  /** Speichert den Code-Editor über `project.update`; der alte Stand wird ein Undo-Schritt. */
  saveCode(text: string): Promise<boolean> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      this.set({ message: { kind: 'error', text: `project.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` } });
      return Promise.resolve(false);
    }
    if (!isRecord(parsed)) {
      this.set({ message: { kind: 'error', text: 'project.json must contain a JSON object.' } });
      return Promise.resolve(false);
    }
    const project = parsed;
    return this.write(async () => {
      const before = this.state.project;
      if (!(await this.sendProject(project))) return false;
      if (before !== undefined) this.history.record({ kind: 'project', project: before });
      this.codeDraft = undefined;
      this.set({ draftConflict: false, message: { kind: 'info', text: 'Saved project.json.' } });
      this.syncHistory();
      await this.reload();
      return true;
    }, false);
  }

  // -------------------------------------------------------------------------
  // Bearbeiten
  // -------------------------------------------------------------------------

  /** Szenenbaum-Knoten per ID. */
  treeNode(id: string): TreeNode | undefined {
    return flattenTree(this.state.tree).find((n) => n.id === id);
  }

  /**
   * Lokaler Frame einer Node am aktuellen Frame: aus dem Szenenbaum (berücksichtigt Tempo, Schleifen),
   * solange er zum aktuellen Frame gehört, sonst aus dem Zeitfenster der Timeline.
   */
  localFrame(id: string): number {
    const fromTree = this.state.treeFrame === this.state.frame ? this.treeNode(id)?.localFrame : undefined;
    const start = this.state.timeline?.nodes.find((n) => n.id === id)?.start ?? 0;
    return Math.max(0, Math.round(fromTree ?? this.state.frame - start));
  }

  /** Wert einer (vielleicht animierten) Property einer Node am aktuellen Frame. */
  valueOf(id: string, value: unknown): unknown {
    const item = this.state.timeline?.nodes.find((n) => n.id === id);
    return valueAt(value, this.localFrame(id), this.state.timeline?.fps ?? 30, item !== undefined ? item.end - item.start : this.durationFrames);
  }

  /** Patches, die Nodes verschieben; animierte Positionen bekommen einen Keyframe. */
  movePatches(deltas: ReadonlyMap<string, Delta>): { patches: PatchJson[]; skipped: string[] } {
    const patches: PatchJson[] = [];
    const skipped: string[] = [];
    for (const [id, d] of deltas) {
      const loc = findNode(this.state.comp, id);
      if (loc === undefined) continue;
      const local = this.localFrame(id);
      for (const [axis, delta] of [['x', d.dx] as const, ['y', d.dy] as const]) {
        if (Math.abs(delta) < 0.005) continue;
        const current = loc.node[axis];
        const base = num(this.valueOf(id, current), 0);
        const next = setNumberAt(id, axis, current, base + delta, local);
        if (next === undefined) skipped.push(`${id}.${axis}`);
        else patches.push(...next);
      }
    }
    return { patches, skipped };
  }

  /** Verschiebt Nodes (Composition-Pixel); animierte Positionen bekommen einen Keyframe. */
  async moveNodes(deltas: ReadonlyMap<string, Delta>, options: { readonly mergeKey?: string } = {}): Promise<boolean> {
    return this.patch(() => {
      const { patches, skipped } = this.movePatches(deltas);
      if (skipped.length > 0) this.notify('error', `Not moved: ${skipped.join(', ')} use an expression or spring. Edit them in the Code panel.`);
      return patches;
    }, options);
  }

  /** Pfeiltasten-Nudge: kurz hintereinander ergeben alle Nudges derselben Auswahl einen Undo-Schritt. */
  nudge(dx: number, dy: number): Promise<boolean> {
    const ids = topLevel(this.state.comp, this.state.selection);
    return this.moveNodes(new Map(ids.map((id) => [id, { dx, dy }])), { mergeKey: `nudge:${ids.join(',')}` });
  }

  /** Patches für eine neue Größe (Welt-Box `from` → `to`) oder eine Meldung. */
  resizeNodePatches(id: string, from: Box, to: Box): PatchJson[] | string {
    const node = findNode(this.state.comp, id)?.node;
    if (node === undefined) return `Node "${id}" was not found.`;
    return resizePatches(node, from, to, this.localFrame(id), (v) => this.valueOf(id, v));
  }

  /** Patches für eine Drehung um den Zeigerwinkel. */
  rotatePatches(id: string, startAngle: number, angle: number, snap: boolean): PatchJson[] | string {
    const node = findNode(this.state.comp, id)?.node;
    if (node === undefined) return `Node "${id}" was not found.`;
    const current = num(this.valueOf(id, node['rotation']), 0);
    const next = setNumberAt(id, 'rotation', node['rotation'], rotateBy(current, startAngle, angle, snap), this.localFrame(id));
    return next ?? `${id}.rotation uses an expression or spring; edit it in the Code panel.`;
  }

  private selectedBoxes(): Map<string, Box> {
    const boxes = new Map<string, Box>();
    for (const id of topLevel(this.state.comp, this.state.selection)) {
      const b = this.treeNode(id)?.bounds;
      if (b !== undefined) boxes.set(id, b);
    }
    return boxes;
  }

  /** Richtet die Auswahl aus (mindestens zwei Nodes). */
  async align(mode: AlignMode): Promise<void> {
    const boxes = this.selectedBoxes();
    if (boxes.size < 2) {
      this.notify('info', 'Select at least two nodes to align.');
      return;
    }
    await this.moveNodes(alignDeltas(boxes, mode));
  }

  /** Verteilt die Auswahl (mindestens drei Nodes). */
  async distribute(axis: 'horizontal' | 'vertical'): Promise<void> {
    const boxes = this.selectedBoxes();
    if (boxes.size < 3) {
      this.notify('info', 'Select at least three nodes to distribute.');
      return;
    }
    await this.moveNodes(distributeDeltas(boxes, axis));
  }

  /** Kopiert die Auswahl; liefert den Text für die System-Zwischenablage (oder `undefined`). */
  copy(): string | undefined {
    const ids = topLevel(this.state.comp, this.state.selection);
    const nodes = ids.map((id) => findNode(this.state.comp, id)?.node).filter(isRecord).map((n) => rec(JSON.parse(JSON.stringify(n))));
    if (nodes.length === 0) return undefined;
    this.clipboard = nodes;
    this.notify('info', `Copied ${String(nodes.length)} node(s).`);
    return clipboardText(nodes);
  }

  /** Kopiert und löscht die Auswahl. */
  async cut(): Promise<string | undefined> {
    const text = this.copy();
    if (text !== undefined) await this.deleteSelection();
    return text;
  }

  /** Fügt Nodes ein: aus Text der System-Zwischenablage, sonst aus der Studio-Zwischenablage (um 20 px versetzt). */
  async paste(text?: string): Promise<void> {
    const fromSystem = text !== undefined ? parseClipboard(text) : undefined;
    const nodes = fromSystem ?? this.clipboard;
    if (nodes.length === 0) return;
    await this.insertCopies(nodes.map((node) => ({ node, parentId: null, index: undefined })));
  }

  /** Dupliziert die Auswahl direkt hinter dem Original. */
  async duplicate(): Promise<void> {
    const items: { node: Rec; parentId: string | null; index: number | undefined }[] = [];
    for (const id of topLevel(this.state.comp, this.state.selection)) {
      const loc = findNode(this.state.comp, id);
      if (loc !== undefined) items.push({ node: loc.node, parentId: loc.parentId, index: loc.index + 1 });
    }
    await this.insertCopies(items);
  }

  private async insertCopies(items: readonly { node: Readonly<Rec>; parentId: string | null; index: number | undefined }[]): Promise<void> {
    if (items.length === 0) return;
    const taken = allIds(this.state.comp);
    const patches: PatchJson[] = [];
    const created: string[] = [];
    items.forEach((item, i) => {
      // Freie IDs bleiben (z. B. nach Ausschneiden oder aus einem Editor eingefügt); sonst neue mit „-copy“.
      const ids = [...allIds({ nodes: [item.node] })];
      const free = ids.every((id) => !taken.has(id));
      const copy = free ? rec(JSON.parse(JSON.stringify(item.node))) : cloneWithNewIds(item.node, taken);
      if (free) for (const id of ids) taken.add(id);
      if (typeof copy['x'] === 'number' || copy['x'] === undefined) copy['x'] = num(copy['x'], 0) + 20;
      if (typeof copy['y'] === 'number' || copy['y'] === undefined) copy['y'] = num(copy['y'], 0) + 20;
      created.push(str(copy['id'], ''));
      patches.push({ op: 'addNode', parentId: item.parentId, node: copy, ...(item.index !== undefined ? { index: item.index + i } : {}) });
    });
    if (await this.patch(patches)) this.select(created);
  }

  /** Löscht die Auswahl. */
  async deleteSelection(): Promise<void> {
    const ids = topLevel(this.state.comp, this.state.selection);
    if (ids.length === 0) return;
    if (await this.patch(ids.map((nodeId) => ({ op: 'removeNode', nodeId })))) this.select([]);
  }

  /** Fasst die Auswahl in einer neuen Gruppe zusammen (an der Stelle der ersten Node). */
  async group(): Promise<void> {
    const ids = topLevel(this.state.comp, this.state.selection);
    const first = ids[0] !== undefined ? findNode(this.state.comp, ids[0]) : undefined;
    if (first === undefined) return;
    const groupId = uniqueId('group', allIds(this.state.comp));
    const patches: PatchJson[] = [{ op: 'addNode', parentId: first.parentId, index: first.index, node: { id: groupId, type: 'group' } }];
    for (const nodeId of ids) patches.push({ op: 'moveNode', nodeId, parentId: groupId });
    if (await this.patch(patches)) this.select([groupId]);
  }

  /** Löst die gewählten Gruppen auf (Story 20.6). */
  async ungroup(): Promise<void> {
    const groups = topLevel(this.state.comp, this.state.selection).filter((id) => ['group', 'layer'].includes(str(findNode(this.state.comp, id)?.node['type'], '')));
    if (groups.length === 0) {
      this.notify('info', 'Select a group to ungroup.');
      return;
    }
    const patches: PatchJson[] = [];
    const children: string[] = [];
    for (const id of groups) {
      const r = ungroupPatches(this.state.comp, id);
      if (typeof r === 'string') {
        this.notify('error', r);
        return;
      }
      patches.push(...r.patches);
      children.push(...r.children);
    }
    // Mehrere Gruppen: jede Gruppe für sich (Indizes beziehen sich auf den jeweiligen Stand).
    if (groups.length > 1) {
      for (const id of groups) {
        const r = ungroupPatches(this.state.comp, id);
        if (typeof r !== 'string' && !(await this.patch(r.patches))) return;
      }
      this.select(children);
      return;
    }
    if (await this.patch(patches)) this.select(children);
  }

  /** Ebenen-Befehl für die Auswahl (Story 20.6, siehe `layers.ts` zur Rolle von `zIndex`). */
  async arrange(command: LayerCommand): Promise<void> {
    const ids = topLevel(this.state.comp, this.state.selection);
    if (ids.length === 0) return;
    // Nach vorn: die vorderste zuerst, damit die Reihenfolge der Auswahl erhalten bleibt.
    const ordered = command === 'front' || command === 'forward' ? [...ids].reverse() : ids;
    for (const id of ordered) {
      const loc = findNode(this.state.comp, id);
      if (loc === undefined) continue;
      const r = layerPatches(
        siblingsOf(this.state.comp, id, (v, n) => this.valueOf(str(n['id'], ''), v)),
        loc.parentId,
        id,
        command,
      );
      if (typeof r === 'string') {
        this.notify('error', r);
        return;
      }
      if (r.length > 0 && !(await this.patch(r))) return;
    }
  }

  /** Legt eine neue Node an (oberste Ebene) und wählt sie. */
  async addNode(node: Rec): Promise<void> {
    const id = uniqueId(str(node['id'], str(node['type'], 'node')), allIds(this.state.comp));
    if (await this.patch([{ op: 'addNode', parentId: null, node: { ...node, id } }])) this.select([id]);
  }

  /** Setzt eine Property auf allen gewählten Nodes (Mehrfachbearbeitung, ein Undo-Schritt). */
  async setOnSelection(property: string, value: unknown): Promise<void> {
    const targets = this.state.selection
      .map((id) => ({ id, node: findNode(this.state.comp, id)?.node, local: this.localFrame(id) }))
      .filter((t): t is { id: string; node: Rec; local: number } => t.node !== undefined);
    const { patches, skipped } = multiSetPatches(targets, property, value);
    if (skipped.length > 0) this.notify('error', `Not changed: ${skipped.map((s) => `${s}.${property}`).join(', ')} use an expression or spring.`);
    await this.patch(patches);
  }

  /** Setzt eine Composition-Property (z. B. Marker oder Tracks). */
  async setCompositionProperty(property: string, value: unknown): Promise<boolean> {
    return this.patch([{ op: 'setCompositionProperty', compositionId: str(this.state.comp?.['id'], 'main'), property, value }]);
  }

  /** Legt einen Marker am aktuellen Frame an. */
  async addMarker(): Promise<void> {
    await this.setCompositionProperty('markers', addMarker(records(this.state.comp?.['markers']), this.state.frame));
  }

  /** Verschiebt einen Marker auf einen Frame. */
  async moveMarker(id: string, frame: number): Promise<void> {
    const markers = records(this.state.comp?.['markers']).map((m) => (m['id'] === id ? { ...m, time: Math.max(0, Math.round(frame)) } : m));
    await this.setCompositionProperty('markers', markers);
  }

  /** Benennt einen Marker um (Label; die ID bleibt). */
  async renameMarker(id: string, label: string): Promise<void> {
    await this.setCompositionProperty('markers', renameMarker(records(this.state.comp?.['markers']), id, label));
  }

  /** Löscht einen Marker, wenn keine Zeit mehr auf ihn verweist. */
  async deleteMarker(id: string): Promise<void> {
    const r = removeMarker(records(this.state.comp?.['markers']), id, this.state.comp);
    if (typeof r === 'string') {
      this.notify('error', r);
      return;
    }
    await this.setCompositionProperty('markers', r.length > 0 ? r : null);
  }

  /** Verschiebt einen Keyframe (Index) einer Property auf einen Composition-Frame. */
  async moveKeyframe(id: string, property: string, index: number, frame: number): Promise<void> {
    const node = findNode(this.state.comp, id)?.node;
    const item = this.state.timeline?.nodes.find((n) => n.id === id);
    if (node === undefined || item === undefined) return;
    const next = moveKeyframe(node[property], index, frame - item.start, timeInfo(this.state.comp));
    if (next === undefined) {
      this.notify('info', 'There is already a keyframe at that frame.');
      return;
    }
    await this.patch([{ op: 'setProperty', nodeId: id, property, value: next }]);
  }

  /** Springt zum nächsten/vorherigen Keyframe der Auswahl (ohne Auswahl: aller Nodes). */
  jumpKeyframe(dir: 1 | -1): void {
    const nodes = this.state.timeline?.nodes ?? [];
    const chosen = this.state.selection.length > 0 ? nodes.filter((n) => this.state.selection.includes(n.id)) : nodes;
    const f = keyframeJump(
      chosen.flatMap((n) => n.animated.map((a) => a.keyframes)),
      this.state.frame,
      dir,
    );
    if (f !== undefined) this.seek(f);
  }

  /** Verschiebt oder trimmt das Zeitfenster einer Node (in Frames). */
  async retime(id: string, edit: { readonly move?: number; readonly trimStart?: number; readonly trimEnd?: number }): Promise<void> {
    await this.patch(() => this.retimePatches(id, edit), { mergeKey: `retime:${id}` });
  }

  /** Patches für {@link retime} auf dem aktuellen Stand. */
  private retimePatches(id: string, edit: { readonly move?: number; readonly trimStart?: number; readonly trimEnd?: number }): PatchJson[] {
    const loc = findNode(this.state.comp, id);
    const item = this.state.timeline?.nodes.find((n) => n.id === id);
    if (loc === undefined || item === undefined) return [];
    const time = timeInfo(this.state.comp);
    const timing = rec(loc.node['timing']);
    const from = frames(timing['from'], time, 0);
    const length = item.end - item.start;
    const patches: PatchJson[] = [];
    if (edit.move !== undefined && edit.move !== 0) patches.push({ op: 'setProperty', nodeId: id, property: 'timing.from', value: Math.round(from + edit.move) });
    if (edit.trimStart !== undefined && edit.trimStart !== 0) {
      const d = Math.max(-from, Math.min(edit.trimStart, length - 1));
      patches.push({ op: 'setProperty', nodeId: id, property: 'timing.from', value: Math.round(from + d) }, { op: 'setProperty', nodeId: id, property: 'timing.duration', value: Math.max(1, Math.round(length - d)) });
    }
    if (edit.trimEnd !== undefined && edit.trimEnd !== 0) patches.push({ op: 'setProperty', nodeId: id, property: 'timing.duration', value: Math.max(1, Math.round(length + edit.trimEnd)) });
    return patches;
  }

  // -------------------------------------------------------------------------
  // Audio-Spuren (Story 20.7)
  // -------------------------------------------------------------------------

  /** Legt einen Clip aus einem Audio-Asset an (neue Spur oder `trackId`). */
  async addAudioClip(assetId: string, startFrame: number, trackId?: string): Promise<void> {
    const { patches } = addAudioClipPatches(this.state.project, this.state.comp, assetId, startFrame, trackId);
    await this.patch(patches);
  }

  /** Ändert einen Clip aus der Timeline (verschieben, trimmen, Fades; Frames). */
  async editAudioClip(trackId: string, clipId: string, edit: ClipEdit, lengthFrames: number): Promise<void> {
    await this.patch(() => {
      const time = timeInfo(this.state.comp);
      const tracks = records(this.state.comp?.['tracks']).map((t) =>
        t['id'] !== trackId ? t : { ...t, clips: records(t['clips']).map((c) => (c['id'] === clipId ? editClip(c, edit, time, lengthFrames) : c)) },
      );
      return [{ op: 'setCompositionProperty', compositionId: str(this.state.comp?.['id'], 'main'), property: 'tracks', value: tracks }];
    }, { mergeKey: `clip:${trackId}/${clipId}` });
  }

  /** Setzt ein Feld eines Clips (`null` entfernt es). */
  async setClipField(trackId: string, clipId: string, key: string, value: unknown): Promise<void> {
    const tracks = records(this.state.comp?.['tracks']).map((t) =>
      t['id'] !== trackId ? t : { ...t, clips: records(t['clips']).map((c) => (c['id'] === clipId ? (value === null ? Object.fromEntries(Object.entries(c).filter(([k]) => k !== key)) : { ...c, [key]: value }) : c)) },
    );
    await this.setCompositionProperty('tracks', tracks);
  }

  /** Entfernt einen Clip (und eine leere Spur). */
  async removeAudioClip(trackId: string, clipId: string): Promise<void> {
    const tracks = records(this.state.comp?.['tracks'])
      .map((t) => (t['id'] !== trackId ? t : { ...t, clips: records(t['clips']).filter((c) => c['id'] !== clipId) }))
      .filter((t) => t['kind'] !== 'audio' || records(t['clips']).length > 0);
    await this.setCompositionProperty('tracks', tracks.length > 0 ? tracks : null);
  }

  /** Springt im Code-Editor zu einer Diagnose und wählt ihre Node. */
  reveal(target: { readonly nodeId?: string; readonly pointer?: string }): void {
    if (target.nodeId !== undefined && findNode(this.state.comp, target.nodeId) !== undefined) this.select([target.nodeId]);
    const source = target.nodeId !== undefined ? this.treeNode(target.nodeId)?.source : undefined;
    this.set({
      bottomTab: 'code',
      reveal: { ...target, ...(source !== undefined ? { line: source.line } : {}), nonce: (this.state.reveal?.nonce ?? 0) + 1 },
    });
  }

  // -------------------------------------------------------------------------
  // Render Queue
  // -------------------------------------------------------------------------

  private jobLabels(): Record<string, string> {
    const raw = readStorage('session', JOB_LABELS_KEY);
    if (raw === null) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string')) : {};
    } catch {
      return {};
    }
  }

  /** Startet einen Render-Job; mit `useRange` nur den In/Out-Bereich (Preview). */
  async startRender(preset: RenderPreset, useRange = false): Promise<void> {
    try {
      const range = useRange && preset.operation === 'preview.render' && (this.state.inPoint !== undefined || this.state.outPoint !== undefined) ? { start: this.state.inPoint ?? 0, end: (this.state.outPoint ?? this.durationFrames - 1) + 1 } : {};
      const r = await call(preset.operation, { ...this.input, ...preset.input, ...range });
      const id = str(r['jobId'], '');
      writeStorage('session', JOB_LABELS_KEY, JSON.stringify({ ...this.jobLabels(), [id]: preset.label }));
      this.set({ jobs: [parseJob({ id, state: r['state'] }, preset.label), ...this.state.jobs] });
      this.pollJobs();
    } catch (error) {
      this.fail(error);
    }
  }

  /** Stellt die Render Queue nach dem Neuladen wieder her (`render.status` ohne jobId). */
  async restoreJobs(): Promise<void> {
    try {
      const r = await call('render.status', this.input);
      const labels = this.jobLabels();
      const known = new Set(this.state.jobs.map((j) => j.id));
      const restored = records(r['jobs'])
        .filter((j) => !known.has(str(j['id'], '')))
        .map((j) => parseJob(j, labels[str(j['id'], '')] ?? (j['kind'] === 'preview.render' ? 'Preview' : 'Video')));
      if (restored.length === 0) return;
      this.set({ jobs: [...this.state.jobs, ...restored] });
      this.pollJobs();
    } catch (error) {
      // Ältere Server kennen die Liste nicht; die Queue bleibt dann leer.
      if (!(error instanceof ApiError)) this.fail(error);
    }
  }

  /** Bricht einen Job ab. */
  async cancelJob(id: string): Promise<void> {
    try {
      const r = await call('render.cancel', { jobId: id });
      this.updateJob(r);
    } catch (error) {
      this.fail(error);
    }
  }

  private updateJob(value: Rec): void {
    this.set({ jobs: this.state.jobs.map((j) => (j.id === value['id'] ? parseJob(value, j.label) : j)) });
  }

  private pollJobs(): void {
    if (this.jobTimer !== undefined) return;
    this.jobTimer = setInterval(() => {
      const active = this.state.jobs.filter((j) => j.state === 'queued' || j.state === 'running');
      if (active.length === 0) {
        clearInterval(this.jobTimer);
        this.jobTimer = undefined;
        return;
      }
      for (const job of active) {
        call('render.status', { jobId: job.id })
          .then((r) => {
            this.updateJob(r);
          })
          .catch((error: unknown) => {
            if (error instanceof ApiError) this.updateJob({ id: job.id, state: 'failed', error: error.diagnostic });
            else this.fail(error);
          });
      }
    }, 400);
  }

  /** Alle Nodes der IR mit Tiefe (für Listen). */
  nodeList(): { id: string; type: string; depth: number }[] {
    const out: { id: string; type: string; depth: number }[] = [];
    walkNodes(this.state.comp?.['nodes'], (node, where) => out.push({ id: str(node['id'], ''), type: str(node['type'], ''), depth: where.depth }));
    return out;
  }
}
