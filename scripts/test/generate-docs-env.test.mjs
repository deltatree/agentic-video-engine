// CI-Befund 2026-10-02: `generate-docs --check` war in CI rot, weil dort Blender installiert ist und das
// Blender-Backend seine Version in docs/ai/capabilities.json schrieb. Die Ausgabe darf nicht von der Maschine abhängen.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Legt ein ausführbares Fake-Blender an, das eine Version meldet. */
function fakeBlender(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '#!/bin/sh\necho "Blender 4.2.23"\n');
  chmodSync(path, 0o755);
}

describe('scripts/generate-docs.mjs ist unabhängig von installierten Programmen', () => {
  it('eine installierte Blender-Version (OPENVIDEO_BLENDER, PATH, ~/.local/opt) ändert die generierten Dateien nicht', () => {
    const base = mkdtempSync(join(tmpdir(), 'ov-gendocs-env-'));
    const bin = join(base, 'bin');
    fakeBlender(join(bin, 'blender'));
    const home = join(base, 'home');
    fakeBlender(join(home, '.local', 'opt', 'blender-4.2.23-linux-x64', 'blender'));
    const env = { ...process.env, OPENVIDEO_BLENDER: join(bin, 'blender'), PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home };
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'generate-docs.mjs'), '--check'], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000 });
    expect(r.stdout + r.stderr).not.toContain('out of date');
    expect(r.status).toBe(0);
  }, 150_000);
});
