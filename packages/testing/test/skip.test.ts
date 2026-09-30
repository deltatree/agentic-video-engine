import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOpenVideoError } from '@agentic-video/core';
import { perfStrict, requireAll, skipUnless, skippedTests } from '@agentic-video/testing';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return isOpenVideoError(error) ? error.diagnostic.code : String(error);
  }
  return 'no error';
}

describe('skipUnless (Story 22.1, T12)', () => {
  it('überspringt nicht, wenn die Umgebung vorhanden ist', () => {
    expect(skipUnless(true, 'x', { env: { OPENVIDEO_REQUIRE_ALL: '1' } })).toBe(false);
  });

  it('überspringt lokal mit benannter Begründung und protokolliert sie', () => {
    expect(skipUnless(false, 'Piper fehlt (Test)', { env: {} })).toBe(true);
    expect(skippedTests()).toContainEqual({ reason: 'Piper fehlt (Test)', allowInCi: false });
  });

  it('macht mit OPENVIDEO_REQUIRE_ALL=1 jeden Skip zum Fehler', () => {
    expect(codeOf(() => skipUnless(false, 'Docker fehlt', { env: { OPENVIDEO_REQUIRE_ALL: '1' } }))).toBe('OV_TEST_SKIP_FORBIDDEN');
  });

  it('lässt Allowlist-Skips (GPU) auch in CI zu', () => {
    expect(skipUnless(false, 'keine GPU', { allowInCi: true, env: { OPENVIDEO_REQUIRE_ALL: '1' } })).toBe(true);
  });

  it('requireAll liest nur den Wert 1', () => {
    expect(requireAll({ OPENVIDEO_REQUIRE_ALL: '1' })).toBe(true);
    expect(requireAll({ OPENVIDEO_REQUIRE_ALL: 'true' })).toBe(false);
    expect(requireAll({})).toBe(false);
  });

  it('perfStrict liest OV_PERF_STRICT=1', () => {
    expect(perfStrict({ OV_PERF_STRICT: '1' })).toBe(true);
    expect(perfStrict({})).toBe(false);
  });

  it('kein Test überspringt mit rohem skipIf/runIf an skipUnless vorbei', () => {
    // Wächter gegen Rückfall: umgebungsabhängige Skips laufen immer über skipUnless.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'golden') continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.test\.tsx?$/.test(entry)) {
          const text = readFileSync(path, 'utf8');
          for (const m of text.matchAll(/\b(?:it|describe|test)\.(?:skipIf|runIf)\(([^)]*)/g)) {
            const cond = m[1] ?? '';
            if (!cond.includes('skipUnless') && !cond.includes('perfStrict')) offenders.push(`${path.slice(repoRoot.length)}: ${m[0]}`);
          }
        }
      }
    };
    for (const base of ['packages', 'apps', 'examples']) walk(join(repoRoot, base));
    expect(offenders).toEqual([]);
  });
});
