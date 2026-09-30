import { describe, expect, it } from 'vitest';
import { COMPONENT_FOR_NODE_TYPE, Rect, Scene, Sequence, composition, toIR } from '@agentic-video/sdk';
import { validateProject } from '@agentic-video/core';

describe('<Sequence> (Story 17.10)', () => {
  it('bildet Kinder und Übergänge auf eine sequence-Node ab', () => {
    const ir = toIR(
      composition({
        width: 320,
        height: 180,
        fps: 30,
        duration: '3s',
        scene: () =>
          Scene({
            children: Sequence({
              id: 'seq',
              between: { type: 'fade', duration: '0.5s' },
              transitions: [{ type: 'cut' }],
              children: [Rect({ id: 'a', width: 320, height: 180, fill: '#FF0000', timing: { duration: '1s' } }), Rect({ id: 'b', width: 320, height: 180, timing: { duration: '1s' } })],
            }),
          }),
      }),
    );
    const seq = ir.compositions[0]?.nodes[0];
    expect(seq).toMatchObject({ id: 'seq', type: 'sequence', between: { type: 'fade', duration: '0.5s' }, transitions: [{ type: 'cut' }] });
    expect(seq !== undefined && 'children' in seq ? seq.children.length : 0).toBe(2);
    expect(validateProject(ir).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('schreibt sequence-Nodes als <Sequence> zurück', () => {
    expect(COMPONENT_FOR_NODE_TYPE['sequence']).toBe('Sequence');
  });
});
