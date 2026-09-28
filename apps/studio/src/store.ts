/**
 * Zustand des Studios. Die Wahrheit liegt auf dem Server: Der Store lädt die IR,
 * schickt jede Änderung als Patch und hält nur Ansichtszustand (Auswahl, Frame, Zoom, Undo-Stapel).
 */
import { isRecord, type Diagnostic } from '@agentic-video/core';
import { ApiError, call, errorText, fetchText } from './api.js';
import { alignDeltas, distributeDeltas, type AlignMode, type Box, type Delta } from './geometry.js';
import { allIds, cloneWithNewIds, findNode, frames, setNumberAt, timeInfo, topLevel, uniqueId, valueAt, walkNodes } from './ir.js';
import { num, rec, records, str, toDiagnostic, toDiagnostics, type PatchJson, type Rec } from './json.js';

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

/** Gesamter Zustand. */
export interface StudioState {
  readonly projectId: string;
  readonly kind: 'json' | 'tsx';
  readonly entry: string;
  readonly project: Rec | undefined;
  readonly projectText: string;
  readonly sourceText: string | undefined;
  readonly comp: Rec | undefined;
  readonly frame: number;
  readonly playing: boolean;
  readonly exact: boolean;
  readonly selection: readonly string[];
  readonly tree: readonly TreeNode[];
  /** Frame, zu dem `tree` gehört (während eines Sprungs kann der Baum noch vom alten Frame sein). */
  readonly treeFrame: number;
  readonly timeline: TimelineInfo | undefined;
  readonly diagnostics: readonly Diagnostic[];
  readonly image: { readonly src: string; readonly frame: number } | undefined;
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

function parseTimeline(value: Rec): TimelineInfo {
  return {
    fps: num(value['fps'], 30),
    durationFrames: num(value['durationFrames'], 1),
    markers: records(value['markers']).map((m) => ({ id: str(m['id'], ''), frame: num(m['frame'], 0), label: str(m['id'], '') })),
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
  private undoStack: PatchJson[][] = [];
  private redoStack: PatchJson[][] = [];
  private imageSeq = 0;
  private treeSeq = 0;
  private diagTimer: ReturnType<typeof setTimeout> | undefined;
  private jobTimer: ReturnType<typeof setInterval> | undefined;
  private clipboard: Rec[] = [];
  /** Ungespeicherter Text des Code-Editors (überlebt Tab-Wechsel). */
  codeDraft: string | undefined;

  constructor(projectId: string) {
    this.state = {
      projectId,
      kind: 'json',
      entry: 'project.json',
      project: undefined,
      projectText: '',
      sourceText: undefined,
      comp: undefined,
      frame: 0,
      playing: false,
      exact: false,
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
    };
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

  private get input(): Rec {
    return { projectId: this.state.projectId };
  }

  /** Länge der Composition in Frames. */
  get durationFrames(): number {
    return Math.max(1, this.state.timeline?.durationFrames ?? 1);
  }

  /** Lädt Projekt, IR, Timeline und den aktuellen Frame. */
  async load(): Promise<void> {
    try {
      const info = await call('project.inspect', this.input);
      this.set({ kind: info['kind'] === 'tsx' ? 'tsx' : 'json', entry: str(info['entry'], 'project.json') });
      await this.reload();
    } catch (error) {
      this.fail(error);
    }
  }

  /** Lädt alles nach einer Änderung neu. */
  async reload(): Promise<void> {
    const [comp, timeline, projectText] = await Promise.all([call('composition.get', this.input), call('timeline.inspect', this.input), fetchText(this.state.projectId, 'project.json')]);
    let project: Rec | undefined;
    try {
      const parsed: unknown = JSON.parse(projectText);
      project = isRecord(parsed) ? parsed : undefined;
    } catch (error) {
      this.fail(error);
    }
    const sourceText = this.state.kind === 'tsx' ? await fetchText(this.state.projectId, this.state.entry) : undefined;
    const ids = allIds(comp);
    const parsedTimeline = parseTimeline(timeline);
    this.set({
      comp,
      project,
      projectText,
      sourceText,
      timeline: parsedTimeline,
      frame: Math.min(this.state.frame, Math.max(0, parsedTimeline.durationFrames - 1)),
      selection: this.state.selection.filter((id) => ids.has(id)),
    });
    await this.refreshFrame();
    this.scheduleDiagnostics(0);
  }

  /** Skalierung für `frame.render`: Auflösungswahl, aber nicht größer als der Zoom braucht. */
  renderScale(): number {
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    const needed = Math.ceil(this.state.zoom * dpr * 20) / 20;
    return Math.max(0.05, Math.min(this.state.resolution, needed));
  }

  private async renderImage(frame: number): Promise<void> {
    const seq = ++this.imageSeq;
    const r = await call('frame.render', {
      ...this.input,
      frame,
      scale: this.renderScale(),
      inline: true,
      ...(this.state.debug ? { debug: { showBounds: true, showAnchors: true, showNodeIds: true } } : {}),
    });
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
    if (f === this.state.frame && this.state.image?.frame === f) return;
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

  /** Startet oder stoppt die Wiedergabe. */
  togglePlay(): void {
    if (this.state.playing) {
      this.set({ playing: false });
      return;
    }
    this.set({ playing: true });
    void this.playLoop();
  }

  /**
   * Wiedergabe als fortlaufende Frame-Anfragen. Die Rate folgt der Antwortzeit:
   * Normal werden Frames übersprungen, um Echtzeit zu halten; „Exact“ zeigt jeden Frame.
   */
  private async playLoop(): Promise<void> {
    const fps = this.state.timeline?.fps ?? 30;
    const frameMs = 1000 / fps;
    try {
      while (this.isPlaying()) {
        const started = performance.now();
        const frame = this.state.frame;
        await this.renderImage(frame);
        const elapsed = performance.now() - started;
        if (elapsed < frameMs) await sleep(frameMs - elapsed);
        // Während des Wartens kann Pause gedrückt worden sein.
        if (!this.isPlaying()) break;
        const advance = this.state.exact ? 1 : Math.max(1, Math.round((performance.now() - started) / frameMs));
        this.set({ frame: (frame + advance) % this.durationFrames });
      }
    } catch (error) {
      this.set({ playing: false });
      this.fail(error);
    }
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

  /**
   * Schickt Patches an `composition.patch`. Erfolgreiche Änderungen landen mit ihren
   * `inverse`-Patches auf dem Undo-Stapel.
   */
  async patch(patches: readonly PatchJson[], history: 'record' | 'undo' | 'redo' = 'record'): Promise<boolean> {
    if (patches.length === 0) return false;
    this.set({ busy: true });
    try {
      const r = await call('composition.patch', { ...this.input, patches });
      if (r['ok'] !== true) {
        const first = toDiagnostics(r['diagnostics']).find((d) => d.severity === 'error');
        this.set({ message: { kind: 'error', text: first !== undefined ? `${first.code}: ${first.problem}` : 'The change was rejected.' } });
        return false;
      }
      const inverse = records(r['inverse']);
      if (history === 'undo') this.redoStack.push(inverse);
      else {
        this.undoStack.push(inverse);
        if (history === 'record') this.redoStack = [];
      }
      this.set({ canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0, message: undefined });
      await this.reload();
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    } finally {
      this.set({ busy: false });
    }
  }

  /** Macht die letzte Änderung rückgängig. */
  async undo(): Promise<void> {
    const inverse = this.undoStack.pop();
    if (inverse === undefined) return;
    const ok = await this.patch(inverse, 'undo');
    if (!ok) this.undoStack.push(inverse);
    this.set({ canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 });
  }

  /** Stellt die zuletzt rückgängig gemachte Änderung wieder her. */
  async redo(): Promise<void> {
    const inverse = this.redoStack.pop();
    if (inverse === undefined) return;
    const ok = await this.patch(inverse, 'redo');
    if (!ok) this.redoStack.push(inverse);
    this.set({ canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 });
  }

  /** Speichert den Code-Editor über `project.update`. */
  async saveCode(text: string): Promise<boolean> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      this.set({ message: { kind: 'error', text: `project.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}` } });
      return false;
    }
    if (!isRecord(parsed)) {
      this.set({ message: { kind: 'error', text: 'project.json must contain a JSON object.' } });
      return false;
    }
    try {
      const r = await call('project.update', { ...this.input, project: parsed });
      const diagnostics = toDiagnostics(r['diagnostics']);
      if (r['ok'] !== true) {
        this.set({ diagnostics, bottomTab: 'diagnostics', message: { kind: 'error', text: `Not saved: ${String(diagnostics.filter((d) => d.severity === 'error').length)} error(s). See Diagnostics.` } });
        return false;
      }
      // Ein Code-Stand ersetzt die ganze IR; alte Inverse passen nicht mehr.
      this.codeDraft = undefined;
      this.undoStack = [];
      this.redoStack = [];
      this.set({ canUndo: false, canRedo: false, message: { kind: 'info', text: 'Saved project.json.' } });
      await this.reload();
      return true;
    } catch (error) {
      this.fail(error);
      return false;
    }
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

  /** Verschiebt Nodes (Composition-Pixel); animierte Positionen bekommen einen Keyframe. */
  async moveNodes(deltas: ReadonlyMap<string, Delta>): Promise<boolean> {
    const patches: PatchJson[] = [];
    const skipped: string[] = [];
    for (const [id, d] of deltas) {
      const loc = findNode(this.state.comp, id);
      if (loc === undefined) continue;
      const local = this.localFrame(id);
      const item = this.state.timeline?.nodes.find((n) => n.id === id);
      const fps = this.state.timeline?.fps ?? 30;
      for (const [axis, delta] of [['x', d.dx] as const, ['y', d.dy] as const]) {
        if (Math.abs(delta) < 0.005) continue;
        const current = loc.node[axis];
        const base = num(valueAt(current, local, fps, item !== undefined ? item.end - item.start : this.durationFrames), 0);
        const next = setNumberAt(id, axis, current, base + delta, local);
        if (next === undefined) skipped.push(`${id}.${axis}`);
        else patches.push(...next);
      }
    }
    if (skipped.length > 0) this.notify('error', `Not moved: ${skipped.join(', ')} use an expression or spring. Edit them in the Code panel.`);
    return this.patch(patches);
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

  /** Kopiert die Auswahl in die Zwischenablage des Studios. */
  copy(): void {
    const ids = topLevel(this.state.comp, this.state.selection);
    this.clipboard = ids.map((id) => findNode(this.state.comp, id)?.node).filter(isRecord).map((n) => rec(JSON.parse(JSON.stringify(n))));
    if (this.clipboard.length > 0) this.notify('info', `Copied ${String(this.clipboard.length)} node(s).`);
  }

  /** Fügt die Zwischenablage mit neuen IDs ein (um 20 px versetzt). */
  async paste(): Promise<void> {
    if (this.clipboard.length === 0) return;
    await this.insertCopies(this.clipboard.map((node) => ({ node, parentId: null, index: undefined })));
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
      const copy = cloneWithNewIds(item.node, taken);
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

  /** Legt eine neue Node an (oberste Ebene) und wählt sie. */
  async addNode(node: Rec): Promise<void> {
    const id = uniqueId(str(node['id'], str(node['type'], 'node')), allIds(this.state.comp));
    if (await this.patch([{ op: 'addNode', parentId: null, node: { ...node, id } }])) this.select([id]);
  }

  /** Setzt eine Composition-Property (z. B. Marker oder Tracks). */
  async setCompositionProperty(property: string, value: unknown): Promise<boolean> {
    return this.patch([{ op: 'setCompositionProperty', compositionId: str(this.state.comp?.['id'], 'main'), property, value }]);
  }

  /** Legt einen Marker am aktuellen Frame an. */
  async addMarker(): Promise<void> {
    const markers = records(this.state.comp?.['markers']);
    const taken = new Set(markers.map((m) => str(m['id'], '')));
    await this.setCompositionProperty('markers', [...markers, { id: uniqueId('marker', taken), time: this.state.frame }]);
  }

  /** Verschiebt einen Marker auf einen Frame. */
  async moveMarker(id: string, frame: number): Promise<void> {
    const markers = records(this.state.comp?.['markers']).map((m) => (m['id'] === id ? { ...m, time: Math.max(0, Math.round(frame)) } : m));
    await this.setCompositionProperty('markers', markers);
  }

  /** Verschiebt oder trimmt das Zeitfenster einer Node (in Frames). */
  async retime(id: string, edit: { readonly move?: number; readonly trimStart?: number; readonly trimEnd?: number }): Promise<void> {
    const loc = findNode(this.state.comp, id);
    const item = this.state.timeline?.nodes.find((n) => n.id === id);
    if (loc === undefined || item === undefined) return;
    const time = timeInfo(this.state.comp);
    const timing = rec(loc.node['timing']);
    const from = frames(timing['from'], time, 0);
    const length = item.end - item.start;
    const patches: PatchJson[] = [];
    if (edit.move !== undefined && edit.move !== 0) patches.push({ op: 'setProperty', nodeId: id, property: 'timing.from', value: Math.round(from + edit.move) });
    if (edit.trimStart !== undefined && edit.trimStart !== 0) {
      const d = Math.min(edit.trimStart, length - 1);
      patches.push({ op: 'setProperty', nodeId: id, property: 'timing.from', value: Math.round(from + d) }, { op: 'setProperty', nodeId: id, property: 'timing.duration', value: Math.max(1, Math.round(length - d)) });
    }
    if (edit.trimEnd !== undefined && edit.trimEnd !== 0) patches.push({ op: 'setProperty', nodeId: id, property: 'timing.duration', value: Math.max(1, Math.round(length + edit.trimEnd)) });
    await this.patch(patches);
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

  /** Startet einen Render-Job. */
  async startRender(preset: RenderPreset): Promise<void> {
    try {
      const r = await call(preset.operation, { ...this.input, ...preset.input });
      this.set({ jobs: [parseJob({ id: r['jobId'], state: r['state'] }, preset.label), ...this.state.jobs] });
      this.pollJobs();
    } catch (error) {
      this.fail(error);
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
