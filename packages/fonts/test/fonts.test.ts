import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentHash, type IrProject } from '@agentic-video/core';
import { BUNDLED_FONTS, bundledFontPath, checkFontUsage, closestFamily, fontManifest, fontSetFromBytes, loadFontSet, parseFontInfo } from '@agentic-video/fonts';

const interBytes = new Uint8Array(readFileSync(bundledFontPath('inter/InterVariable.ttf')));

describe('parseFontInfo', () => {
  it('reads family, weight axis and style of Inter', () => {
    const info = parseFontInfo(interBytes);
    expect(info.family).toMatch(/Inter/u);
    expect(info.italic).toBe(false);
    const wght = info.axes.find((a) => a.tag === 'wght');
    expect(wght).toEqual({ tag: 'wght', min: 100, default: 400, max: 900 });
  });

  it('detects italic faces', () => {
    const info = parseFontInfo(new Uint8Array(readFileSync(bundledFontPath('inter/InterVariable-Italic.ttf'))));
    expect(info.italic).toBe(true);
  });

  it('rejects files that are not fonts with OV_FONT_INVALID', () => {
    expect(() => parseFontInfo(new TextEncoder().encode('hello world, not a font'))).toThrow(/not a TrueType/u);
    try {
      parseFontInfo(new TextEncoder().encode('wOF2 and some more bytes'));
    } catch (error: unknown) {
      expect(error).toMatchObject({ diagnostic: { code: 'OV_FONT_INVALID' } });
    }
  });
});

describe('loadFontSet', () => {
  it('loads the bundled defaults with hashes and licenses', async () => {
    const set = await loadFontSet();
    expect(set.diagnostics).toEqual([]);
    expect(set.families()).toEqual(['Inter', 'JetBrains Mono', 'Noto Color Emoji']);
    expect(set.all()).toHaveLength(BUNDLED_FONTS.length);
    expect(set.has('inter')).toBe(true);
    expect(set.has('Nope')).toBe(false);
    expect(set.fallbacks()[0]).toBe('Noto Color Emoji');
    const inter = set.faces().find((f) => f.family === 'Inter' && f.style === 'normal');
    expect(inter?.variable).toBe(true);
    expect(inter?.weight).toEqual([100, 900]);
    expect(inter?.hash).toBe(contentHash(interBytes));
    for (const dir of ['inter', 'jetbrains-mono', 'noto-color-emoji']) {
      expect(readFileSync(bundledFontPath(`${dir}/OFL.txt`), 'utf8')).toMatch(/SIL Open Font License,\s+Version 1\.1/u);
    }
  });

  it('loads project fonts from src and assets, and reports missing and invalid ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-fonts-'));
    writeFileSync(join(dir, 'brand.ttf'), interBytes);
    writeFileSync(join(dir, 'broken.ttf'), 'not a font');
    const set = await loadFontSet({
      projectDir: dir,
      includeDefaults: false,
      resolveAsset: (id) => (id === 'mono' ? Promise.resolve({ path: '/store/mono.ttf', bytes: interBytes }) : Promise.reject(new Error('unknown asset'))),
      fonts: [
        { family: 'Brand', src: 'brand.ttf', weight: '200 800' },
        { family: 'Mono', asset: 'mono', style: 'italic' },
        { family: 'Gone', src: 'gone.ttf' },
        { family: 'Broken', src: 'broken.ttf' },
        { family: 'Lost', asset: 'lost' },
        { family: 'Hashed', src: 'brand.ttf', hash: `sha256:${'0'.repeat(64)}` },
      ],
    });
    expect(set.families()).toEqual(['Brand', 'Mono', 'Hashed']);
    expect(set.faces()[0]?.weight).toEqual([200, 800]);
    expect(set.faces()[1]?.style).toBe('italic');
    expect(set.diagnostics.map((d) => d.code)).toEqual(['OV_FONT_MISSING', 'OV_FONT_INVALID', 'OV_FONT_MISSING', 'OV_FONT_HASH_MISMATCH']);
    for (const d of set.diagnostics) expect(d.suggestions.length).toBeGreaterThan(0);
    expect(set.diagnostics[0]?.pointer).toBe('/fonts/2');
  });

  it('builds a font set from bytes', () => {
    const set = fontSetFromBytes([{ family: 'X', bytes: interBytes, path: 'x.ttf' }, { family: 'Bad', bytes: new Uint8Array(4), path: 'bad.ttf' }]);
    expect(set.families()).toEqual(['X']);
    expect(set.diagnostics[0]?.code).toBe('OV_FONT_INVALID');
  });
});

describe('checkFontUsage and fontManifest', () => {
  it('reports unknown families with the closest loaded name', async () => {
    const set = await loadFontSet();
    const project: IrProject = {
      schemaVersion: '1.0.0',
      settings: { defaultFont: 'Helvetica' },
      compositions: [
        {
          id: 'main',
          width: 100,
          height: 100,
          fps: 30,
          duration: 30,
          nodes: [
            { id: 'ok', type: 'text', text: 'a', fontFamily: 'Inter' },
            { id: 'bad', type: 'text', text: 'b', fontFamily: 'Intr' },
            { id: 'g', type: 'group', children: [{ id: 'rich', type: 'rich-text', spans: [{ text: 'x', fontFamily: 'Nope' }] }] },
          ],
        },
      ],
    };
    const d = checkFontUsage(project, set);
    expect(d.map((x) => x.path)).toEqual(['settings.defaultFont', 'composition.main.nodes.bad.fontFamily', 'composition.main.nodes.g.children.rich.spans[0].fontFamily']);
    expect(d[1]?.suggestions[0]).toBe('Use fontFamily "Inter".');
    expect(d[1]?.pointer).toBe('/compositions/0/nodes/1/fontFamily');
    expect(closestFamily('jetbrains', set)).toBe('JetBrains Mono');
  });

  it('lists every face for the render manifest', async () => {
    const set = await loadFontSet();
    const manifest = fontManifest(set);
    expect(manifest).toHaveLength(set.all().length);
    expect(manifest[0]).toEqual({ family: 'Inter', weight: [100, 900], style: 'normal', hash: contentHash(interBytes), path: bundledFontPath('inter/InterVariable.ttf') });
  });
});
