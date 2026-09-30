/**
 * Frame Plan (AD-5): teilt eine Evaluated Scene in Layer auf.
 *
 * - Benachbarte Nodes desselben Backends bilden einen Render-Layer, wenn das Backend `fusable` ist.
 * - `layer`-Nodes bilden immer einen eigenen Compositor-Layer.
 * - Gruppen mit Nachfahren aus mehreren Backends, und Gruppen, deren Kinder ein Backend ohne
 *   eigene Gruppen-Unterstützung brauchen (`scene3d`, `html`, `blender`), werden zu
 *   Compositor-Layern hochgestuft; der Compositor wendet dann Transform, Opacity, Maske,
 *   Reveal und Blend Mode der Gruppe an.
 * - Nodes, deren Blend Mode, Maske oder Reveal ein Backend nicht selbst über die Layer-Grenze
 *   hinweg anwenden kann, werden isoliert (`mode: 'isolate'`): Das Backend rendert die Node
 *   ohne diese Eigenschaften, der Compositor wendet sie auf den fertigen Layer an.
 * - Geschwister werden stabil nach `zIndex` sortiert (siehe {@link sortByZIndex}).
 */
import { OpenVideoError } from '@agentic-video/schema';
import { parseColor } from '@agentic-video/timeline';
import type { EvaluatedNode, EvaluatedScene } from './contracts.js';
import type { Registry } from './registry.js';

/** Ein Layer, den genau ein Backend rendert. */
export interface RenderLayerPlan {
  readonly kind: 'render';
  readonly id: string;
  readonly backend: string;
  readonly nodes: readonly EvaluatedNode[];
}

/** Ein Layer, den der Compositor aus Unter-Layern zusammensetzt. */
export interface CompositeLayerPlan {
  readonly kind: 'composite';
  readonly id: string;
  /**
   * `group`: Die `layer`- oder hochgestufte `group`-Node; der Compositor wendet Effekte, Crop,
   * Clip, Maske, Reveal, Transform, Opacity und Blend Mode an.
   *
   * `isolate`: Der einzige Kind-Layer enthält die Node bereits transformiert und mit Opacity;
   * der Compositor wendet nur Reveal, Maske (soweit an `node` gesetzt) und Blend Mode an.
   */
  readonly mode: 'group' | 'isolate';
  /** Die Node mit den Eigenschaften, die der Compositor anwendet. */
  readonly node: EvaluatedNode;
  readonly children: readonly LayerPlan[];
}

export type LayerPlan = RenderLayerPlan | CompositeLayerPlan;

/** Optionen für {@link planFrame}. */
export interface PlanOptions {
  /** Standard-2D-Backend: `skia` oder `pixi`. */
  readonly renderer2d?: string;
}

const MIXED = '<mixed>';

/**
 * Sortiert Geschwister stabil nach `zIndex` (Standard 0, kleinere Werte zuerst gezeichnet).
 * Gleiche Werte behalten ihre Reihenfolge. Ohne gesetztes `zIndex` kommt dasselbe Array zurück.
 *
 * @example
 * ```ts
 * sortByZIndex(scene.nodes).map((n) => n.id);
 * ```
 */
export function sortByZIndex<T extends { readonly props: Readonly<Record<string, unknown>> }>(nodes: readonly T[]): readonly T[] {
  const z = (n: T): number => {
    const v = n.props['zIndex'];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  if (nodes.every((n) => z(n) === 0)) return nodes;
  return nodes
    .map((node, index) => ({ node, index, z: z(node) }))
    .sort((a, b) => a.z - b.z || a.index - b.index)
    .map((e) => e.node);
}

function hasBlend(node: EvaluatedNode): boolean {
  const mode = node.props['blendMode'];
  return mode !== undefined && mode !== 'normal';
}

/** Props ohne `blendMode` (den übernimmt der Compositor), ohne das Original zu verändern. */
function withoutBlend(props: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (!Object.hasOwn(props, 'blendMode')) return props;
  const { blendMode: _blendMode, ...rest } = props;
  return rest;
}

interface Planner {
  readonly registry: Registry;
  readonly renderer2d: string;
  readonly memo: Map<EvaluatedNode, string | undefined>;
  counter: number;
}

/** Kann das Backend Gruppen, Blend Modes, Masken und Reveals innerhalb seines Layers selbst zeichnen? */
function groupCapable(p: Planner, backend: string): boolean {
  const b = p.registry.backends.get(backend);
  return b?.nodeTypes.includes('group') === true || backend === p.registry.backendFor('group', p.renderer2d);
}

function backendOf(p: Planner, node: EvaluatedNode): string | undefined {
  if (p.memo.has(node)) return p.memo.get(node);
  let result: string | undefined;
  if (node.type === 'layer') {
    result = MIXED;
  } else if (node.renderer !== undefined) {
    result = node.renderer;
  } else if (node.type === 'group') {
    const set = new Set(node.children.map((c) => backendOf(p, c)).filter((b): b is string => b !== undefined));
    if (node.mask !== undefined) {
      const m = backendOf(p, node.mask.node);
      if (m !== undefined) set.add(m);
    }
    const only = set.size === 1 ? [...set][0] : undefined;
    if (set.size === 0) result = p.registry.backendFor('group', p.renderer2d);
    // Eine Gruppe, deren einziges Backend keine Gruppen zeichnet (z. B. `three`), setzt der Compositor zusammen.
    else if (only !== undefined && only !== MIXED && groupCapable(p, only)) result = only;
    else result = MIXED;
  } else {
    result = p.registry.backendFor(node.type, p.renderer2d);
  }
  p.memo.set(node, result);
  return result;
}

/**
 * Entscheidet, ob eine Node isoliert werden muss, und teilt ihre Eigenschaften zwischen
 * Backend (`inner`) und Compositor (`outer`) auf.
 */
function isolation(p: Planner, node: EvaluatedNode, backend: string, backdropOutside: boolean): { inner: EvaluatedNode; outer: EvaluatedNode } | undefined {
  const blend = hasBlend(node);
  if (!groupCapable(p, backend)) {
    // Backends ohne Gruppen-Semantik (Three.js, Browser, Blender): Blend, Maske und Reveal übernimmt der Compositor.
    if (!blend && node.mask === undefined && node.reveal === undefined) return undefined;
    const { mask: _mask, reveal: _reveal, ...rest } = node;
    return { inner: { ...rest, props: withoutBlend(node.props) }, outer: node };
  }
  const maskBackend = node.mask !== undefined ? backendOf(p, node.mask.node) : undefined;
  const foreignMask = maskBackend !== undefined && maskBackend !== backend;
  const foreignBlend = blend && backdropOutside;
  if (!foreignMask && !foreignBlend) return undefined;
  // 2D-Backends zeichnen Reveal selbst; eine Maske nur, wenn sie im selben Backend liegt.
  const { mask, reveal: _reveal, ...base } = node;
  const inner: EvaluatedNode = { ...base, props: withoutBlend(node.props), ...(node.reveal !== undefined ? { reveal: node.reveal } : {}), ...(!foreignMask && mask !== undefined ? { mask } : {}) };
  const outer: EvaluatedNode = { ...base, ...(foreignMask && mask !== undefined ? { mask } : {}) };
  return { inner, outer };
}

/** Deckt die Hintergrundfarbe der Composition etwas ab? Ungültige Farben meldet der Compositor. */
function visibleBackground(background: string): boolean {
  try {
    return parseColor(background).a > 0;
  } catch (error) {
    if (error instanceof OpenVideoError) return false;
    throw error;
  }
}

/**
 * Plant eine Ebene. `backdrop`: Unter dieser Ebene liegt schon Inhalt, den kein Backend-Layer
 * dieser Ebene enthält (auf oberster Ebene die Hintergrundfarbe der Composition).
 */
function planLevel(p: Planner, nodes: readonly EvaluatedNode[], backdrop: boolean): LayerPlan[] {
  const out: LayerPlan[] = [];
  for (const node of sortByZIndex(nodes)) {
    const backend = backendOf(p, node);
    if (backend === undefined) continue;
    if (backend === MIXED) {
      // Gruppen sind isoliert: ihre Kinder mischen nur mit Inhalt derselben Gruppe.
      out.push({ kind: 'composite', mode: 'group', id: node.id, node, children: planLevel(p, node.children, false) });
      continue;
    }
    const last = out[out.length - 1];
    const fusable = p.registry.backends.get(backend)?.fusable ?? false;
    const fuses = last?.kind === 'render' && last.backend === backend && fusable;
    // Der Backdrop liegt außerhalb des Backend-Layers, sobald unter der Node etwas aus einem anderen Layer liegt.
    const backdropOutside = backdrop || (fuses ? out.length > 1 : out.length > 0);
    const iso = isolation(p, node, backend, backdropOutside);
    if (iso !== undefined) {
      const inner: RenderLayerPlan = { kind: 'render', id: `layer-${String(p.counter++)}-${node.id}`, backend, nodes: [iso.inner] };
      out.push({ kind: 'composite', mode: 'isolate', id: node.id, node: iso.outer, children: [inner] });
      continue;
    }
    if (fuses) {
      out[out.length - 1] = { ...last, nodes: [...last.nodes, node] };
    } else {
      out.push({ kind: 'render', id: `layer-${String(p.counter++)}-${node.id}`, backend, nodes: [node] });
    }
  }
  return out;
}

/**
 * Plant die Layer eines Frames.
 *
 * @example
 * ```ts
 * const plan = planFrame(scene, registry);
 * // [{ kind: 'render', backend: 'skia', nodes: [...] }, { kind: 'render', backend: 'three', ... }]
 * ```
 */
export function planFrame(scene: EvaluatedScene, registry: Registry, options: PlanOptions = {}): LayerPlan[] {
  const p: Planner = { registry, renderer2d: options.renderer2d ?? 'skia', memo: new Map(), counter: 0 };
  return planLevel(p, scene.nodes, visibleBackground(scene.background));
}

/** Alle Backends, die ein Plan benötigt. */
export function backendsInPlan(plan: readonly LayerPlan[]): Set<string> {
  const out = new Set<string>();
  const visit = (p: LayerPlan): void => {
    if (p.kind === 'render') out.add(p.backend);
    else p.children.forEach(visit);
  };
  plan.forEach(visit);
  return out;
}
