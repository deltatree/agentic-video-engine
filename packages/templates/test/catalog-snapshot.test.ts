/**
 * Katalog-Snapshot (Story 22.5, Audit P2-10): Statt nur `length > 0` hält der Snapshot Titel,
 * Beschreibung, Maße, fps, Dauer und Dateiliste jedes Templates fest. Eine Änderung am Katalog
 * fällt im Review auf; bewusst aktualisieren mit `npx vitest run packages/templates -u`.
 */
import { describe, expect, it } from 'vitest';
import { createTemplateCatalog } from '@agentic-video/templates';

describe('Template-Katalog (Snapshot)', () => {
  it('list() entspricht dem eingecheckten Snapshot', () => {
    expect(createTemplateCatalog().list()).toMatchSnapshot();
  });

  it('jedes Template: Nodes und Assets der IR (Typen und IDs) entsprechen dem Snapshot', async () => {
    const catalog = createTemplateCatalog();
    const outline: Record<string, unknown> = {};
    for (const info of catalog.list()) {
      const t = await catalog.get(info.name);
      const comps = Array.isArray(t.project['compositions']) ? t.project['compositions'] : [];
      const assets = Array.isArray(t.project['assets']) ? t.project['assets'] : [];
      outline[info.name] = {
        compositions: comps.map((c: unknown) => tree(c)),
        assets: assets.map((a: unknown) => (typeof a === 'object' && a !== null && 'id' in a && 'type' in a ? `${String(a.type)}:${String(a.id)}` : '?')),
      };
    }
    expect(outline).toMatchSnapshot();
  });
});

/** Umriss eines Knotens: `typ#id` mit Kindern (ohne Werte, damit Stil-Änderungen den Snapshot nicht brechen). */
function tree(node: unknown): unknown {
  if (typeof node !== 'object' || node === null) return '?';
  const id = 'id' in node ? String(node.id) : '?';
  const type = 'type' in node ? String(node.type) : 'composition';
  const children = 'nodes' in node && Array.isArray(node.nodes) ? node.nodes : 'children' in node && Array.isArray(node.children) ? node.children : [];
  return children.length === 0 ? `${type}#${id}` : { [`${type}#${id}`]: children.map((c: unknown) => tree(c)) };
}
