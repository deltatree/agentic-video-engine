// SETUP.md: `npm run setup` richtet OpenVideo aus dem Quellcode ein; der Plan ist ohne Ausführung prüfbar.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'setup.mjs');

function plan(...extra) {
  const r = spawnSync(process.execPath, [SCRIPT, '--dry-run', ...extra], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout);
}

describe('scripts/setup.mjs', () => {
  it('plant install, build, browser, link und doctor in dieser Reihenfolge', () => {
    const p = plan();
    expect(p.steps.map((s) => s.name)).toEqual(['install', 'build', 'browser', 'link', 'doctor']);
    expect(p.steps.find((s) => s.name === 'link').command).toContain('install -g ./packages/cli');
    expect(p.problems.node).toBeUndefined();
  });

  it('lässt Schritte per Option weg und reicht --with-deps an Playwright', () => {
    const p = plan('--skip-install', '--no-link', '--with-deps');
    expect(p.steps.map((s) => s.name)).toEqual(['build', 'browser', 'doctor']);
    expect(p.steps[1].command).toContain('--with-deps');
  });

  it('lehnt unbekannte Optionen mit Exit-Code 2 ab', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--bogus'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Unknown option --bogus');
  });

  it('ist als npm run setup eingetragen, und SETUP.md nennt jeden Schalter', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.setup).toBe('node scripts/setup.mjs');
    const doc = readFileSync(join(ROOT, 'SETUP.md'), 'utf8');
    for (const flag of ['--skip-install', '--skip-build', '--skip-browser', '--with-deps', '--no-link', '--dry-run']) expect(doc).toContain(flag);
  });
});
