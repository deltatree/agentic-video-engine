import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateProject, type Diagnostic } from '@agentic-video/core';
import type { toIR as ToIR } from '@agentic-video/sdk';

const here = dirname(fileURLToPath(import.meta.url));
const packages = join(here, '..', '..');

/** Bündelt eine TSX-Datei samt SDK-Quellen und lädt sie als Modul (ohne Sandbox; nur für SDK-Tests). */
async function loadTsx(file: string): Promise<{ default: unknown; toIR: typeof ToIR }> {
  const result = await build({
    stdin: { contents: `export { default } from ${JSON.stringify(file)}; export { toIR } from '@agentic-video/sdk';`, resolveDir: here, loader: 'ts' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    mainFields: ['module', 'main'],
    jsx: 'automatic',
    jsxDev: true,
    jsxImportSource: '@agentic-video/sdk',
    absWorkingDir: here,
    logLevel: 'silent',
    plugins: [
      {
        name: 'workspace',
        setup(b) {
          b.onResolve({ filter: /^@agentic-video\// }, (args) => {
            const [, name, sub] = /^@agentic-video\/([a-z0-9-]+)(?:\/(.+))?$/.exec(args.path) ?? [];
            return { path: join(packages, name ?? '', 'src', `${sub ?? 'index'}.ts`) };
          });
        },
      },
    ],
  });
  const code = result.outputFiles[0]?.text ?? '';
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)) as { default: unknown; toIR: typeof ToIR };
}

/** Liest einen verschachtelten Wert aus Testdaten. */
function at(value: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = value;
  for (const key of path) cur = cur !== null && typeof cur === 'object' ? (cur as Record<string | number, unknown>)[key] : undefined;
  return cur;
}

describe('Auftrag A4 example', () => {
  it('compiles to a valid IR with scene3d (camera moved), text, subtitles and meta.source', async () => {
    const mod = await loadTsx('./fixtures/auftrag-a4.tsx');
    const warnings: Diagnostic[] = [];
    const ir = mod.toIR(mod.default as Parameters<typeof ToIR>[0], { onDiagnostic: (d) => warnings.push(d) });
    const result = validateProject(ir);
    expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

    const comp = ir.compositions[0]!;
    expect(comp.background).toBe('#080A10');
    expect(comp.fps).toBe(60);
    const types = comp.nodes.map((n) => n.type);
    expect(types).toEqual(['scene3d', 'text', 'subtitles']);

    const scene = comp.nodes[0];
    expect(at(scene, 'camera')).toBe('camera');
    expect(at(scene, 'width')).toBe(1920);
    expect((at(scene, 'children') as unknown[]).map((c) => at(c, 'type'))).toEqual(['camera3d', 'light3d', 'light3d', 'model3d']);
    const camera = at(scene, 'children', 0);
    expect(at(camera, 'id')).toBe('camera');
    expect(at(camera, 'position', '$keyframes')).toHaveLength(2);
    const model = at(scene, 'children', 3);
    expect(at(model, 'asset')).toBe('product');
    expect(at(model, 'rotation', '$sampled', 'values')).toHaveLength(720);
    expect(at(model, 'rotation', '$sampled', 'values', 60)).toEqual([0, 0.4, 0]);

    const text = comp.nodes[1];
    expect(at(text, 'id')).toBe('headline');
    expect(at(text, 'fontFamily')).toBe('Inter');
    expect(at(text, 'fontSize')).toBe(92);
    expect(at(text, 'opacity', '$sampled', 'values')).toHaveLength(720);
    expect(at(text, 'meta', 'source')).toEqual({ file: expect.stringContaining('auftrag-a4.tsx'), line: 36, column: 7 });
    expect(warnings.map((w) => w.code)).toContain('OV_SDK_CLAMPED');

    const subtitles = comp.nodes[2];
    expect(at(subtitles, 'track')).toBe('voiceover');
    expect(comp.tracks).toEqual([{ id: 'voiceover', kind: 'subtitle', asset: 'voiceover' }]);
    expect(ir.assets).toEqual([
      { id: 'product', type: 'model', src: './assets/product.glb' },
      { id: 'voiceover', type: 'subtitle', src: './audio/voiceover.srt' },
    ]);
    for (const n of comp.nodes) expect(at(n, 'meta', 'source', 'line')).toBeGreaterThan(0);
  });
});
