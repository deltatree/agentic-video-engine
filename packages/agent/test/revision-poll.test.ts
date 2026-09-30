/**
 * ADR 0029: Der RevisionWatcher fragt optional ab (`watchPollMs`), weil Bind-Mounts von Containern unter
 * macOS/Windows Änderungen vom Host nicht als Dateiereignis melden. Nachgestellt unter Linux mit einem
 * Hardlink: Schreiben über den zweiten Pfad erzeugt kein Ereignis im beobachteten Ordner.
 */
import { linkSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RevisionWatcher, revisionOf } from '@agentic-video/agent';
import { skipUnless } from '@agentic-video/testing';

const linux = process.platform === 'linux';

function setup(): { dir: string; other: string } {
  const root = mkdtempSync(join(tmpdir(), 'ov-revpoll-'));
  const dir = join(root, 'project');
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(dir);
  mkdirSync(elsewhere);
  writeFileSync(join(dir, 'project.json'), '{"v":1}\n');
  const other = join(elsewhere, 'alias.json');
  linkSync(join(dir, 'project.json'), other);
  return { dir, other };
}

describe('RevisionWatcher mit Abfrage', () => {
  it.skipIf(skipUnless(linux, 'inotify-Verhalten bei Hardlinks gibt es nur unter Linux'))('ohne Abfrage bleibt eine Änderung ohne Dateiereignis unbemerkt', async () => {
    const { dir, other } = setup();
    const watcher = new RevisionWatcher(10);
    const seen: string[] = [];
    const stop = await watcher.subscribe(dir, (r) => seen.push(r));
    try {
      writeFileSync(other, '{"v":2}\n');
      await new Promise((r) => setTimeout(r, 400));
      expect(seen).toEqual([]);
    } finally {
      stop();
      watcher.closeAll();
    }
  });

  it.skipIf(skipUnless(linux, 'inotify-Verhalten bei Hardlinks gibt es nur unter Linux'))('mit Abfrage meldet er die neue Revision', async () => {
    const { dir, other } = setup();
    const watcher = new RevisionWatcher(10, 50);
    const seen: string[] = [];
    const stop = await watcher.subscribe(dir, (r) => seen.push(r));
    try {
      writeFileSync(other, '{"v":2}\n');
      await expect.poll(() => seen, { timeout: 5000 }).toEqual([revisionOf(new TextEncoder().encode('{"v":2}\n'))]);
    } finally {
      stop();
      watcher.closeAll();
    }
  });
});
