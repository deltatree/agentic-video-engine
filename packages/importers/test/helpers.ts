import { validateProject, type Diagnostic } from '@agentic-video/core';
import type { ImportedAsset, JsonNode } from '@agentic-video/importers';

/** Bettet importierte Nodes in ein minimales Project ein und validiert es. */
export function validateImport(nodes: JsonNode[], assets: ImportedAsset[] = []): readonly Diagnostic[] {
  const project = {
    schemaVersion: '1.0.0',
    compositions: [{ id: 'main', width: 1920, height: 1080, fps: 30, duration: '5s', nodes }],
    assets: assets.map((a) => a.asset),
  };
  return validateProject(project).diagnostics.filter((d) => d.severity === 'error');
}

/** Sucht eine Node rekursiv (auch in Masken). */
export function find(nodes: readonly unknown[], id: string): JsonNode | undefined {
  for (const n of nodes) {
    if (typeof n !== 'object' || n === null) continue;
    const node = n as JsonNode;
    if (node['id'] === id) return node;
    const children = Array.isArray(node['children']) ? (node['children'] as unknown[]) : [];
    const mask = node['mask'] as { node?: unknown } | undefined;
    const hit = find([...children, ...(mask?.node !== undefined ? [mask.node] : [])], id);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Alle Nodes als flache Liste. */
export function flatten(nodes: readonly unknown[]): JsonNode[] {
  const out: JsonNode[] = [];
  for (const n of nodes) {
    const node = n as JsonNode;
    out.push(node);
    if (Array.isArray(node['children'])) out.push(...flatten(node['children'] as unknown[]));
  }
  return out;
}

/** Probleme aller Verlust-Diagnosen. */
export function problems(diagnostics: readonly Diagnostic[]): string[] {
  return diagnostics.map((d) => `${d.path ?? ''}: ${d.problem}`);
}
