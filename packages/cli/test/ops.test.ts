/**
 * Story 19.2 und 19.4: CLI-Parität (`op`, `patch`, `contact-sheet`, `import`) und `--project`.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATIONS } from '@agentic-video/agent';
import { parseInputArg, projectRootsOf, runCli, withDefaults } from '@agentic-video/cli';

async function cli(args: string[], cwd: string, env: Record<string, string | undefined> = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(args, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), cwd, env });
  return { code, stdout, stderr };
}

async function project(): Promise<{ root: string; dir: string }> {
  const root = mkdtempSync(join(tmpdir(), 'ov-cli-ops-'));
  expect((await cli(['create', 'demo'], root)).code).toBe(0);
  return { root, dir: join(root, 'demo') };
}

describe('openvideo op (ADR 0009)', () => {
  it('listet alle Operationen aus OPERATIONS', async () => {
    const r = await cli(['op', '--list', '--json'], tmpdir());
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as { name: string }[]).map((o) => o.name)).toEqual([...OPERATIONS.keys()]);
  });

  it('ruft eine Operation im Projekt des aktuellen Ordners auf (projectId und inline ergänzt)', async () => {
    const { dir } = await project();
    const v = await cli(['op', 'composition.validate'], dir);
    expect(v.code).toBe(0);
    expect((JSON.parse(v.stdout) as { ok: boolean }).ok).toBe(true);
    const f = await cli(['op', 'frame.render', '--input', '{"frame": "1s", "scale": 0.1}'], dir);
    expect(f.code).toBe(0);
    const image = (JSON.parse(f.stdout) as { image: { file: string; base64?: string } }).image;
    expect(image.base64).toBeUndefined();
    expect(readFileSync(image.file).subarray(1, 4).toString()).toBe('PNG');
  });

  it('liest die Eingabe aus einer Datei und meldet Fehler mit Exit-Code 1', async () => {
    const { dir } = await project();
    writeFileSync(join(dir, 'in.json'), JSON.stringify({ nodeType: 'txt' }));
    const r = await cli(['op', 'capabilities.get', '--input', '@in.json', '--json'], dir);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('Did you mean \\"text\\"');
    expect((await cli(['op', 'composition.validate', '--input', '{bad'], dir)).code).toBe(1);
    expect((await cli(['op'], dir)).code).toBe(2);
  });

  it('wartet bei Job-Operationen auf das Ende', async () => {
    const { dir } = await project();
    const r = await cli(['op', 'preview.render', '--input', '{"scale": 0.1, "end": 3}'], dir);
    expect(r.code).toBe(0);
    const job = JSON.parse(r.stdout) as { state: string; result: { outputs: { file: string }[] } };
    expect(job.state).toBe('succeeded');
    expect(existsSync(job.result.outputs[0]?.file ?? '')).toBe(true);
  });
});

describe('Kurzbefehle patch, contact-sheet, import', () => {
  it('patch wendet eine Patch-Liste an und meldet Fehler mit Pfad', async () => {
    const { dir } = await project();
    const ok = await cli(['patch', '--input', JSON.stringify([{ op: 'setProperty', nodeId: 'headline', property: 'fontSize', value: 90 }])], dir);
    expect(ok.code).toBe(0);
    const saved = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as { compositions: { nodes: { id: string; fontSize?: number }[] }[] };
    expect(saved.compositions[0]?.nodes.find((n) => n.id === 'headline')?.fontSize).toBe(90);
    const bad = await cli(['patch', '.', '--json', '--input', JSON.stringify([{ op: 'setProperty', nodeId: 'headlin', property: 'x', value: 1 }])], dir);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain('Did you mean \\"headline\\"?');
  });

  it('contact-sheet schreibt das Bild nach --out', async () => {
    const { dir, root } = await project();
    const r = await cli(['contact-sheet', dir, '--frames', '0,1s', '--out', join(root, 'sheet.png')], root);
    expect(r.code).toBe(0);
    expect(readFileSync(join(root, 'sheet.png')).subarray(1, 4).toString()).toBe('PNG');
  });

  it('import übernimmt eine SVG-Datei von außerhalb des Projekts', async () => {
    const { dir, root } = await project();
    writeFileSync(join(root, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="4" fill="#FF5A1F"/></svg>');
    const r = await cli(['import', join(root, 'logo.svg'), dir, '--id-prefix', 'logo'], root);
    expect(r.code).toBe(0);
    const saved = readFileSync(join(dir, 'project.json'), 'utf8');
    expect(saved).toContain('"id": "logo"');
  });
});

describe('--project und project.open (Story 19.4)', () => {
  it('öffnet mit --project und --workspace Ordner unterhalb der Wurzel', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ov-cli-roots-'));
    await cli(['create', 'one'], root);
    mkdirSync(join(root, 'ws'));
    const r = await cli(['op', 'project.open', '--project', join(root, 'one'), '--workspace', join(root, 'ws'), '--input', JSON.stringify({ path: join(root, 'one') })], root);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as { projectId: string }).projectId).toBe('one');
    const outside = await cli(['op', 'project.open', '--project', join(root, 'one'), '--workspace', join(root, 'ws'), '--input', JSON.stringify({ path: root })], root);
    expect(outside.code).toBe(1);
    expect(outside.stderr).toContain('outside the allowed project roots');
  });

  it('serve --project zeigt das Projekt und bedient es über die API', async () => {
    const { dir, root } = await project();
    let stdout = '';
    let stop: () => void = () => undefined;
    const stopped = new Promise<void>((r) => {
      stop = r;
    });
    const done = runCli(['serve', '--project', dir, '--port', '0'], { stdout: (t) => (stdout += t), stderr: () => undefined, cwd: root, env: { PATH: process.env['PATH'] }, stop: stopped });
    for (let i = 0; i < 200 && !stdout.includes('/v1/operations'); i++) await new Promise((r) => setTimeout(r, 25));
    const api = /(http:\/\/127\.0\.0\.1:\d+)\/v1\/operations/u.exec(stdout)?.[1];
    const res = await fetch(`${api ?? ''}/v1/project.inspect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'demo' }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { compositions: unknown[] }).compositions).toHaveLength(1);
    stop();
    expect(await done).toBe(0);
  });

  it('meldet ein fehlendes Projekt bei --project', async () => {
    const r = await cli(['mcp', '--project', join(tmpdir(), 'ov-no-such-project')], tmpdir());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('No project found');
  });

  it('Hilfsfunktionen: Eingabe, Vorgaben, Wurzeln', async () => {
    expect(await parseInputArg('{"a":1}', '/')).toEqual({ a: 1 });
    expect(await parseInputArg(undefined, '/')).toEqual({});
    expect(withDefaults('frame.render', { frame: 0 }, 'demo')).toEqual({ projectId: 'demo', inline: false, frame: 0 });
    expect(withDefaults('templates.list', {}, 'demo')).toEqual({});
    expect(projectRootsOf(['/a'], { OPENVIDEO_PROJECT_ROOTS: 'b, /c' }, '/w')).toEqual(['/a', '/w/b', '/c']);
  });
});
