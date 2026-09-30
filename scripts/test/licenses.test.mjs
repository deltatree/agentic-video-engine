// Story 22.6: `licenses --check` erkennt veraltete Inventare; Inventar je Container-Image.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INVENTORY_FILES, buildInventory, imageInventory, staleFiles } from '../licenses.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('licenses.mjs (Story 22.6)', () => {
  const { files, problems } = buildInventory(ROOT);

  it('erzeugt alle drei Inventar-Dateien ohne verbotene Lizenzen', () => {
    expect(Object.keys(files).sort()).toEqual([...INVENTORY_FILES].sort());
    expect(problems).toEqual([]);
  });

  it('--check erkennt fehlende und veraltete Dateien', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-licenses-'));
    expect(staleFiles(dir, files).sort()).toEqual([...INVENTORY_FILES].sort());
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    expect(staleFiles(dir, files)).toEqual([]);
    writeFileSync(join(dir, 'THIRD_PARTY_NOTICES.md'), `${files['THIRD_PARTY_NOTICES.md']}\nedited by hand\n`);
    expect(staleFiles(dir, files)).toEqual(['THIRD_PARTY_NOTICES.md']);
  });

  it('das eingecheckte Inventar ist aktuell', () => {
    expect(staleFiles(ROOT, files)).toEqual([]);
  });

  it('weist je Image FFmpeg, Chromium und Blender ehrlich aus', () => {
    const images = Object.fromEntries(imageInventory(ROOT).map((i) => [i.image, i.contents]));
    expect(Object.keys(images)).toEqual(['openvideo-base', 'openvideo-render-cpu', 'openvideo-render-gpu', 'openvideo-blender', 'openvideo-studio', 'openvideo-worker', 'openvideo-local']);
    const find = (image, name) => images[image].find((c) => c.name.startsWith(name));
    expect(find('openvideo-blender', 'Blender')).toMatchObject({ license: 'GPL-3.0-or-later', bundled: true });
    expect(find('openvideo-blender', 'Blender').note).toMatch(/download\.blender\.org\/source/u);
    expect(find('openvideo-render-cpu', 'Blender')).toBeUndefined();
    expect(find('openvideo-render-cpu', 'FFmpeg')).toMatchObject({ license: 'GPL-2.0-or-later', bundled: true });
    expect(find('openvideo-worker', 'Chromium (Chrome for Testing)')?.version).toMatch(/^\d+\.\d+\.\d+\.\d+ \(revision \d+\)$/u);
    expect(find('openvideo-render-gpu', 'NVIDIA')).toMatchObject({ bundled: false });
    expect(find('openvideo-base', 'FFmpeg')).toBeUndefined();
    const json = JSON.parse(files['licenses.json']);
    expect(json.externalTools.find((t) => t.name === 'Blender').note).toMatch(/Bundled only in the openvideo-blender image/u);
  });
});
