import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyPatches, type Patch } from '@agentic-video/core';
import { applyPatchesToSource, compileTsx } from '@agentic-video/compiler';

const here = dirname(fileURLToPath(import.meta.url));
const a4Path = join(here, '..', '..', 'sdk', 'test', 'fixtures', 'auftrag-a4.tsx');
const a4 = await readFile(a4Path, 'utf8');

function changedLines(before: string, after: string): { before: string[]; after: string[] } {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { before: a.slice(start, endA), after: b.slice(start, endB) };
}

const small = `import { Group, Rect, Scene, Text, composition } from '@agentic-video/sdk';

export default composition({
  width: 640,
  height: 360,
  fps: 30,
  duration: 30,
  scene: ({ frame }) => (
    <Scene>
      <Group id="g">
        <Rect id="box" width={10} height={10} scale={{ x: 1, y: 1 }} />
      </Group>
      <Group id="empty" />
      <Text id="label" text="Hello" x={frame * 2} />
      {frame > 3 && <Rect id="late" width={1} height={1} />}
    </Scene>
  ),
});
`;

function run(source: string, patches: Patch[]) {
  return applyPatchesToSource(source, patches, { fileName: 'video.tsx' });
}

describe('applyPatchesToSource', () => {
  it('changes exactly the fontSize attribute (diff test)', () => {
    const r = run(a4, [{ op: 'setProperty', nodeId: 'headline', property: 'fontSize', value: 82 }]);
    expect(r.diagnostics).toEqual([]);
    expect(r.applied).toHaveLength(1);
    expect(changedLines(a4, r.source)).toEqual({ before: ['        fontSize={92}'], after: ['        fontSize={82}'] });
  });

  it('keeps the string form, uses the font alias and adds missing attributes', () => {
    const r = run(a4, [
      { op: 'setProperty', nodeId: 'headline', property: 'text', value: 'Hello world' },
      { op: 'setProperty', nodeId: 'headline', property: 'fontFamily', value: 'Roboto' },
      { op: 'setProperty', nodeId: 'camera', property: 'fov', value: 35 },
    ]);
    expect(r.diagnostics).toEqual([]);
    expect(r.source).toContain('text="Hello world"');
    expect(r.source).toContain('font="Roboto"');
    expect(r.source).toContain('        )}\n        fov={35}\n      />');
  });

  it('edits nested paths inside object literals and creates compound defaults', () => {
    const r = run(small, [
      { op: 'setProperty', nodeId: 'box', property: 'scale.x', value: 1.5 },
      { op: 'setProperty', nodeId: 'label', property: 'scale.y', value: 2 },
    ]);
    expect(r.diagnostics).toEqual([]);
    expect(r.source).toContain('scale={{ x: 1.5, y: 1 }}');
    expect(r.source).toContain('<Text id="label" text="Hello" x={frame * 2} scale={{ y: 2, x: 1 }} />');
  });

  it('refuses to overwrite expressions with OV_ROUNDTRIP_DYNAMIC', () => {
    const r = run(a4, [{ op: 'setProperty', nodeId: 'headline', property: 'opacity', value: 0.5 }]);
    expect(r.source).toBe(a4);
    expect(r.applied).toEqual([]);
    expect(r.diagnostics[0]).toMatchObject({ code: 'OV_ROUNDTRIP_DYNAMIC', nodeId: 'headline', details: { file: 'video.tsx', line: 43, expression: 'spring({frame, from: 20})' } });
    expect(r.diagnostics[0]!.suggestions.length).toBeGreaterThan(0);
  });

  it('removes attributes when the value is null', () => {
    const r = run(small, [{ op: 'setProperty', nodeId: 'box', property: 'scale', value: null }]);
    expect(r.source).toContain('<Rect id="box" width={10} height={10} />');
  });

  it('C11: writes a literal null when keepNull is set', () => {
    const r = run(small, [{ op: 'setProperty', nodeId: 'box', property: 'scale', value: null, keepNull: true }]);
    expect(r.source).toContain('scale={null}');
  });

  it('adds nodes as last child and extends the import', () => {
    const r = run(small, [
      { op: 'addNode', parentId: 'g', node: { id: 'dot', type: 'ellipse', width: 4, height: 4, fill: '#FF0000' } },
      { op: 'addNode', parentId: null, node: { id: 'sun', type: 'light3d', kind: 'point', intensity: 2 } },
      { op: 'addNode', parentId: 'empty', node: { id: 'inner', type: 'rect', width: 1, height: 1 } },
    ]);
    expect(r.diagnostics).toEqual([]);
    expect(r.source).toContain(`        <Rect id="box" width={10} height={10} scale={{ x: 1, y: 1 }} />\n        <Ellipse id="dot" width={4} height={4} fill="#FF0000" />\n      </Group>`);
    expect(r.source).toContain(`      {frame > 3 && <Rect id="late" width={1} height={1} />}\n      <PointLight id="sun" intensity={2} />\n    </Scene>`);
    expect(r.source).toContain(`<Group id="empty">\n        <Rect id="inner" width={1} height={1} />\n      </Group>`);
    expect(r.source).toContain("import { Group, Rect, Scene, Text, composition, Ellipse, PointLight } from '@agentic-video/sdk';");
  });

  it('removes and moves nodes by whole lines', () => {
    const removed = run(small, [{ op: 'removeNode', nodeId: 'box' }]);
    expect(removed.source).not.toContain('id="box"');
    expect(changedLines(small, removed.source).after).toEqual([]);

    const moved = run(small, [{ op: 'moveNode', nodeId: 'label', parentId: 'g' }]);
    expect(moved.diagnostics).toEqual([]);
    expect(moved.source).toContain(`scale={{ x: 1, y: 1 }} />\n        <Text id="label" text="Hello" x={frame * 2} />\n      </Group>`);
    expect(moved.source.match(/id="label"/g)).toHaveLength(1);
  });

  it('refuses to remove elements inside expressions', () => {
    const r = run(small, [{ op: 'removeNode', nodeId: 'late' }]);
    expect(r.diagnostics[0]?.code).toBe('OV_ROUNDTRIP_DYNAMIC');
    expect(r.source).toBe(small);
  });

  it('adds and removes keyframes and imports keyframes()', () => {
    const add = run(small, [
      { op: 'addKeyframe', nodeId: 'box', property: 'width', keyframe: { t: 30, v: 20 } },
      { op: 'addKeyframe', nodeId: 'box', property: 'width', keyframe: { t: 15, v: 40, ease: 'easeOutCubic' } },
      { op: 'addKeyframe', nodeId: 'box', property: 'width', keyframe: { t: 30, v: 25 } },
    ]);
    expect(add.diagnostics).toEqual([]);
    expect(add.source).toContain('width={keyframes([{ t: 0, v: 10 }, { t: 15, v: 40, ease: "easeOutCubic" }, { t: 30, v: 25 }])}');
    expect(add.source).toContain('composition, keyframes }');

    const removed = run(add.source, [
      { op: 'removeKeyframe', nodeId: 'box', property: 'width', t: 15 },
      { op: 'removeKeyframe', nodeId: 'box', property: 'width', t: 30 },
    ]);
    expect(removed.diagnostics).toEqual([]);
    expect(removed.source).toContain('<Rect id="box" width={10} height={10}');

    const missing = run(small, [{ op: 'removeKeyframe', nodeId: 'box', property: 'width', t: 0 }]);
    expect(missing.diagnostics[0]?.code).toBe('OV_ROUNDTRIP_NO_KEYFRAME');
  });

  it('reports unknown ids and unsupported patches', () => {
    const r = run(small, [
      { op: 'setProperty', nodeId: 'nope', property: 'x', value: 1 },
      { op: 'setProjectProperty', property: 'metadata.title', value: 'T' },
    ]);
    expect(r.diagnostics.map((d) => d.code)).toEqual(['OV_ROUNDTRIP_NOT_FOUND', 'OV_ROUNDTRIP_UNSUPPORTED']);
  });

  it('produces the same IR as patching the compiled IR', async () => {
    const patch: Patch = { op: 'setProperty', nodeId: 'headline', property: 'fontSize', value: 82 };
    const dir = await mkdtemp(join(tmpdir(), 'ov-roundtrip-'));
    try {
      await writeFile(join(dir, 'auftrag-a4.tsx'), a4);
      const before = await compileTsx('auftrag-a4.tsx', { projectDir: dir, mode: 'trusted-host' });
      await writeFile(join(dir, 'auftrag-a4.tsx'), run(a4, [patch]).source);
      const after = await compileTsx('auftrag-a4.tsx', { projectDir: dir, mode: 'trusted-host' });
      const patched = applyPatches(before.project, [patch]);
      expect(patched.ok).toBe(true);
      expect(after.project).toEqual(patched.project);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
