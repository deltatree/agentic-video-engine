/**
 * Frame Plan (AD-5): teilt eine Evaluated Scene in Layer auf.
 *
 * - Benachbarte Nodes desselben Backends bilden einen Render-Layer, wenn das Backend `fusable` ist.
 * - `layer`-Nodes bilden immer einen eigenen Compositor-Layer.
 * - Gruppen mit Nachfahren aus mehreren Backends werden zu Compositor-Layern hochgestuft;
 *   der Compositor wendet dann Transform, Opacity und Maske der Gruppe an.
 */
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
  /** Die `layer`- oder hochgestufte `group`-Node mit Transform, Opacity, Maske, Effekten. */
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

function backendOf(node: EvaluatedNode, registry: Registry, renderer2d: string, memo: Map<EvaluatedNode, string | undefined>): string | undefined {
  if (memo.has(node)) return memo.get(node);
  let result: string | undefined;
  if (node.type === 'layer') {
    result = MIXED;
  } else if (node.renderer !== undefined) {
    result = node.renderer;
  } else if (node.type === 'group') {
    const set = new Set(node.children.map((c) => backendOf(c, registry, renderer2d, memo)).filter((b): b is string => b !== undefined));
    if (node.mask !== undefined) {
      const m = backendOf(node.mask.node, registry, renderer2d, memo);
      if (m !== undefined) set.add(m);
    }
    result = set.size === 0 ? registry.backendFor('group', renderer2d) : set.size === 1 ? [...set][0] : MIXED;
  } else {
    result = registry.backendFor(node.type, renderer2d);
  }
  memo.set(node, result);
  return result;
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
  const memo = new Map<EvaluatedNode, string | undefined>();
  const renderer2d = options.renderer2d ?? 'skia';
  let counter = 0;
  const plan = (nodes: readonly EvaluatedNode[]): LayerPlan[] => {
    const out: LayerPlan[] = [];
    for (const node of nodes) {
      const backend = backendOf(node, registry, renderer2d, memo);
      if (backend === undefined) continue;
      if (backend === MIXED) {
        out.push({ kind: 'composite', id: node.id, node, children: plan(node.children) });
        continue;
      }
      const last = out[out.length - 1];
      const fusable = registry.backends.get(backend)?.fusable ?? false;
      if (last?.kind === 'render' && last.backend === backend && fusable) {
        out[out.length - 1] = { ...last, nodes: [...last.nodes, node] };
      } else {
        out.push({ kind: 'render', id: `layer-${String(counter++)}-${node.id}`, backend, nodes: [node] });
      }
    }
    return out;
  };
  return plan(scene.nodes);
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
