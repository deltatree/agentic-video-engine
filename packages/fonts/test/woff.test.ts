/**
 * Story 17.9: WOFF, WOFF2 (mit transformierten Tabellen) und TTC.
 *
 * Fixtures (SIL OFL 1.1, siehe OFL.txt in den Ordnern):
 * - `noto-sans-hebrew/NotoSansHebrew-Regular.woff2`: aus `packages/renderer-skia/test/fixtures/…ttf`
 *   mit fontTools 4.66 `woff2.compress` (glyf/loca transformiert, kurze loca).
 * - `noto-sans-hebrew/NotoSansHebrew-Regular-hmtx.woff2`: dazu `hmtx` transformiert.
 * - `noto-serif/NotoSerif-Subset.ttf`: NotoSerif-Regular, Teilmenge „Hamburgefonstiv ÄÖÜäöüéÉ0123“,
 *   mit Instruktionen an einfachen und zusammengesetzten Glyphen und langer loca;
 *   `NotoSerif-Subset.woff2` daraus mit glyf/loca/hmtx transformiert.
 * WOFF 1.0 und TTC erzeugt der Test selbst (Encoder unten).
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { contentHash } from '@agentic-video/core';
import { collectionFace, fontContainer, fontFaceCount, loadFontSet, parseFontInfo, toSfnt, woff2ToSfnt, woffToSfnt } from '@agentic-video/fonts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path));
const hebrewTtf = read(join(import.meta.dirname, '../../renderer-skia/test/fixtures/noto-sans-hebrew/NotoSansHebrew-Regular.ttf'));
const serifTtf = read(join(FIXTURES, 'noto-serif/NotoSerif-Subset.ttf'));

interface Table {
  readonly tag: string;
  readonly data: Uint8Array;
}

function u16(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
}

function i16(b: Uint8Array, o: number): number {
  const v = u16(b, o);
  return v >= 0x8000 ? v - 0x10000 : v;
}

function u32(b: Uint8Array, o: number): number {
  return ((u16(b, o) << 16) >>> 0) + u16(b, o + 2);
}

function tag(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);
}

/** Tabellen einer SFNT-Datei. */
function tablesOf(sfnt: Uint8Array, dir = 0): Map<string, Uint8Array> {
  const n = u16(sfnt, dir + 4);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < n; i++) {
    const r = dir + 12 + i * 16;
    out.set(tag(sfnt, r), sfnt.subarray(u32(sfnt, r + 8), u32(sfnt, r + 8) + u32(sfnt, r + 12)));
  }
  return out;
}

function be32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

/** Minimaler WOFF-1.0-Encoder (zlib je Tabelle, nur wenn kleiner). */
function encodeWoff(sfnt: Uint8Array): Uint8Array {
  const tables: Table[] = [...tablesOf(sfnt)].map(([t, data]) => ({ tag: t, data }));
  const entries = tables.map((t) => {
    const z = new Uint8Array(deflateSync(t.data));
    return { tag: t.tag, orig: t.data, comp: z.length < t.data.length ? z : t.data };
  });
  const dir: number[] = [];
  const body: number[] = [];
  for (const e of entries) {
    const offset = 44 + entries.length * 20 + body.length;
    dir.push(...Array.from({ length: 4 }, (_, k) => e.tag.charCodeAt(k)), ...be32(offset), ...be32(e.comp.length), ...be32(e.orig.length), ...be32(0));
    body.push(...e.comp);
    while (body.length % 4 !== 0) body.push(0);
  }
  const total = 44 + dir.length + body.length;
  const header = [
    ...'wOFF'.split('').map((c) => c.charCodeAt(0)),
    ...be32(u32(sfnt, 0)),
    ...be32(total),
    (entries.length >> 8) & 0xff,
    entries.length & 0xff,
    0,
    0,
    ...be32(sfnt.length),
    0,
    1,
    0,
    0,
    ...be32(0),
    ...be32(0),
    ...be32(0),
    ...be32(0),
    ...be32(0),
  ];
  return new Uint8Array([...header, ...dir, ...body]);
}

/** TTC mit den gegebenen SFNT-Schriften (Tabellen nicht geteilt). */
function encodeTtc(fonts: readonly Uint8Array[]): Uint8Array {
  const header = 12 + fonts.length * 4;
  const dirs = fonts.map((f) => 12 + u16(f, 4) * 16);
  let dataOffset = header + dirs.reduce((a, b) => a + b, 0);
  const parts: number[][] = [];
  const data: number[] = [];
  let dirOffset = header;
  const offsets: number[] = [];
  for (const f of fonts) {
    offsets.push(dirOffset);
    const n = u16(f, 4);
    const dir: number[] = [...f.subarray(0, 12)];
    for (let i = 0; i < n; i++) {
      const r = 12 + i * 16;
      const len = u32(f, r + 12);
      dir.push(...f.subarray(r, r + 8), ...be32(dataOffset), ...be32(len));
      const bytes = f.subarray(u32(f, r + 8), u32(f, r + 8) + len);
      data.push(...bytes);
      while (data.length % 4 !== 0) data.push(0);
      dataOffset = header + dirs.reduce((a, b) => a + b, 0) + data.length;
    }
    parts.push(dir);
    dirOffset += dir.length;
  }
  return new Uint8Array([...'ttcf'.split('').map((c) => c.charCodeAt(0)), 0, 1, 0, 0, ...be32(fonts.length), ...offsets.flatMap(be32), ...parts.flat(), ...data]);
}

interface Glyph {
  readonly contours: number;
  readonly bbox: readonly number[];
  readonly endPts?: readonly number[];
  readonly instructions: readonly number[];
  readonly points?: readonly (readonly [number, number, boolean])[];
  readonly overlap?: boolean;
  readonly components?: readonly number[];
}

/** Liest alle Glyphen semantisch (unabhängig von Flag-Kompression und Padding). */
function glyphs(sfnt: Uint8Array): Glyph[] {
  const t = tablesOf(sfnt);
  const head = t.get('head') ?? new Uint8Array(0);
  const maxp = t.get('maxp') ?? new Uint8Array(0);
  const loca = t.get('loca') ?? new Uint8Array(0);
  const glyf = t.get('glyf') ?? new Uint8Array(0);
  const long = i16(head, 50) === 1;
  const n = u16(maxp, 4);
  const at = (i: number): number => (long ? u32(loca, i * 4) : u16(loca, i * 2) * 2);
  const out: Glyph[] = [];
  for (let g = 0; g < n; g++) {
    const start = at(g);
    if (at(g + 1) === start) {
      out.push({ contours: 0, bbox: [], instructions: [] });
      continue;
    }
    const contours = i16(glyf, start);
    const bbox = [i16(glyf, start + 2), i16(glyf, start + 4), i16(glyf, start + 6), i16(glyf, start + 8)];
    let p = start + 10;
    if (contours < 0) {
      let flags: number;
      const begin = p;
      do {
        flags = u16(glyf, p);
        p += 4 + ((flags & 1) !== 0 ? 4 : 2) + ((flags & 8) !== 0 ? 2 : (flags & 0x40) !== 0 ? 4 : (flags & 0x80) !== 0 ? 8 : 0);
      } while ((flags & 0x20) !== 0);
      const components = [...glyf.subarray(begin, p)];
      // WE_HAVE_INSTRUCTIONS an irgendeiner Komponente: Länge und Bytes folgen den Komponenten.
      let any = false;
      for (let q = begin; q < p; ) {
        const f = u16(glyf, q);
        if ((f & 0x100) !== 0) any = true;
        q += 4 + ((f & 1) !== 0 ? 4 : 2) + ((f & 8) !== 0 ? 2 : (f & 0x40) !== 0 ? 4 : (f & 0x80) !== 0 ? 8 : 0);
      }
      const instructions = any ? [...glyf.subarray(p + 2, p + 2 + u16(glyf, p))] : [];
      out.push({ contours, bbox, instructions, components });
      continue;
    }
    const endPts: number[] = [];
    for (let c = 0; c < contours; c++) {
      endPts.push(u16(glyf, p));
      p += 2;
    }
    const ilen = u16(glyf, p);
    const instructions = [...glyf.subarray(p + 2, p + 2 + ilen)];
    p += 2 + ilen;
    const total = (endPts[endPts.length - 1] ?? -1) + 1;
    const flags: number[] = [];
    while (flags.length < total) {
      const f = glyf[p++] ?? 0;
      flags.push(f);
      if ((f & 8) !== 0) {
        const r = glyf[p++] ?? 0;
        for (let k = 0; k < r; k++) flags.push(f);
      }
    }
    const coords = (short: number, same: number): number[] => {
      const out2: number[] = [];
      let v = 0;
      for (const f of flags) {
        if ((f & short) !== 0) {
          const d = glyf[p++] ?? 0;
          v += (f & same) !== 0 ? d : -d;
        } else if ((f & same) === 0) {
          v += i16(glyf, p);
          p += 2;
        }
        out2.push(v);
      }
      return out2;
    };
    const xs = coords(2, 0x10);
    const ys = coords(4, 0x20);
    out.push({ contours, bbox, endPts, instructions, points: flags.map((f, i) => [xs[i] ?? 0, ys[i] ?? 0, (f & 1) !== 0] as const), overlap: ((flags[0] ?? 0) & 0x40) !== 0 });
  }
  return out;
}

/** Vergleicht eine rekonstruierte Schrift mit dem Original: Glyphen semantisch, übrige Tabellen bytegleich. */
function expectSameFont(actual: Uint8Array, original: Uint8Array): void {
  const a = tablesOf(actual);
  const o = tablesOf(original);
  expect([...a.keys()].sort()).toEqual([...o.keys()].sort());
  for (const [t, data] of o) {
    if (t === 'glyf' || t === 'loca') continue;
    const got = a.get(t) ?? new Uint8Array(0);
    if (t === 'head') {
      // checkSumAdjustment (8..11) und flags (16..17, Bit 11 „lossless transformiert“) dürfen abweichen.
      expect([...got.subarray(0, 8), ...got.subarray(12, 16), ...got.subarray(18)]).toEqual([...data.subarray(0, 8), ...data.subarray(12, 16), ...data.subarray(18)]);
      continue;
    }
    expect([...got], `table ${t}`).toEqual([...data]);
  }
  expect(glyphs(actual)).toEqual(glyphs(original));
}

describe('Container-Erkennung', () => {
  it('erkennt SFNT, WOFF, WOFF2 und Sammlungen', () => {
    expect(fontContainer(hebrewTtf)).toBe('sfnt');
    expect(fontContainer(encodeWoff(hebrewTtf))).toBe('woff');
    expect(fontContainer(read(join(FIXTURES, 'noto-sans-hebrew/NotoSansHebrew-Regular.woff2')))).toBe('woff2');
    expect(fontContainer(encodeTtc([hebrewTtf, serifTtf]))).toBe('collection');
    expect(fontContainer(new Uint8Array([1, 2]))).toBeUndefined();
  });
});

describe('WOFF 1.0 (zlib)', () => {
  it('liefert dieselben Tabellen wie die TTF-Datei', () => {
    const woff = encodeWoff(hebrewTtf);
    expect(woff.length).toBeLessThan(hebrewTtf.length);
    expectSameFont(woffToSfnt(woff), hebrewTtf);
    expect(parseFontInfo(woff).family).toBe('Noto Sans Hebrew');
  });

  it('meldet beschädigte Dateien mit OV_FONT_INVALID', () => {
    const woff = encodeWoff(hebrewTtf);
    expect(() => woffToSfnt(woff.subarray(0, woff.length - 10))).toThrow(expect.objectContaining({ diagnostic: expect.objectContaining({ code: 'OV_FONT_INVALID' }) }));
  });
});

describe('WOFF 2.0 (Brotli und Tabellen-Transformationen)', () => {
  it('rekonstruiert glyf/loca (kurze loca) verlustfrei', () => {
    expectSameFont(woff2ToSfnt(read(join(FIXTURES, 'noto-sans-hebrew/NotoSansHebrew-Regular.woff2'))), hebrewTtf);
  });

  it('rekonstruiert zusätzlich transformiertes hmtx', () => {
    expectSameFont(woff2ToSfnt(read(join(FIXTURES, 'noto-sans-hebrew/NotoSansHebrew-Regular-hmtx.woff2'))), hebrewTtf);
  });

  it('rekonstruiert lange loca, Instruktionen und zusammengesetzte Glyphen mit Instruktionen', () => {
    const sfnt = woff2ToSfnt(read(join(FIXTURES, 'noto-serif/NotoSerif-Subset.woff2')));
    expectSameFont(sfnt, serifTtf);
    const all = glyphs(sfnt);
    expect(all.some((g) => g.contours > 0 && g.instructions.length > 0)).toBe(true);
    expect(all.some((g) => g.contours < 0 && g.instructions.length > 0)).toBe(true);
  });

  it('schreibt gültige Prüfsummen (checkSumAdjustment)', () => {
    const sfnt = woff2ToSfnt(read(join(FIXTURES, 'noto-sans-hebrew/NotoSansHebrew-Regular.woff2')));
    let sum = 0;
    for (let i = 0; i < sfnt.length; i += 4) sum = (sum + u32(new Uint8Array([...sfnt.subarray(i, i + 4), 0, 0, 0, 0]), 0)) >>> 0;
    expect(sum).toBe(0xb1b0afba);
  });

  it('ist deterministisch und meldet beschädigte Daten', () => {
    const bytes = read(join(FIXTURES, 'noto-sans-hebrew/NotoSansHebrew-Regular.woff2'));
    expect(contentHash(woff2ToSfnt(bytes))).toBe(contentHash(woff2ToSfnt(bytes)));
    const broken = bytes.slice();
    broken.fill(0xff, 100, 140);
    expect(() => woff2ToSfnt(broken)).toThrow(expect.objectContaining({ diagnostic: expect.objectContaining({ code: 'OV_FONT_INVALID' }) }));
  });
});

describe('Schriftsammlungen (TTC)', () => {
  it('wählt die Schrift per faceIndex', () => {
    const ttc = encodeTtc([hebrewTtf, serifTtf]);
    expect(fontFaceCount(ttc)).toBe(2);
    expect(parseFontInfo(ttc).family).toBe('Noto Sans Hebrew');
    expect(parseFontInfo(ttc, 1).family).toBe('Noto Serif');
    expectSameFont(collectionFace(ttc, 1), serifTtf);
    expect(() => toSfnt(ttc, 2)).toThrow(expect.objectContaining({ diagnostic: expect.objectContaining({ code: 'OV_FONT_FACE_INDEX' }) }));
  });
});

describe('loadFontSet mit WOFF, WOFF2 und TTC', () => {
  it('lädt alle Formate als SFNT mit eigenem Hash je Face', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-fonts-woff-'));
    writeFileSync(join(dir, 'hebrew.woff'), encodeWoff(hebrewTtf));
    writeFileSync(join(dir, 'family.ttc'), encodeTtc([hebrewTtf, serifTtf]));
    const set = await loadFontSet({
      projectDir: dir,
      includeDefaults: false,
      fonts: [
        { family: 'Hebrew WOFF', src: 'hebrew.woff' },
        { family: 'Hebrew WOFF2', src: join(FIXTURES, 'noto-sans-hebrew/NotoSansHebrew-Regular.woff2') },
        { family: 'Serif TTC', src: 'family.ttc', faceIndex: 1 },
        { family: 'Hebrew TTC', src: 'family.ttc' },
        { family: 'Missing Face', src: 'family.ttc', faceIndex: 5 },
      ],
    });
    expect(set.diagnostics.map((d) => d.code)).toEqual(['OV_FONT_FACE_INDEX']);
    const faces = set.all();
    expect(faces.map((f) => f.sourceFamily)).toEqual(['Noto Sans Hebrew', 'Noto Sans Hebrew', 'Noto Serif', 'Noto Sans Hebrew']);
    for (const f of faces) expect(fontContainer(f.bytes)).toBe('sfnt');
    // Gleiche Schrift in WOFF und TTF: gleiche Bytes nach dem Umwandeln (bis auf Prüfsummen gleiches Face).
    expect(faces[2]?.hash).not.toBe(faces[3]?.hash);
    expect(faces[3]?.hash).toBe(contentHash(collectionFace(encodeTtc([hebrewTtf, serifTtf]), 0)));
  });
});
