import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '@agentic-video/cli';

async function cli(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), cwd, env: process.env });
  return { code, stdout, stderr };
}

describe('CLI mit Templates, Workern und Worker-Befehl', () => {
  it('listet die 15 Templates', async () => {
    const r = await cli(['templates', '--json'], tmpdir());
    expect(r.code).toBe(0);
    const names = (JSON.parse(r.stdout) as { templates: { name: string }[] }).templates.map((t) => t.name);
    expect(names).toHaveLength(15);
    expect(names).toContain('logo-reveal');
  });

  it('legt ein Projekt aus einem Template an und rendert einen Frame', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ov-cli-tpl-'));
    expect((await cli(['create', 'reveal', '--template', 'logo-reveal'], root)).code).toBe(0);
    const dir = join(root, 'reveal');
    for (const f of ['src/video.tsx', 'README.md', 'project.json', 'openvideo.json']) expect(existsSync(join(dir, f)), f).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'openvideo.json'), 'utf8'))).toMatchObject({ entry: 'src/video.tsx' });
    // Eigener Code, darum --trusted: kompiliert auf dem Host statt im Container.
    const frame = await cli(['render-frame', '--frame', '2s', '--scale', '0.25', '--trusted', '--json'], dir);
    expect(frame.code, frame.stderr + frame.stdout).toBe(0);
    expect((JSON.parse(frame.stdout) as { width: number }).width).toBe(480);
  }, 120_000);

  it('meldet ein unbekanntes Template mit Exit-Code 1', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ov-cli-tpl-'));
    const r = await cli(['create', 'x', '--template', 'nope', '--json'], root);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('OV_TEMPLATE_UNKNOWN');
  });

  it('rendert mit --workers 2 dieselben Frames wie ohne Worker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ov-cli-workers-'));
    await cli(['create', 'demo'], root);
    const dir = join(root, 'demo');
    const args = ['render', '.', '--format', 'png-sequence', '--width', '192', '--height', '108', '--fps', '10', '--end', '1s', '--json'];
    const single = await cli([...args, '--out', join(dir, 'out', 'single')], dir);
    expect(single.code, single.stderr).toBe(0);
    const pooled = await cli([...args, '--out', join(dir, 'out', 'pooled'), '--workers', '2'], dir);
    expect(pooled.code, pooled.stderr + pooled.stdout).toBe(0);
    const a = JSON.parse(single.stdout) as { outputs: string[]; frames: number };
    const b = JSON.parse(pooled.stdout) as { outputs: string[]; frames: number };
    expect(b.frames).toBe(a.frames);
    const bytes = (list: string[]): string[] => list.map((f) => readFileSync(f).toString('base64'));
    expect(bytes(b.outputs)).toEqual(bytes(a.outputs));
  }, 180_000);

  it('verlangt für worker --stdio oder --coordinator', async () => {
    expect((await cli(['worker'], tmpdir())).code).toBe(2);
  });
});
