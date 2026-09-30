// Story 19.7: capabilities.get liefert je Node-Typ Property-Typen und ein gültiges JSON-Beispiel.
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NODE_EXAMPLES, NODE_SCHEMAS, isRecord } from '@agentic-video/core';
import { OPERATIONS, invokeOperation } from '@agentic-video/agent';
import { testServices } from './helpers.js';

async function capabilities(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const services = testServices(mkdtempSync(join(tmpdir(), 'ov-examples-')));
  const r = await invokeOperation(OPERATIONS, 'capabilities.get', input, { services, via: 'test' });
  if (!r.ok) throw new Error(`capabilities.get failed: ${r.error.code} ${r.error.problem}`);
  if (!isRecord(r.result)) throw new Error('capabilities.get returned no object');
  return r.result;
}

describe('capabilities.get mit Beispielen (Story 19.7)', () => {
  it('liefert für jeden eingebauten Node-Typ das Beispiel und Property-Typen', async () => {
    const all = await capabilities({});
    const nodeTypes = all['nodeTypes'] as Record<string, Record<string, unknown>>;
    for (const type of Object.keys(NODE_SCHEMAS)) {
      expect(nodeTypes[type]?.['example'], type).toEqual(NODE_EXAMPLES[type as keyof typeof NODE_EXAMPLES]);
      expect(Object.keys(nodeTypes[type]?.['propertyTypes'] as object), type).toEqual(nodeTypes[type]?.['properties']);
    }
  });

  it('liefert Beispiel und Typen auch für einen einzelnen Node-Typ', async () => {
    const seq = await capabilities({ nodeType: 'sequence' });
    expect(seq['example']).toEqual(NODE_EXAMPLES.sequence);
    expect((seq['propertyTypes'] as Record<string, string>)['children']).toBe('node[]');
    expect(seq['properties']).toContain('between');
    expect(seq['backends']).toEqual([]);
    const text = await capabilities({ nodeType: 'text' });
    expect((text['propertyTypes'] as Record<string, string>)['fontSize']).toBe('number (>= 0, animatable)');
    expect(text['backends']).toEqual(['skia']);
  });
});
