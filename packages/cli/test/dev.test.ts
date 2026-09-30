/**
 * Story 20.1 (Audit §47): `openvideo dev` beobachtet src/** und project.json und öffnet den Browser.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SourceService } from '@agentic-video/agent';
import { browserCommand, cannotOpenReason, isWatchedPath, runCli, watchProject, type WatchEvent } from '@agentic-video/cli';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'ov-dev-'));
}

const until = async (check: () => boolean, ms = 8000): Promise<void> => {
  for (let waited = 0; !check(); waited += 25) {
    if (waited > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('Browser öffnen', () => {
  it('wählt den Befehl je Plattform', () => {
    expect(browserCommand('darwin', 'http://x/')).toEqual({ command: 'open', args: ['http://x/'] });
    expect(browserCommand('linux', 'http://x/')).toEqual({ command: 'xdg-open', args: ['http://x/'] });
    expect(browserCommand('win32', 'http://x/?a=1#token=b')).toEqual({ command: 'rundll32', args: ['url.dll,FileProtocolHandler', 'http://x/?a=1#token=b'] });
  });

  it('öffnet nichts in CI und ohne grafische Sitzung', () => {
    expect(cannotOpenReason('linux', {})).toMatch(/graphical/u);
    expect(cannotOpenReason('linux', { DISPLAY: ':0' })).toBeUndefined();
    expect(cannotOpenReason('darwin', { CI: 'true' })).toBe('running in CI');
    expect(cannotOpenReason('darwin', {})).toBeUndefined();
  });
});

describe('watchProject', () => {
  it('filtert Pfade', () => {
    expect(isWatchedPath('src/a/b.tsx', 'src/video.tsx')).toBe(true);
    expect(isWatchedPath('project.json', 'src/video.tsx')).toBe(true);
    expect(isWatchedPath('out/frames/x.png', 'project.json')).toBe(false);
    expect(isWatchedPath('.openvideo/workspace/x', 'project.json')).toBe(false);
    expect(isWatchedPath('src/.#video.tsx', 'src/video.tsx')).toBe(false);
    expect(isWatchedPath('project.json.1234.tmp', 'project.json')).toBe(false);
    expect(isWatchedPath('scenes/intro.tsx', 'scenes/intro.tsx')).toBe(true);
  });

  it('meldet Änderungen und JSON-Fehler eines JSON-Projekts', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'project.json'), '{}');
    const events: WatchEvent[] = [];
    const watcher = watchProject({ dir, entry: 'project.json', debounceMs: 20, onEvent: (e) => events.push(e) });
    try {
      writeFileSync(join(dir, 'project.json'), '{ "broken": ');
      await until(() => events.some((e) => e.kind === 'error'));
      writeFileSync(join(dir, 'project.json'), '{ "fixed": true }');
      await until(() => events.some((e) => e.kind === 'changed'));
    } finally {
      watcher.close();
    }
  });

  it('kompiliert TSX-Projekte bei Änderungen in src/** neu und schreibt project.json', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'src', 'scenes'), { recursive: true });
    writeFileSync(join(dir, 'src', 'video.tsx'), 'export default 1;');
    writeFileSync(join(dir, 'project.json'), '{}\n');
    let compiles = 0;
    const sources: SourceService = {
      compile: () => {
        compiles++;
        const text = readFileSync(join(dir, 'src', 'scenes', 'title.txt'), 'utf8');
        if (text === 'bad') return Promise.resolve({ project: {}, diagnostics: [{ code: 'OV_TSX_SYNTAX', severity: 'error', errorClass: 'CompileError', problem: 'Unexpected token.', suggestions: [] }] });
        return Promise.resolve({ project: { title: text }, diagnostics: [] });
      },
      writeBack: () => Promise.resolve({ applied: 0, diagnostics: [] }),
    };
    writeFileSync(join(dir, 'src', 'scenes', 'title.txt'), 'first');
    const events: WatchEvent[] = [];
    const watcher = watchProject({ dir, entry: 'src/video.tsx', sources, debounceMs: 20, onEvent: (e) => events.push(e) });
    try {
      writeFileSync(join(dir, 'src', 'scenes', 'title.txt'), 'second');
      await until(() => events.some((e) => e.kind === 'compiled'));
      await watcher.idle();
      expect(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))).toEqual({ title: 'second' });
      // Der eigene Schreibvorgang an project.json löst keine weitere Kompilierung aus.
      const after = compiles;
      await new Promise((r) => setTimeout(r, 150));
      expect(compiles).toBe(after);
      writeFileSync(join(dir, 'src', 'scenes', 'title.txt'), 'bad');
      await until(() => events.some((e) => e.kind === 'error'));
      expect(JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))).toEqual({ title: 'second' });
    } finally {
      watcher.close();
    }
  });
});

describe('openvideo dev', () => {
  async function dev(args: readonly string[]): Promise<{ stdout: () => string; opened: string[]; stop: () => Promise<number>; dir: string }> {
    const root = tmp();
    await runCli(['create', 'demo'], { stdout: () => undefined, stderr: () => undefined, cwd: root, env: {} });
    let stdout = '';
    let stop: () => void = () => undefined;
    const stopped = new Promise<void>((r) => {
      stop = r;
    });
    const opened: string[] = [];
    const studio = tmp();
    writeFileSync(join(studio, 'index.html'), '<!doctype html><title>Studio</title>');
    const done = runCli(['dev', join(root, 'demo'), '--port', '0', ...args], {
      stdout: (t) => (stdout += t),
      stderr: () => undefined,
      cwd: root,
      env: { OPENVIDEO_STUDIO_DIR: studio },
      stop: stopped,
      openUrl: (url) => {
        opened.push(url);
        return Promise.resolve(undefined);
      },
    });
    await until(() => stdout.includes('Watching'), 30_000);
    return {
      stdout: () => stdout,
      opened,
      dir: join(root, 'demo'),
      stop: () => {
        stop();
        return done;
      },
    };
  }

  it('öffnet das Studio mit Projekt und Token im Fragment und beobachtet project.json', async () => {
    const run = await dev([]);
    try {
      expect(run.opened.length).toBe(1);
      expect(run.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?project=demo#token=[A-Za-z0-9_-]{32,}$/u);
      const file = join(run.dir, 'project.json');
      const project: unknown = JSON.parse(readFileSync(file, 'utf8'));
      writeFileSync(file, `${JSON.stringify(project, null, 1)}\n`);
      await until(() => run.stdout().includes('project.json changed'));
    } finally {
      expect(await run.stop()).toBe(0);
    }
  });

  it('--no-open öffnet nichts', async () => {
    const run = await dev(['--no-open']);
    expect(run.opened).toEqual([]);
    expect(await run.stop()).toBe(0);
  });
});
