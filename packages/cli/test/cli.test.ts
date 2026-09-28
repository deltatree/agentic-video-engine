import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '@agentic-video/cli';

async function cli(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), cwd, env: process.env });
  return { code, stdout, stderr };
}

const ffprobe = join(process.env['HOME'] ?? '', '.local/bin/ffprobe');

describe('openvideo CLI (FR-77, FR-78)', () => {
  it('legt ein Projekt an, prüft es und rendert einen Frame', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ov-cli-'));
    expect((await cli(['create', 'hello'], root)).code).toBe(0);
    const dir = join(root, 'hello');
    for (const f of ['openvideo.json', 'project.json', 'AGENTS.md', '.gitignore']) expect(existsSync(join(dir, f)), f).toBe(true);
    const validate = await cli(['validate', '--json'], dir);
    expect(validate.code).toBe(0);
    expect((JSON.parse(validate.stdout) as { ok: boolean }).ok).toBe(true);
    const frame = await cli(['render-frame', '--frame', '1s', '--scale', '0.25', '--json'], dir);
    expect(frame.code).toBe(0);
    const info = JSON.parse(frame.stdout) as { file: string; width: number; frame: number; diagnostics: { severity: string }[] };
    expect(info).toMatchObject({ width: 480, frame: 30 });
    expect(info.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(readFileSync(info.file).subarray(1, 4).toString()).toBe('PNG');
  });

  it('rendert wie im Auftrag A28 mit Composition, Format, Codec, Maßen und fps', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ov-cli-'));
    await cli(['create', 'demo'], root);
    const dir = join(root, 'demo');
    const r = await cli(['render', '.', '--composition', 'main', '--format', 'mp4', '--codec', 'h264', '--width', '384', '--height', '216', '--fps', '10', '--end', '1s', '--json'], dir);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { outputs: string[]; frames: number };
    expect(out.frames).toBe(10);
    const probe = execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,r_frame_rate', '-of', 'csv=p=0', out.outputs[0] ?? '']).toString().trim();
    expect(probe).toBe('h264,384,216,10/1');
  });

  it('liefert Exit-Code 1 bei Projektfehlern und 2 bei Bedienfehlern', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ov-cli-'));
    await cli(['create', 'bad'], root);
    const dir = join(root, 'bad');
    const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as { compositions: { nodes: { fontSize?: unknown }[] }[] };
    const node = project.compositions[0]?.nodes[1];
    if (node !== undefined) node.fontSize = 'huge';
    writeFileSync(join(dir, 'project.json'), JSON.stringify(project));
    const v = await cli(['validate'], dir);
    expect(v.code).toBe(1);
    expect(v.stderr).toContain('composition.main.nodes.headline.fontSize');
    expect((await cli(['frobnicate'], dir)).code).toBe(2);
    expect((await cli(['render-frame'], dir)).code).toBe(2);
    expect((await cli(['--help'], dir)).code).toBe(0);
  });

  it('kompiliert und rendert ein TSX-Projekt mit --trusted', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ov-cli-'));
    expect((await cli(['create', 'tsx', '--tsx'], root)).code).toBe(0);
    const dir = join(root, 'tsx');
    const v = await cli(['validate', '--trusted', '--json'], dir);
    expect(v.code).toBe(0);
    const f = await cli(['render-frame', '--trusted', '--frame', '45', '--scale', '0.25', '--json'], dir);
    expect(f.code).toBe(0);
  });

  it('zeigt Timeline und Szenenbaum', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ov-cli-'));
    await cli(['create', 'insp'], root);
    const dir = join(root, 'insp');
    const t = await cli(['inspect', '--timeline', '--json'], dir);
    expect((JSON.parse(t.stdout) as { durationFrames: number }).durationFrames).toBe(150);
    const s = await cli(['inspect', '--frame', '2s'], dir);
    expect(s.stdout).toContain('text "headline"');
  });
});
