/**
 * Story 17.9: WOFF2 wird beim Import zu SFNT normalisiert; TTC wird erkannt.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { fontContainer } from '@agentic-video/fonts';
import { detectFormat, importAsset, resolveProjectAssets } from '@agentic-video/assets';

const WOFF2 = join(import.meta.dirname, '../../fonts/test/fixtures/noto-sans-hebrew/NotoSansHebrew-Regular.woff2');

describe('Schriften beim Import (Story 17.9)', () => {
  it('normalisiert WOFF2 zu TTF und behält die Metadaten', async () => {
    const project = mkdtempSync(join(tmpdir(), 'ov-font-'));
    const cache = createCache(new MemoryStore());
    const r = await importAsset(project, { path: WOFF2, id: 'hebrew' }, { cache, allowOutsidePaths: true });
    expect(r.type).toBe('font');
    expect(r.metadata['format']).toBe('woff2');
    expect(r.metadata['container']).toBe('woff2');
    expect(r.metadata['family']).toBe('Noto Sans Hebrew');
    const assets = await resolveProjectAssets(project, { assets: [{ id: 'hebrew', type: 'font', src: r.src }] }, { cache });
    const record = assets.get('hebrew');
    expect(record?.path.endsWith('.ttf')).toBe(true);
    expect(fontContainer(new Uint8Array(readFileSync(record?.path ?? '')))).toBe('sfnt');
  });

  it('erkennt Schriftsammlungen an Endung und Signatur', () => {
    expect(detectFormat('family.ttc', new Uint8Array([0x74, 0x74, 0x63, 0x66, 0, 1, 0, 0]))).toMatchObject({ type: 'font', format: 'ttc' });
    expect(detectFormat('family.otc', new Uint8Array(0))).toMatchObject({ type: 'font', format: 'ttc' });
  });
});
