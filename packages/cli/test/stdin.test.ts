import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stdinClosed } from '../src/stdin.js';

const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

describe('stdinClosed', () => {
  it('kehrt sofort zurück, wenn der Strom schon beendet ist', async () => {
    const s = new PassThrough();
    s.end();
    s.resume();
    await new Promise((r) => s.once('end', r));
    await expect(stdinClosed(s)).resolves.toBeUndefined();
  });

  it('wartet auf das Ende eines offenen Stroms', async () => {
    const s = new PassThrough();
    let done = false;
    const p = stdinClosed(s).then(() => { done = true; });
    await new Promise((r) => setImmediate(r));
    expect(done).toBe(false);
    s.end();
    await p;
    expect(done).toBe(true);
  });

  it('openvideo mcp beendet sich mit Exit-Code 0, wenn stdin sofort leer ist', () => {
    const ws = mkdtempSync(join(tmpdir(), 'ov-mcp-eof-'));
    const r = spawnSync(process.execPath, [BIN, 'mcp', '--workspace', ws], { input: '', encoding: 'utf8', timeout: 30_000 });
    expect(r.stderr).not.toContain('unsettled top-level await');
    expect(r.status).toBe(0);
  });
});
