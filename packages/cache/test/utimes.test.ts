/**
 * Regressionstest zu A15: Ein Fehler beim Vermerken der Nutzung (`utimes`) darf einen
 * Cache-Treffer nicht in einen Lesefehler verwandeln.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    utimes: () => Promise.reject(Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' })),
  };
});

describe('A15: utimes-Fehler', () => {
  it('liefert den Treffer trotzdem', async () => {
    const { FileStore } = await import('@agentic-video/cache');
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'ov-cache-utimes-')));
    await store.put('frame/abc', new TextEncoder().encode('hit'));
    expect(new TextDecoder().decode(await store.get('frame/abc'))).toBe('hit');
  });
});
