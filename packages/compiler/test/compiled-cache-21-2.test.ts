import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMPILER_VERSION, bundleTsx, compileTsx, compiledCacheKey, type CompiledStore } from '@agentic-video/compiler';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Speicher im Arbeitsspeicher, der Lese- und Schreibzugriffe zählt. */
function memoryStore(): CompiledStore & { readonly entries: Map<string, Uint8Array>; gets: number; puts: number } {
  const entries = new Map<string, Uint8Array>();
  const store = {
    entries,
    gets: 0,
    puts: 0,
    get(key: string) {
      store.gets++;
      return Promise.resolve(entries.get(key));
    },
    put(key: string, bytes: Uint8Array) {
      store.puts++;
      entries.set(key, bytes);
      return Promise.resolve();
    },
  };
  return store;
}

describe('Cache-Ebene compiled (Story 21.2)', () => {
  it('speichert den Compiler-Output und liefert ihn beim zweiten Lauf ohne Auswertung', async () => {
    const cache = memoryStore();
    const first = await compileTsx('sampled.tsx', { projectDir: fixtures, mode: 'trusted-host', cache });
    expect(first.cached).toBe(false);
    expect(cache.puts).toBe(1);
    const second = await compileTsx('sampled.tsx', { projectDir: fixtures, mode: 'trusted-host', cache });
    expect(second.cached).toBe(true);
    expect(cache.puts).toBe(1);
    expect(second.project).toEqual(first.project);
    expect(second.diagnostics).toEqual(first.diagnostics);
    expect(second.bundleHash).toBe(first.bundleHash);
    expect(second.trusted).toBe(true);
  });

  it('der Treffer kommt wirklich aus dem Cache: ein geänderter Eintrag wird geliefert', async () => {
    const cache = memoryStore();
    const first = await compileTsx('sampled.tsx', { projectDir: fixtures, mode: 'trusted-host', cache });
    const [key] = [...cache.entries.keys()];
    expect(key).toBe(compiledCacheKey((await bundleTsx('sampled.tsx', fixtures)).code));
    const changed = { ...first.project, metadata: { title: 'from-cache' } };
    cache.entries.set(key ?? '', new TextEncoder().encode(JSON.stringify({ project: changed, diagnostics: [], trusted: false })));
    const hit = await compileTsx('sampled.tsx', { projectDir: fixtures, mode: 'trusted-host', cache });
    expect(hit.cached).toBe(true);
    expect(hit.project.metadata).toEqual({ title: 'from-cache' });
    expect(hit.trusted).toBe(false);
  });

  it('eine geänderte Quelle ergibt einen neuen Schlüssel; beschädigte Einträge zählen als Fehlgriff', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-compiled-'));
    const source = (color: string) => `import { Rect, Scene, composition } from '@agentic-video/sdk';\nexport default composition({ width: 64, height: 64, fps: 10, duration: 2, scene: () => (<Scene><Rect id="r" width={10} height={10} fill="${color}" /></Scene>) });\n`;
    writeFileSync(join(dir, 'video.tsx'), source('#FF0000'));
    const cache = memoryStore();
    await compileTsx('video.tsx', { projectDir: dir, mode: 'trusted-host', cache });
    writeFileSync(join(dir, 'video.tsx'), source('#00FF00'));
    const changed = await compileTsx('video.tsx', { projectDir: dir, mode: 'trusted-host', cache });
    expect(changed.cached).toBe(false);
    expect(cache.entries.size).toBe(2);
    for (const k of cache.entries.keys()) cache.entries.set(k, new TextEncoder().encode('{kaputt'));
    const again = await compileTsx('video.tsx', { projectDir: dir, mode: 'trusted-host', cache });
    expect(again.cached).toBe(false);
    expect(COMPILER_VERSION).toMatch(/^compiler-.+\+esbuild-.+/u);
  });
});
