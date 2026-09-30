/**
 * Review Q1: WOFF/WOFF2-Dekompressionsbomben, Größengrenzen, kurze loca mit Überlauf und
 * Fuzzing (zufällige Byte-Mutationen gültiger Fixtures dürfen nur OpenVideoError werfen).
 *
 * Alle Bomben-Fixtures erzeugt der Test selbst.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants, deflateSync } from 'node:zlib';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { OpenVideoError } from '@agentic-video/core';
import { MAX_SFNT_BYTES, toSfnt, woff2ToSfnt, woffToSfnt } from '@agentic-video/fonts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const read = (path: string): Uint8Array => new Uint8Array(readFileSync(path));
const hebrewWoff2 = read(join(FIXTURES, 'noto-sans-hebrew/NotoSansHebrew-Regular.woff2'));
const serifWoff2 = read(join(FIXTURES, 'noto-serif/NotoSerif-Subset.woff2'));
const serifTtf = read(join(FIXTURES, 'noto-serif/NotoSerif-Subset.ttf'));

const invalidFont = expect.objectContaining({ diagnostic: expect.objectContaining({ code: 'OV_FONT_INVALID' }) });

function be16(v: number): number[] {
  return [(v >>> 8) & 0xff, v & 0xff];
}

function be32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function ascii(s: string): number[] {
  return s.split('').map((c) => c.charCodeAt(0));
}

/** WOFF 1.0 mit einer Tabelle; Längenangaben frei wählbar (auch gelogen). */
function woff1(table: { tag: string; comp: Uint8Array; origLength: number }, totalSfntSize: number): Uint8Array {
  const offset = 44 + 20;
  const body = [...table.comp];
  while (body.length % 4 !== 0) body.push(0);
  const total = offset + body.length;
  const header = [...ascii('wOFF'), ...be32(0x00010000), ...be32(total), ...be16(1), ...be16(0), ...be32(totalSfntSize), ...be16(1), ...be16(0), ...be32(0), ...be32(0), ...be32(0), ...be32(0), ...be32(0)];
  const dir = [...ascii(table.tag), ...be32(offset), ...be32(table.comp.length), ...be32(table.origLength), ...be32(0)];
  return new Uint8Array([...header, ...dir, ...body]);
}

/** `UIntBase128` (WOFF2). */
function base128(v: number): number[] {
  const out = [v & 0x7f];
  let rest = Math.floor(v / 128);
  while (rest > 0) {
    out.unshift((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  return out;
}

interface Woff2Table {
  readonly flags: number;
  readonly origLength: number;
  readonly transformLength?: number;
}

/** WOFF2 mit frei wählbarem Verzeichnis und komprimiertem Strom. */
function woff2(tables: readonly Woff2Table[], compressed: Uint8Array, totalSfntSize: number): Uint8Array {
  const dir = tables.flatMap((t) => [t.flags, ...base128(t.origLength), ...(t.transformLength !== undefined ? base128(t.transformLength) : [])]);
  const body = [...compressed];
  while (body.length % 4 !== 0) body.push(0);
  const total = 48 + dir.length + body.length;
  const header = [
    ...ascii('wOF2'),
    ...be32(0x00010000),
    ...be32(total),
    ...be16(tables.length),
    ...be16(0),
    ...be32(totalSfntSize),
    ...be32(compressed.length),
    ...be16(1),
    ...be16(0),
    ...be32(0),
    ...be32(0),
    ...be32(0),
    ...be32(0),
    ...be32(0),
  ];
  return new Uint8Array([...header, ...dir, ...body]);
}

/** Tabellen-Index `name` in der WOFF2-Kurzform (untransformiert). */
const NAME = 5;
const GLYF = 10;
const LOCA = 11;

function brotli(data: Uint8Array): Uint8Array {
  return new Uint8Array(brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 1 } }));
}

describe('WOFF 1.0: Dekompressionsbombe', () => {
  it('entpackt nie mehr als origLength (gelogene Länge wird beim Entpacken abgebrochen)', () => {
    // 16 MiB Nullen, als 32 KiB angegeben: vor dem Fix wurden erst 16 MiB entpackt und danach verglichen.
    const comp = new Uint8Array(deflateSync(new Uint8Array(16 * 1024 * 1024)));
    const bomb = woff1({ tag: 'name', comp, origLength: 32 * 1024 }, 64 * 1024);
    expect(bomb.length).toBeLessThan(64 * 1024);
    let error: unknown;
    try {
      woffToSfnt(bomb);
    } catch (e: unknown) {
      error = e;
    }
    expect(error).toBeInstanceOf(OpenVideoError);
    expect(error).toEqual(invalidFont);
    // Abbruch während der Dekompression, nicht erst beim Längenvergleich danach.
    expect(error instanceof OpenVideoError ? error.diagnostic.problem : '').toMatch(/cannot be decompressed/);
  });

  it('lehnt ehrliche, aber zu große Angaben ab (totalSfntSize und Tabellen über der Grenze)', () => {
    const size = MAX_SFNT_BYTES + 4096;
    const comp = new Uint8Array(deflateSync(new Uint8Array(size)));
    expect(() => woffToSfnt(woff1({ tag: 'name', comp, origLength: size }, size + 12 + 16))).toThrow(invalidFont);
    // totalSfntSize klein, Tabelle größer: widersprüchlich.
    expect(() => woffToSfnt(woff1({ tag: 'name', comp: new Uint8Array(deflateSync(new Uint8Array(8192))), origLength: 8192 }, 1024))).toThrow(invalidFont);
  });
});

describe('WOFF2: Dekompressionsbombe', () => {
  it('entpackt den Brotli-Strom höchstens bis zur Summe der Tabellenlängen', () => {
    // Verzeichnis sagt 1 KiB, der Strom entpackt zu 16 MiB. Vor dem Fix wurde das angenommen.
    const bomb = woff2([{ flags: NAME, origLength: 1024 }], brotli(new Uint8Array(16 * 1024 * 1024)), 2048);
    expect(bomb.length).toBeLessThan(4096);
    expect(() => woff2ToSfnt(bomb)).toThrow(invalidFont);
  });

  it('lehnt Tabellen und totalSfntSize über MAX_SFNT_BYTES ab', () => {
    const size = MAX_SFNT_BYTES + 4096;
    expect(() => woff2ToSfnt(woff2([{ flags: NAME, origLength: size }], brotli(new Uint8Array(size)), 4096))).toThrow(invalidFont);
    expect(() => woff2ToSfnt(woff2([{ flags: NAME, origLength: 4 }], brotli(new Uint8Array(4)), MAX_SFNT_BYTES + 1))).toThrow(invalidFont);
  });

  it('lehnt doppelte Tabellen-Tags ab (Vervielfachung derselben Daten)', () => {
    const tables = Array.from({ length: 8 }, () => ({ flags: NAME, origLength: 4 }));
    expect(() => woff2ToSfnt(woff2(tables, brotli(new Uint8Array(32)), 4096))).toThrow(invalidFont);
  });
});

describe('WOFF2: kurze loca (indexFormat 0) mit Überlauf', () => {
  /** Transformierte glyf-Tabelle mit `glyphs` einfachen Glyphen zu je `points` Punkten. */
  function transformedGlyf(glyphs: number, points: number, indexFormat: number): Uint8Array {
    const nContour = Array.from({ length: glyphs }, () => be16(1)).flat();
    const nPoints = Array.from({ length: glyphs }, () => [253, ...be16(points)]).flat();
    const flagStream = new Array<number>(glyphs * points).fill(0);
    // Flag 0: dx = 0, dy aus einem Byte; danach Instruktionslänge 0 (255UInt16).
    const glyphStream = Array.from({ length: glyphs }, () => [...new Array<number>(points).fill(1), 0]).flat();
    const bboxStream = new Array<number>(4 * Math.floor((glyphs + 31) / 32)).fill(0);
    const streams = [nContour, nPoints, flagStream, glyphStream, [], bboxStream, []];
    return new Uint8Array([...be16(0), ...be16(0), ...be16(glyphs), ...be16(indexFormat), ...streams.flatMap((s) => be32(s.length)), ...streams.flat()]);
  }

  function fontWith(glyf: Uint8Array): Uint8Array {
    return woff2(
      [
        { flags: GLYF, origLength: 200_000, transformLength: glyf.length },
        { flags: LOCA, origLength: 8, transformLength: 0 },
      ],
      brotli(glyf),
      300_000,
    );
  }

  it('lehnt glyf über 131070 Bytes bei kurzer loca ab (vor dem Fix still abgeschnittene Offsets)', () => {
    // 3 Glyphen × 30000 Punkte ≈ 180 KB glyf.
    expect(() => woff2ToSfnt(fontWith(transformedGlyf(3, 30_000, 0)))).toThrow(invalidFont);
  });

  it('nimmt dieselben Glyphen mit langer loca an', () => {
    const sfnt = woff2ToSfnt(fontWith(transformedGlyf(3, 30_000, 1)));
    expect(sfnt.length).toBeGreaterThan(131_070);
  });

  it('nimmt kleine glyf mit kurzer loca an und lehnt unbekannte indexFormat ab', () => {
    expect(woff2ToSfnt(fontWith(transformedGlyf(2, 100, 0))).length).toBeGreaterThan(0);
    expect(() => woff2ToSfnt(fontWith(transformedGlyf(2, 100, 7)))).toThrow(invalidFont);
  });
});

describe('Fuzzing: Byte-Mutationen gültiger WOFF/WOFF2-Dateien', () => {
  /** WOFF 1.0 aus einer SFNT-Datei (zlib je Tabelle, nur wenn kleiner). */
  function encodeWoff(sfnt: Uint8Array): Uint8Array {
    const u16 = (o: number): number => ((sfnt[o] ?? 0) << 8) | (sfnt[o + 1] ?? 0);
    const u32 = (o: number): number => ((u16(o) << 16) >>> 0) + u16(o + 2);
    const n = u16(4);
    const dir: number[] = [];
    const body: number[] = [];
    for (let i = 0; i < n; i++) {
      const r = 12 + i * 16;
      const orig = sfnt.subarray(u32(r + 8), u32(r + 8) + u32(r + 12));
      const z = new Uint8Array(deflateSync(orig));
      const comp = z.length < orig.length ? z : orig;
      dir.push(...sfnt.subarray(r, r + 4), ...be32(44 + n * 20 + body.length), ...be32(comp.length), ...be32(orig.length), ...be32(0));
      body.push(...comp);
      while (body.length % 4 !== 0) body.push(0);
    }
    const total = 44 + dir.length + body.length;
    return new Uint8Array([...ascii('wOFF'), ...be32(u32(0)), ...be32(total), ...be16(n), ...be16(0), ...be32(sfnt.length), ...be16(1), ...be16(0), ...be32(0), ...be32(0), ...be32(0), ...be32(0), ...be32(0), ...dir, ...body]);
  }

  const seeds = [hebrewWoff2, serifWoff2, encodeWoff(serifTtf)];
  const mutation = fc.record({
    seed: fc.integer({ min: 0, max: seeds.length - 1 }),
    edits: fc.array(fc.record({ at: fc.nat(), value: fc.integer({ min: 0, max: 255 }) }), { minLength: 1, maxLength: 16 }),
    // Einige Mutationen treffen gezielt Kopf und Verzeichnis, wo Längen stehen.
    headerOnly: fc.boolean(),
  });

  it('wirft nur OpenVideoError, hängt nicht und bleibt unter dem Zeitlimit', () => {
    fc.assert(
      fc.property(mutation, ({ seed, edits, headerOnly }) => {
        const base = seeds[seed] ?? hebrewWoff2;
        const bytes = base.slice();
        const range = headerOnly ? Math.min(bytes.length, 160) : bytes.length;
        for (const e of edits) bytes[e.at % range] = e.value;
        const started = performance.now();
        try {
          const out = toSfnt(bytes);
          expect(out.length).toBeLessThanOrEqual(MAX_SFNT_BYTES);
        } catch (error: unknown) {
          if (!(error instanceof OpenVideoError)) throw error;
        }
        expect(performance.now() - started).toBeLessThan(2000);
      }),
      { numRuns: 400, seed: 20260930 },
    );
  }, 60_000);
});
