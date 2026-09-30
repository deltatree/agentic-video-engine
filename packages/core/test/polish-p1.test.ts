/**
 * Politur P1 in core: strukturierte Fehler statt TypeError in Hashes und frühe Prüfung des
 * Moduls von Studio-Panels.
 */
import { describe, expect, it } from 'vitest';
import { OpenVideoError, Registry, canonicalJson, contentHash } from '@agentic-video/core';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof OpenVideoError) return error.diagnostic.code;
    throw error;
  }
  return undefined;
}

describe('Hashes melden unhashbare Werte strukturiert (Politur P1)', () => {
  it('nicht-endliche Zahlen ergeben OV_HASH_NON_FINITE mit Vorschlägen', () => {
    expect(codeOf(() => contentHash({ x: Number.NaN }))).toBe('OV_HASH_NON_FINITE');
    expect(codeOf(() => canonicalJson([1, Number.POSITIVE_INFINITY]))).toBe('OV_HASH_NON_FINITE');
    try {
      canonicalJson(Number.NEGATIVE_INFINITY);
    } catch (error) {
      expect(error).toBeInstanceOf(OpenVideoError);
      if (error instanceof OpenVideoError) expect(error.diagnostic.suggestions.length).toBeGreaterThan(0);
    }
  });

  it('Funktionen, Symbole und BigInt ergeben OV_HASH_UNSUPPORTED', () => {
    expect(codeOf(() => contentHash({ f: () => 1 }))).toBe('OV_HASH_UNSUPPORTED');
    expect(codeOf(() => canonicalJson(Symbol('s')))).toBe('OV_HASH_UNSUPPORTED');
    expect(codeOf(() => canonicalJson(10n))).toBe('OV_HASH_UNSUPPORTED');
    // Gültige Daten bleiben unverändert (Schlüssel bitgleich).
    expect(canonicalJson({ b: 1, a: [2, -0] })).toBe('{"a":[2,0],"b":1}');
  });
});

describe('registerStudioPanel prüft das Modul früh (Politur P1)', () => {
  it('akzeptiert relative .js- und .mjs-Module', () => {
    const r = new Registry();
    r.registerStudioPanel({ id: 'a', title: 'A', module: './panel.mjs' });
    r.registerStudioPanel({ id: 'b', title: 'B', module: 'ui/panel.JS' });
    expect([...r.studioPanels.keys()]).toEqual(['a', 'b']);
  });

  it.each(['./panel.ts', './panel.json', './page.html', './panel', './panel.mjs.map'])('lehnt die Endung von "%s" mit OV_REGISTRY_PANEL_MODULE ab', (module) => {
    const r = new Registry();
    expect(codeOf(() => { r.registerStudioPanel({ id: 'p', title: 'P', module }); })).toBe('OV_REGISTRY_PANEL_MODULE');
    expect(r.studioPanels.size).toBe(0);
  });

  it.each(['../outside.mjs', '/abs/panel.js', 'https://cdn.example.com/panel.js', 'ui/../../x.js'])('lehnt den Pfad "%s" außerhalb des Plugins ab', (module) => {
    expect(codeOf(() => { new Registry().registerStudioPanel({ id: 'p', title: 'P', module }); })).toBe('OV_REGISTRY_PANEL_MODULE');
  });

  it('meldet den Fehler auch über Registry.use (Plugin-Kontext)', async () => {
    const r = new Registry();
    await expect(r.use({ name: 'bad-panel', version: '1.0.0', permissions: [], setup: (ctx) => { ctx.registerStudioPanel({ id: 'p', title: 'P', module: './panel.tsx' }); } })).rejects.toMatchObject({ diagnostic: { code: 'OV_REGISTRY_PANEL_MODULE' } });
  });
});
