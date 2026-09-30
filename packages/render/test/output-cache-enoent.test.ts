/**
 * Review m4: Verschwindet die Datei eines Eintrags der Ebene `encoding` zwischen Lesen des Eintrags
 * und Kopieren (z. B. paralleles `prune`), ist das ein Fehlgriff – der Render kodiert frisch.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FileStore, createCache } from '@agentic-video/cache';
import { SCHEMA_VERSION } from '@agentic-video/core';
import { createNodeEnvironment, renderVideo, type NodeEnvironment } from '@agentic-video/render';

/** Schaltbarer Fehler beim Kopieren aus dem Cache: simuliert einen parallelen `prune`. */
const race = vi.hoisted(() => ({ active: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    copyFile: async (src: Parameters<typeof actual.copyFile>[0], dest: Parameters<typeof actual.copyFile>[1], mode?: number) => {
      if (race.active && String(src).includes('/encoding/')) {
        // `prune` löscht die Datei zwischen Lesen des Eintrags und Kopieren.
        await actual.rm(src, { force: true });
      }
      return actual.copyFile(src, dest, mode);
    },
  };
});

const project = {
  schemaVersion: SCHEMA_VERSION,
  compositions: [{ id: 'main', width: 32, height: 18, fps: 10, duration: 4, background: '#202020', nodes: [{ id: 'r', type: 'rect', width: 10, height: 10, fill: '#FF0000' }] }],
};

let dir: string;
let env: NodeEnvironment;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ov-output-enoent-'));
  env = await createNodeEnvironment({ projectDir: dir, project, cache: createCache(new FileStore(join(dir, 'cache'))), skipDefaultProviders: true });
});

afterAll(async () => {
  race.active = false;
  await env.dispose();
});

describe('restoreOutput bei parallelem Aufräumen (Review m4)', () => {
  it('ENOENT beim Kopieren ist ein Fehlgriff: frisch kodieren statt abbrechen', async () => {
    const profile = { format: 'mp4', codec: 'h264' };
    expect((await renderVideo(env, project, { outPath: join(dir, 'a.mp4'), profile })).manifest.cache.output).toBe('miss');
    race.active = true;
    const again = await renderVideo(env, project, { outPath: join(dir, 'b.mp4'), profile });
    expect(again.manifest.cache.output).toBe('miss');
    expect(again.manifest.cache.framesFromCache).toBe(4);
    expect(again.outputs).toEqual([join(dir, 'b.mp4')]);
  }, 60_000);
});
