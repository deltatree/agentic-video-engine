/**
 * Zwischenablage (Story 20.8): Kopierte Nodes gehen als JSON in die System-Zwischenablage,
 * damit sie zwischen Tabs, Projekten und in Editoren/Agenten landen können.
 */
import { isRecord } from '@agentic-video/core';
import type { Rec } from './json.js';

/** MIME-Typ für Nodes in der Zwischenablage (zusätzlich zu `text/plain`). */
export const NODES_MIME = 'application/x-openvideo-nodes+json';

/**
 * Text für die Zwischenablage.
 *
 * @example
 * ```ts
 * clipboardText([{ id: 'box', type: 'rect' }]); // '{"openvideo":"nodes","nodes":[{"id":"box","type":"rect"}]}'
 * ```
 */
export function clipboardText(nodes: readonly Readonly<Rec>[]): string {
  return JSON.stringify({ openvideo: 'nodes', nodes });
}

/**
 * Liest Nodes aus Zwischenablage-Text: das Studio-Format, eine einzelne Node oder eine Liste von Nodes.
 * Alles andere liefert `undefined`.
 *
 * @example
 * ```ts
 * parseClipboard('{"id":"box","type":"rect"}'); // [{ id: 'box', type: 'rect' }]
 * ```
 */
export function parseClipboard(text: string): Rec[] | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const isNode = (v: unknown): v is Rec => isRecord(v) && typeof v['type'] === 'string';
  if (isRecord(raw) && raw['openvideo'] === 'nodes' && Array.isArray(raw['nodes'])) {
    const nodes = raw['nodes'].filter(isNode);
    return nodes.length > 0 ? nodes : undefined;
  }
  if (isNode(raw)) return [raw];
  if (Array.isArray(raw) && raw.length > 0 && raw.every(isNode)) return raw.filter(isNode);
  return undefined;
}
