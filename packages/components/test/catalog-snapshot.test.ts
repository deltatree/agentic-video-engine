/**
 * Komponenten-Katalog als Snapshot (Story 22.5, Audit P2-10): Beschreibung, Props-Schema, Beispiel
 * und der Umriss der expandierten Nodes (Typen, IDs) bei Frame 45. Ersetzt die schwachen
 * `length > 0`-Prüfungen; bewusst aktualisieren mit `npx vitest run packages/components -u`.
 */
import { describe, expect, it } from 'vitest';
import { Registry, SCHEMA_VERSION, evaluateScene, type EvaluatedNode } from '@agentic-video/core';
import { COMPONENTS, THEMES, registerComponents } from '@agentic-video/components';

function outline(n: EvaluatedNode): unknown {
  const label = `${n.type}#${n.id}`;
  return n.children.length === 0 ? label : { [label]: n.children.map(outline) };
}

function expanded(name: string, props: Record<string, unknown>): unknown {
  const registry = new Registry();
  registerComponents(registry);
  const project = {
    schemaVersion: SCHEMA_VERSION,
    settings: { theme: THEMES.dark },
    compositions: [{ id: 'main', width: 1280, height: 720, fps: 30, duration: 90, nodes: [{ id: 'c', type: 'component', component: name, props, x: 40, y: 40 }] }],
  };
  const scene = evaluateScene(project, 'main', 45, { registry });
  return scene.nodes.map(outline);
}

describe('Komponenten-Katalog (Snapshot)', () => {
  it('Namen, Beschreibungen, Props-Schemas und Beispiele entsprechen dem Snapshot', () => {
    expect(COMPONENTS.map((c) => ({ name: c.name, description: c.description, propsSchema: c.propsSchema, example: c.example }))).toMatchSnapshot();
  });

  it('das Beispiel jeder Komponente expandiert zu denselben Nodes (Typen und IDs, Frame 45)', () => {
    expect(Object.fromEntries(COMPONENTS.map((c) => [c.name, expanded(c.name, { ...c.example })]))).toMatchSnapshot();
  });
});
