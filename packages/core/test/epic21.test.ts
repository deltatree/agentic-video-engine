/**
 * Epic 21 im Kern: Rückfall pro Node von PixiJS auf Skia (Story 21.6, ADR 0018).
 */
import { describe, expect, it } from 'vitest';
import { Registry, SCHEMA_VERSION, evaluateScene, planFrame, type Diagnostic, type LayerPlan, type RenderBackend } from '@agentic-video/core';

function backend(id: string, nodeTypes: readonly string[], check: (node: Readonly<Record<string, unknown>>) => Diagnostic[] = () => []): RenderBackend {
  return {
    id,
    nodeTypes,
    capabilities: [],
    fusable: true,
    versions: () => ({ [id]: '1' }),
    check: (node) => {
      const diagnostics = check(node);
      return { supported: diagnostics.every((d) => d.severity !== 'error'), diagnostics };
    },
    renderLayer: () => Promise.reject(new Error('not used')),
    dispose: () => Promise.resolve(),
  };
}

/** Stark vereinfachte Pixi-Prüfung: kein svg, kein Schatten, keine SkSL-only-Shader; Kinder werden rekursiv geprüft. */
function pixiCheck(node: Readonly<Record<string, unknown>>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const id = String(node['id']);
  const push = (feature: string, severity: 'warning' | 'error' | 'info'): void => {
    out.push({ code: 'OV_PIXI_UNSUPPORTED', severity, errorClass: 'PixiRendererError', problem: feature, nodeId: id, details: { feature }, suggestions: [] });
  };
  if (node['type'] === 'svg') push('node.svg', 'error');
  if (node['shadow'] !== undefined) push('shadow', 'warning');
  if (node['type'] === 'shader' && typeof node['glsl'] !== 'string') push('shader.sksl', 'error');
  if (node['smoothing'] === 'cubic') push('image.smoothing.cubic', 'info');
  const children = node['children'];
  if (Array.isArray(children)) for (const c of children) if (typeof c === 'object' && c !== null && !Array.isArray(c)) out.push(...pixiCheck(Object.fromEntries(Object.entries(c))));
  return out;
}

const TWO_D = ['group', 'rect', 'ellipse', 'text', 'svg', 'shader', 'image'];
const registry = new Registry();
registry.registerBackend(backend('skia', TWO_D));
registry.registerBackend(backend('pixi', TWO_D.filter((t) => t !== 'svg'), pixiCheck));

function project(nodes: unknown[]): Record<string, unknown> {
  return { schemaVersion: SCHEMA_VERSION, settings: { renderer2d: 'pixi' }, assets: [{ id: 'logo', type: 'svg', src: './logo.svg' }, { id: 'img', type: 'image', src: './a.png' }], compositions: [{ id: 'main', width: 320, height: 180, fps: 30, duration: '1s', nodes }] };
}

function describePlan(plan: readonly LayerPlan[]): unknown[] {
  return plan.map((l) => (l.kind === 'render' ? `${l.backend}:${l.nodes.map((n) => n.id).join('+')}` : { [`${l.mode}:${l.id}`]: describePlan(l.children) }));
}

const rect = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'rect', width: 10, height: 10, fill: '#FF0000', ...extra });

describe('Pixi-Rückfall pro Node (21.6, ADR 0018)', () => {
  it('rendert unterstützte Nodes mit Pixi und fällt pro Node auf Skia zurück', () => {
    const p = project([rect('a'), { id: 's', type: 'svg', asset: 'logo', width: 10, height: 10 }, rect('b', { shadow: { color: '#000000', blur: 4 } }), rect('c')]);
    expect(describePlan(planFrame(evaluateScene(p, 'main', 0), registry, { renderer2d: 'pixi' }))).toEqual(['pixi:a', 'skia:s+b', 'pixi:c']);
  });

  it('fällt bei Info-Meldungen nicht zurück', () => {
    const p = project([{ id: 'i', type: 'image', asset: 'img', width: 10, height: 10, smoothing: 'cubic' }]);
    expect(describePlan(planFrame(evaluateScene(p, 'main', 0), registry, { renderer2d: 'pixi' }))).toEqual(['pixi:i']);
  });

  it('eine Gruppe mit einem Skia-Kind wird zur Compositor-Gruppe; eine reine Rückfall-Gruppe bleibt Skia', () => {
    const mixed = project([{ id: 'g', type: 'group', children: [rect('a'), rect('b', { shadow: { color: '#000000' } })] }]);
    expect(describePlan(planFrame(evaluateScene(mixed, 'main', 0), registry, { renderer2d: 'pixi' }))).toEqual([{ 'group:g': ['pixi:a', 'skia:b'] }]);
    const allSkia = project([{ id: 'g', type: 'group', children: [rect('b', { shadow: { color: '#000000' } })] }]);
    expect(describePlan(planFrame(evaluateScene(allSkia, 'main', 0), registry, { renderer2d: 'pixi' }))).toEqual(['skia:g']);
    const ownProps = project([{ id: 'g', type: 'group', shadow: { color: '#000000' }, children: [rect('a')] }]);
    // Eigene Gruppen-Eigenschaften, die Pixi nicht kann: Skia zeichnet die ganze Gruppe.
    expect(describePlan(planFrame(evaluateScene(ownProps, 'main', 0), registry, { renderer2d: 'pixi' }))).toEqual(['skia:g']);
  });

  it('explizites renderer: pixi erzwingt Pixi ohne Rückfall', () => {
    const p = project([rect('b', { renderer: 'pixi', shadow: { color: '#000000' } })]);
    expect(describePlan(planFrame(evaluateScene(p, 'main', 0), registry, { renderer2d: 'pixi' }))).toEqual(['pixi:b']);
    expect(registry.resolveBackend({ id: 'b', type: 'rect', renderer: 'pixi', shadow: {} }, 'pixi')).toEqual({ backend: 'pixi' });
  });

  it('Dual-Source-Shader (ADR 0020): mit glsl rendert Pixi, nur mit sksl fällt die Node auf Skia zurück', () => {
    const shader = (id: string, src: Record<string, string>) => ({ id, type: 'shader', width: 10, height: 10, ...src });
    const p = project([shader('both', { sksl: 'half4 main(float2 p) { return half4(1); }', glsl: 'void mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }' }), shader('sk', { sksl: 'half4 main(float2 p) { return half4(1); }' })]);
    expect(describePlan(planFrame(evaluateScene(p, 'main', 0), registry, { renderer2d: 'pixi' }))).toEqual(['pixi:both', 'skia:sk']);
    expect(describePlan(planFrame(evaluateScene(p, 'main', 0), registry))).toEqual(['skia:both+sk']);
  });

  it('checkNodes meldet den Rückfall als Info OV_PIXI_FALLBACK und keine Pixi-Warnungen der Kinder am Elternknoten', () => {
    const nodes = [
      { id: 'g', type: 'group', children: [rect('b', { shadow: { color: '#000000' } })] },
      rect('b', { shadow: { color: '#000000' } }),
      { id: 's', type: 'svg', asset: 'logo', width: 10, height: 10 },
    ];
    const diagnostics = registry.checkNodes(nodes, 'pixi');
    expect(diagnostics.map((d) => [d.code, d.severity, d.nodeId])).toEqual([
      ['OV_PIXI_FALLBACK', 'info', 'b'],
      ['OV_PIXI_FALLBACK', 'info', 's'],
    ]);
    expect(diagnostics[0]?.details).toEqual({ from: 'pixi', to: 'skia', features: 'shadow' });
    // Mit Skia als Standard gibt es keinen Rückfall.
    expect(registry.checkNodes(nodes, 'skia')).toEqual([]);
  });
});
