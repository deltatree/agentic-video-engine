import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { skipUnless } from '@agentic-video/testing';
import { OpenVideoError, validateProject } from '@agentic-video/core';
import { compileTsx, exportJson, type CompileOptions } from '@agentic-video/compiler';
import { sandboxAvailable } from '@agentic-video/sandbox';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const a4Dir = join(here, '..', '..', 'sdk', 'test', 'fixtures');
const noDocker = !(await sandboxAvailable()).available;

/** Liest einen verschachtelten Wert aus Testdaten. */
function at(value: unknown, ...path: (string | number)[]): unknown {
  let cur: unknown = value;
  for (const key of path) cur = cur !== null && typeof cur === 'object' ? (cur as Record<string | number, unknown>)[key] : undefined;
  return cur;
}

function hasFunction(value: unknown): boolean {
  if (typeof value === 'function') return true;
  if (Array.isArray(value)) return value.some(hasFunction);
  if (value !== null && typeof value === 'object') return Object.values(value).some(hasFunction);
  return false;
}

async function failure(entry: string, options: CompileOptions): Promise<OpenVideoError> {
  try {
    await compileTsx(entry, options);
  } catch (error) {
    expect(error).toBeInstanceOf(OpenVideoError);
    return error as OpenVideoError;
  }
  throw new Error('expected compile to fail');
}

const trusted: CompileOptions = { projectDir: fixtures, mode: 'trusted-host' };

describe('compileTsx (trusted-host)', () => {
  it('samples frame functions: x is $sampled with one value per frame, constants stay literal', async () => {
    const r = await compileTsx('sampled.tsx', trusted);
    expect(r.trusted).toBe(true);
    expect(r.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const box = r.project.compositions[0]!.nodes[0];
    expect(at(box, 'x')).toEqual({ $sampled: { start: 0, values: Array.from({ length: 20 }, (_, f) => f * 2) } });
    expect(at(box, 'y')).toBe(40);
    expect(at(box, 'meta', 'source')).toEqual({ file: 'sampled.tsx', line: 10, column: 7 });
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('maps runtime errors to the TSX file and line', async () => {
    const e = await failure('runtime-error.tsx', trusted);
    expect(e.diagnostic.code).toBe('OV_COMPILE_RUNTIME');
    expect(e.diagnostic.details?.['file']).toBe('runtime-error.tsx');
    expect(e.diagnostic.details?.['line']).toBe(12);
    expect(String(e.diagnostic.details?.['untrusted'])).toContain('broken on purpose');
  });

  it('forbids Node built-in modules with a diagnostic', async () => {
    const e = await failure('node-builtin.tsx', trusted);
    expect(e.diagnostic.code).toBe('OV_COMPILE_NODE_BUILTIN');
    expect(e.diagnostic.details).toMatchObject({ file: 'node-builtin.tsx', line: 1 });
  });

  it('reports a missing entry file', async () => {
    const e = await failure('missing.tsx', trusted);
    expect(e.diagnostic.code).toBe('OV_COMPILE_ENTRY');
  });

  it('compiles the A4 example and round-trips through exported JSON', async () => {
    const r = await compileTsx('auftrag-a4.tsx', { projectDir: a4Dir, mode: 'trusted-host' });
    expect(r.project.compositions[0]!.nodes.map((n) => n.type)).toEqual(['scene3d', 'text', 'subtitles']);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    const clamped = r.diagnostics.find((d) => d.code === 'OV_SDK_CLAMPED');
    expect(clamped?.details).toMatchObject({ file: 'auftrag-a4.tsx', line: 36 });

    const json = exportJson(r.project);
    expect(json).not.toMatch(/function|=>/);
    const reparsed: unknown = JSON.parse(json);
    expect(hasFunction(reparsed)).toBe(false);
    expect(reparsed).toEqual(r.project);
    expect(validateProject(reparsed).ok).toBe(true);
  });
});

describe.skipIf(skipUnless(!noDocker, 'Docker fehlt: compileTsx im Container braucht einen laufenden Docker-Daemon'))('compileTsx (docker, needs Docker)', () => {
  it('compiles the A4 example in the container', async () => {
    const r = await compileTsx(join(a4Dir, 'auftrag-a4.tsx'), { projectDir: a4Dir });
    expect(r.trusted).toBe(false);
    const scene = r.project.compositions[0]!.nodes[0];
    expect(at(scene, 'children', 0, 'id')).toBe('camera');
    expect(validateProject(r.project).ok).toBe(true);
    const local = await compileTsx('auftrag-a4.tsx', { projectDir: a4Dir, mode: 'trusted-host' });
    expect(r.project).toEqual(local.project);
    expect(r.bundleHash).toBe(local.bundleHash);
  });

  it('maps runtime errors to line 12 from inside the container', async () => {
    const e = await failure('runtime-error.tsx', { projectDir: fixtures });
    expect(e.diagnostic.details).toMatchObject({ file: 'runtime-error.tsx', line: 12 });
  });
});

describe('exportJson', () => {
  it('rejects functions instead of dropping them', async () => {
    const r = await compileTsx('sampled.tsx', trusted);
    const broken = { ...r.project, metadata: { title: (() => 'x') as unknown as string } };
    expect(() => exportJson(broken)).toThrow(/OV_EXPORT_NOT_JSON|function/);
    expect(await readFile(join(fixtures, 'sampled.tsx'), 'utf8')).toContain('frame * 2');
  });
});
