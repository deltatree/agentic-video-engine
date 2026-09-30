// Story 19.8 (Audit pm-agent-dx #13): .gitignore ignoriert persönliche Agent-Dateien nur im Root;
// die Agent-Doku des Repositorys und die MCP-Beispielkonfiguration bleiben versioniert.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Ignoriert git den Pfad? (`git check-ignore --no-index` prüft nur die Regeln, nicht den Index.) */
function ignored(path) {
  const r = spawnSync('git', ['check-ignore', '--no-index', '-q', path], { cwd: ROOT });
  if (r.status !== 0 && r.status !== 1) throw new Error(`git check-ignore failed: ${String(r.stderr)}`);
  return r.status === 0;
}

describe('.gitignore (Story 19.8)', () => {
  it.each(['AGENTS.md', 'docs/ai/AGENTS.md', 'docs/ai/AGENTS.de.md', 'examples/mcp.json', 'examples/product-launch/.mcp.json', 'docs/guide/CLAUDE.md'])('versioniert %s', (path) => {
    expect(ignored(path)).toBe(false);
  });

  it.each(['CLAUDE.md', '.mcp.json', 'AGENTS.local.md', 'packages/cli/AGENTS.local.md', 'docs/api/README.md'])('ignoriert %s', (path) => {
    expect(ignored(path)).toBe(true);
  });
});
