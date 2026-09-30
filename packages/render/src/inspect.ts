/**
 * Inspektion für Agents (FR-25, FR-26): Szenenbaum, Textbeschreibung, Timeline, Vorab-Prüfung.
 */
import {
  compositionDurationFrames,
  evaluateScene,
  findComposition,
  framesToSmpte,
  isAnimated,
  isRecord,
  resolveMarkers,
  toFrames,
  validateProject,
  walkEvaluated,
  type AssetResolver,
  type Diagnostic,
  type EvaluatedNode,
  type EvaluatedScene,
  type FontResolver,
  type NodeBounds,
  type Registry,
} from '@agentic-video/core';

/** Ein Knoten des Szenenbaums für Agents. */
export interface SceneTreeNode {
  readonly id: string;
  readonly type: string;
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly opacity?: number;
  /** Gesetztes `zIndex` (≠ 0). Die Reihenfolge der Kinder ist bereits die effektive Zeichenreihenfolge. */
  readonly zIndex?: number;
  readonly text?: { readonly content: string; readonly lines?: number; readonly overflow?: boolean };
  readonly source?: { readonly file: string; readonly line: number; readonly column: number };
  readonly localFrame: number;
  readonly children: readonly SceneTreeNode[];
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Baut den Szenenbaum eines Frames mit Bounds.
 *
 * @example
 * ```ts
 * const tree = sceneTree(result.scene, result.bounds);
 * ```
 */
export function sceneTree(scene: EvaluatedScene, bounds: readonly NodeBounds[]): SceneTreeNode[] {
  const byId = new Map(bounds.map((b) => [b.id, b]));
  const map = (n: EvaluatedNode): SceneTreeNode => {
    const b = byId.get(n.id);
    const text = typeof n.props['text'] === 'string' ? n.props['text'] : undefined;
    return {
      id: n.id,
      type: n.type,
      ...(b !== undefined ? { bounds: { x: round(b.bounds.x), y: round(b.bounds.y), width: round(b.bounds.width), height: round(b.bounds.height) }, opacity: round(b.opacity) } : {}),
      ...(typeof n.props['zIndex'] === 'number' && n.props['zIndex'] !== 0 ? { zIndex: n.props['zIndex'] } : {}),
      ...(text !== undefined ? { text: { content: text, ...(b?.text !== undefined ? { lines: b.text.lines, overflow: b.text.overflow } : {}) } } : {}),
      ...(n.source !== undefined ? { source: n.source } : {}),
      localFrame: round(n.time.localFrame),
      children: n.children.map(map),
    };
  };
  return scene.nodes.map(map);
}

/**
 * Beschreibt einen Frame in kurzen Sätzen (für Agents ohne Bildverständnis).
 *
 * @example
 * ```ts
 * describeScene(scene, bounds); // "Frame 120 (4.00 s) of composition main, 1920×1080. …"
 * ```
 */
export function describeScene(scene: EvaluatedScene, bounds: readonly NodeBounds[]): string {
  const lines = [`Frame ${String(scene.frame)} (${scene.time.toFixed(2)} s) of composition ${scene.compositionId}, ${String(scene.width)}×${String(scene.height)}, background ${scene.background}.`];
  const byId = new Map(bounds.map((b) => [b.id, b]));
  let count = 0;
  walkEvaluated(scene.nodes, (n, depth) => {
    count++;
    if (count > 200) return;
    const b = byId.get(n.id);
    const where = b !== undefined ? ` at (${String(Math.round(b.bounds.x))}, ${String(Math.round(b.bounds.y))}) size ${String(Math.round(b.bounds.width))}×${String(Math.round(b.bounds.height))}${b.opacity < 1 ? `, opacity ${b.opacity.toFixed(2)}` : ''}` : '';
    const text = typeof n.props['text'] === 'string' ? ` "${n.props['text'].slice(0, 60)}"` : '';
    lines.push(`${'  '.repeat(depth)}- ${n.type} "${n.id}"${text}${where}`);
  });
  if (count > 200) lines.push(`… ${String(count - 200)} more nodes.`);
  if (scene.diagnostics.length > 0) lines.push(`Diagnostics: ${scene.diagnostics.map((d) => d.code).join(', ')}.`);
  return lines.join('\n');
}

/** Eine animierte Property in der Timeline-Übersicht. */
export interface TimelineProperty {
  readonly property: string;
  readonly kind: 'keyframes' | 'spring' | 'expr' | 'sampled' | 'ref';
  readonly keyframes?: readonly number[];
}

/** Timeline-Eintrag einer Node. */
export interface TimelineNode {
  readonly id: string;
  readonly type: string;
  readonly depth: number;
  readonly start: number;
  readonly end: number;
  readonly animated: readonly TimelineProperty[];
}

/** Timeline-Übersicht einer Composition. */
export interface TimelineInfo {
  readonly compositionId: string;
  readonly fps: number;
  readonly durationFrames: number;
  readonly durationSmpte: string;
  readonly markers: readonly { readonly id: string; readonly frame: number; readonly time: number; readonly smpte: string; readonly kind: string }[];
  readonly nodes: readonly TimelineNode[];
  readonly tracks: readonly { readonly id: string; readonly kind: string; readonly clips: number }[];
}

function animKind(value: Record<string, unknown>): TimelineProperty['kind'] {
  if ('$keyframes' in value) return 'keyframes';
  if ('$spring' in value) return 'spring';
  if ('$expr' in value) return 'expr';
  if ('$sampled' in value) return 'sampled';
  return 'ref';
}

/**
 * Liefert Zeitfenster und animierte Properties aller Nodes (FR-24 `timeline.inspect`).
 *
 * @example
 * ```ts
 * inspectTimeline(project, 'main').nodes.find((n) => n.id === 'headline')?.animated;
 * ```
 */
export function inspectTimeline(project: Readonly<Record<string, unknown>>, compositionId?: string): TimelineInfo {
  const comp = findComposition(project, compositionId);
  const fps = Number(comp['fps']);
  const durationFrames = compositionDurationFrames(comp);
  const markerList = Array.isArray(comp['markers']) ? comp['markers'].filter(isRecord) : [];
  const markers = resolveMarkers(
    markerList.map((m) => ({ id: String(m['id']), time: typeof m['time'] === 'number' ? m['time'] : String(m['time']) })),
    fps,
  );
  const nodes: TimelineNode[] = [];
  const visit = (list: unknown, depth: number, parentStart: number, parentEnd: number): void => {
    if (!Array.isArray(list)) return;
    for (const raw of list.filter(isRecord)) {
      const timing = isRecord(raw['timing']) ? raw['timing'] : {};
      const shifted = new Map([...markers].map(([k, v]) => [k, v - parentStart]));
      const from = typeof timing['from'] === 'number' || typeof timing['from'] === 'string' ? toFrames(timing['from'], { fps, markers: shifted }) : 0;
      const start = parentStart + from;
      const dur = typeof timing['duration'] === 'number' || typeof timing['duration'] === 'string' ? toFrames(timing['duration'], { fps, markers: shifted }) : parentEnd - start;
      const animated: TimelineProperty[] = [];
      for (const [key, value] of Object.entries(raw)) {
        if (key === 'children' || key === 'timing' || !isRecord(value) || !isAnimated(value)) continue;
        const kind = animKind(value);
        const kfs = Array.isArray(value['$keyframes'])
          ? value['$keyframes'].filter(isRecord).map((k) => {
              const t = k['t'];
              return typeof t === 'number' || typeof t === 'string' ? start + toFrames(t, { fps, markers: new Map([...markers].map(([mk, v]) => [mk, v - start])) }) : start;
            })
          : undefined;
        animated.push({ property: key, kind, ...(kfs !== undefined ? { keyframes: kfs } : {}) });
      }
      nodes.push({ id: String(raw['id']), type: String(raw['type']), depth, start, end: Math.min(parentEnd, start + dur), animated });
      visit(raw['children'], depth + 1, start, Math.min(parentEnd, start + dur));
    }
  };
  visit(comp['nodes'], 0, 0, durationFrames);
  const tracks = (Array.isArray(comp['tracks']) ? comp['tracks'].filter(isRecord) : []).map((t) => ({ id: String(t['id']), kind: String(t['kind']), clips: Array.isArray(t['clips']) ? t['clips'].length : Array.isArray(t['cues']) ? t['cues'].length : 0 }));
  return {
    compositionId: String(comp['id']),
    fps,
    durationFrames,
    durationSmpte: framesToSmpte(durationFrames, fps),
    markers: markerList.map((m) => {
      const id = String(m['id']);
      const frame = markers.get(id) ?? 0;
      return { id, frame, time: frame / fps, smpte: framesToSmpte(frame, fps), kind: typeof m['kind'] === 'string' ? m['kind'] : 'marker' };
    }),
    nodes,
    tracks,
  };
}

function walkIr(list: unknown, fn: (node: Record<string, unknown>) => void): void {
  if (!Array.isArray(list)) return;
  for (const n of list.filter(isRecord)) {
    fn(n);
    walkIr(n['children'], fn);
    const mask = n['mask'];
    if (isRecord(mask) && isRecord(mask['node'])) walkIr([mask['node']], fn);
  }
}

/**
 * Vollständige Vorab-Prüfung (FR-4, FR-44): Schema, semantische Regeln, Backend-Fähigkeiten,
 * fehlende Assets und fehlende Schriften.
 *
 * @example
 * ```ts
 * const diagnostics = checkProject({ registry, assets, fonts }, project);
 * ```
 */
export function checkProject(ctx: { readonly registry: Registry; readonly assets?: AssetResolver; readonly fonts?: FontResolver }, project: unknown): Diagnostic[] {
  const components = [...ctx.registry.components.keys()];
  const result = validateProject(project, { extraNodeSchemas: ctx.registry.extraNodeSchemas(), ...(components.length > 0 ? { components } : {}) });
  const out: Diagnostic[] = [...result.diagnostics];
  if (!isRecord(project) || !result.ok) return out;
  const settings = isRecord(project['settings']) ? project['settings'] : {};
  const renderer2d = typeof settings['renderer2d'] === 'string' ? settings['renderer2d'] : 'skia';
  const comps = Array.isArray(project['compositions']) ? project['compositions'].filter(isRecord) : [];
  for (const comp of comps) {
    const nodes: Record<string, unknown>[] = [];
    walkIr(comp['nodes'], (n) => nodes.push(n));
    out.push(...ctx.registry.checkNodes(nodes, renderer2d).map((d) => ({ ...d, compositionId: String(comp['id']) })));
    if (ctx.fonts !== undefined) {
      const fonts = ctx.fonts;
      const defaultFont = typeof settings['defaultFont'] === 'string' ? settings['defaultFont'] : 'Inter';
      for (const n of nodes) {
        if (n['type'] !== 'text' && n['type'] !== 'rich-text') continue;
        const families = new Set<string>([typeof n['fontFamily'] === 'string' ? n['fontFamily'] : defaultFont]);
        if (Array.isArray(n['spans'])) for (const s of n['spans'].filter(isRecord)) if (typeof s['fontFamily'] === 'string') families.add(s['fontFamily']);
        for (const family of families) {
          if (!fonts.has(family)) {
            out.push({
              code: 'OV_FONT_MISSING',
              severity: 'error',
              errorClass: 'FontError',
              problem: `Font family "${family}" is not loaded.`,
              nodeId: String(n['id']),
              compositionId: String(comp['id']),
              suggestions: [`Add { family: "${family}", src: "./fonts/<file>.ttf" } to project.fonts.`, `Available: ${[...new Set(fonts.all().map((f) => f.family))].join(', ')}.`],
            });
          }
        }
      }
    }
  }
  // Komponenten-Props werden bei der Auswertung geprüft; Frame 0 jeder Composition reicht für unbekannte Props.
  const seen = new Set<string>();
  for (const comp of comps) {
    const scene = evaluateScene(project, String(comp['id']), 0, { registry: ctx.registry });
    for (const d of scene.diagnostics) {
      const key = `${d.code}|${d.path ?? ''}|${d.problem}`;
      if (d.code === 'OV_COMPONENT_PROPS' && !seen.has(key)) {
        seen.add(key);
        out.push({ ...d, compositionId: String(comp['id']) });
      }
    }
  }
  if (ctx.assets !== undefined) {
    const assets = ctx.assets;
    const list = Array.isArray(project['assets']) ? project['assets'].filter(isRecord) : [];
    for (const a of list) {
      const id = String(a['id']);
      if (assets.get(id) === undefined) {
        out.push({
          code: 'OV_ASSET_MISSING',
          severity: 'error',
          errorClass: 'AssetError',
          problem: `Asset "${id}" (${String(a['src'])}) could not be resolved.`,
          suggestions: ['Check the path relative to the project root.', 'Import the file with `openvideo assets import <file>`.'],
        });
      }
    }
  }
  return out;
}
