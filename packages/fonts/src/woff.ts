/**
 * WOFF, WOFF2 und Schriftsammlungen (TTC/OTC) → einzelne SFNT-Datei (Story 17.9).
 *
 * Skia und die Parser in diesem Paket lesen nur SFNT (TrueType/OpenType). Diese Funktionen
 * wandeln beim Import und beim Laden um:
 * - WOFF 1.0: je Tabelle zlib (`node:zlib`), sonst unverändert.
 * - WOFF 2.0: ein Brotli-Strom (`node:zlib`), dazu die Rücktransformationen von `glyf`/`loca`
 *   (Version 0) und `hmtx` (Version 1) nach der W3C-Empfehlung „WOFF File Format 2.0“.
 *   Auch WOFF2-Sammlungen werden unterstützt.
 * - TTC/OTC: Die Tabellen der gewählten Schrift (`faceIndex`) werden zu einer SFNT-Datei.
 *
 * Die Ausgabe hat sortierte Tabellen, 4-Byte-Ausrichtung, neue Prüfsummen und ein neues
 * `head.checkSumAdjustment`. Gleiche Eingabe ergibt bitgleiche Ausgabe.
 *
 * Schutz vor Dekompressionsbomben (Review Q1): Jede Dekompression ist auf die im Verzeichnis
 * angegebene Länge begrenzt (`maxOutputLength`), alle Größenangaben und die erzeugte SFNT-Datei
 * sind auf {@link MAX_SFNT_BYTES} begrenzt, Tabellen-Tags dürfen je Schrift nur einmal vorkommen,
 * und eine kurze `loca` (indexFormat 0) wird abgelehnt, wenn ihre Offsets nicht in 16 Bit passen.
 */
import { brotliDecompressSync, inflateSync } from 'node:zlib';
import { OpenVideoError } from '@agentic-video/core';

/**
 * Obergrenze in Bytes für entpackte Schriftdaten und die erzeugte SFNT-Datei (64 MiB).
 * Größere Angaben in WOFF/WOFF2/TTC werden mit `OV_FONT_INVALID` abgelehnt, bevor
 * Speicher angefordert wird.
 *
 * @example
 * ```ts
 * if (bytes.byteLength > MAX_SFNT_BYTES) throw new Error('font too large');
 * ```
 */
export const MAX_SFNT_BYTES = 64 * 1024 * 1024;

function tooLarge(what: string, size: number): OpenVideoError {
  return invalid(
    `${what} is ${String(size)} bytes; fonts larger than ${String(MAX_SFNT_BYTES)} bytes are rejected.`,
    'Use a smaller font file (for example a subset) or convert it to .ttf/.otf with a font tool and check the file.',
  );
}

function duplicateTag(tag: string): OpenVideoError {
  return invalid(`Font table "${tag}" occurs more than once in one font.`, 'Download the font file again or rebuild it with a font tool.');
}

/** Container-Format einer Schriftdatei. */
export type FontContainer = 'sfnt' | 'woff' | 'woff2' | 'collection';

/** Eine Tabelle einer SFNT-Datei. */
interface Table {
  readonly tag: string;
  readonly data: Uint8Array;
}

function invalid(problem: string, suggestion = 'Provide a valid .ttf, .otf, .ttc, .woff or .woff2 file.'): OpenVideoError {
  return new OpenVideoError({ code: 'OV_FONT_INVALID', errorClass: 'FontError', problem, suggestions: [suggestion] });
}

/** Lesezeiger mit Grenzprüfung (Big Endian). */
class Reader {
  readonly #view: DataView;
  offset: number;

  constructor(
    readonly bytes: Uint8Array,
    offset = 0,
    readonly what = 'font data',
  ) {
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = offset;
  }

  #need(n: number): number {
    const at = this.offset;
    if (at < 0 || at + n > this.bytes.byteLength) throw invalid(`The ${this.what} is truncated (needs ${String(n)} bytes at ${String(at)}).`);
    this.offset += n;
    return at;
  }

  u8(): number {
    return this.#view.getUint8(this.#need(1));
  }

  u16(): number {
    return this.#view.getUint16(this.#need(2));
  }

  i16(): number {
    return this.#view.getInt16(this.#need(2));
  }

  u32(): number {
    return this.#view.getUint32(this.#need(4));
  }

  tag(): string {
    const at = this.#need(4);
    return String.fromCharCode(this.bytes[at] ?? 0, this.bytes[at + 1] ?? 0, this.bytes[at + 2] ?? 0, this.bytes[at + 3] ?? 0);
  }

  take(n: number): Uint8Array {
    const at = this.#need(n);
    return this.bytes.subarray(at, at + n);
  }

  /** `UIntBase128` (WOFF2): bis zu 5 Bytes, 7 Bit je Byte, ohne führende Nullen. */
  base128(): number {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.u8();
      if (i === 0 && b === 0x80) throw invalid('Invalid UIntBase128 value (leading zero) in WOFF2 data.');
      if (value > 0x1ffffff) throw invalid('UIntBase128 value overflows 32 bits in WOFF2 data.');
      value = value * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) return value;
    }
    throw invalid('UIntBase128 value is longer than 5 bytes in WOFF2 data.');
  }

  /** `255UInt16` (WOFF2). */
  u255(): number {
    const code = this.u8();
    if (code === 253) return this.u16();
    if (code === 255) return this.u8() + 253;
    if (code === 254) return this.u8() + 253 * 2;
    return code;
  }
}

/** Schreibpuffer (Big Endian), wächst bei Bedarf. */
class Writer {
  #buf = new Uint8Array(1024);
  length = 0;

  #grow(n: number): void {
    if (this.length + n <= this.#buf.length) return;
    let size = this.#buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.#buf.subarray(0, this.length));
    this.#buf = next;
  }

  u8(v: number): void {
    this.#grow(1);
    this.#buf[this.length++] = v & 0xff;
  }

  u16(v: number): void {
    this.u8(v >>> 8);
    this.u8(v);
  }

  u32(v: number): void {
    this.u16(v >>> 16);
    this.u16(v & 0xffff);
  }

  bytes(data: Uint8Array): void {
    this.#grow(data.length);
    this.#buf.set(data, this.length);
    this.length += data.length;
  }

  pad(multiple: number): void {
    while (this.length % multiple !== 0) this.u8(0);
  }

  result(): Uint8Array {
    return this.#buf.slice(0, this.length);
  }
}

function tagOf(bytes: Uint8Array, offset = 0): string {
  return String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);
}

/**
 * Erkennt das Container-Format an den ersten vier Bytes.
 *
 * @example
 * ```ts
 * fontContainer(readFileSync('Inter.woff2')); // 'woff2'
 * ```
 */
export function fontContainer(bytes: Uint8Array): FontContainer | undefined {
  if (bytes.byteLength < 4) return undefined;
  const sig = tagOf(bytes);
  if (sig === 'wOFF') return 'woff';
  if (sig === 'wOF2') return 'woff2';
  if (sig === 'ttcf') return 'collection';
  if (sig === 'OTTO' || sig === 'true' || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)) return 'sfnt';
  return undefined;
}

function checksum(data: Uint8Array): number {
  let sum = 0;
  const n = data.length;
  for (let i = 0; i < n; i += 4) {
    const word = (((data[i] ?? 0) << 24) | ((data[i + 1] ?? 0) << 16) | ((data[i + 2] ?? 0) << 8) | (data[i + 3] ?? 0)) >>> 0;
    sum = (sum + word) >>> 0;
  }
  return sum;
}

/** Baut eine SFNT-Datei aus Tabellen: sortiertes Verzeichnis, Prüfsummen, `checkSumAdjustment`. */
function buildSfnt(flavor: number, input: readonly Table[]): Uint8Array {
  const tables = [...input].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const head = tables.find((t) => t.tag === 'head');
  // checkSumAdjustment wird neu berechnet; vorher 0.
  const prepared = tables.map((t) => {
    if (t !== head || t.data.length < 12) return t;
    const copy = t.data.slice();
    copy.fill(0, 8, 12);
    return { tag: t.tag, data: copy };
  });
  const n = prepared.length;
  let total = 12 + n * 16;
  for (let i = 0; i < n; i++) {
    const t = prepared[i];
    if (t === undefined) continue;
    if (i > 0 && prepared[i - 1]?.tag === t.tag) throw duplicateTag(t.tag);
    total += (t.data.length + 3) & ~3;
    if (total > MAX_SFNT_BYTES) throw tooLarge('The resulting font', total);
  }
  let entrySelector = 0;
  while (1 << (entrySelector + 1) <= n) entrySelector++;
  const searchRange = (1 << entrySelector) * 16;
  const w = new Writer();
  w.u32(flavor);
  w.u16(n);
  w.u16(searchRange);
  w.u16(entrySelector);
  w.u16(n * 16 - searchRange);
  let offset = 12 + n * 16;
  const offsets: number[] = [];
  for (const t of prepared) {
    offsets.push(offset);
    w.bytes(new Uint8Array([t.tag.charCodeAt(0), t.tag.charCodeAt(1), t.tag.charCodeAt(2), t.tag.charCodeAt(3)]));
    w.u32(checksum(t.data));
    w.u32(offset);
    w.u32(t.data.length);
    offset += (t.data.length + 3) & ~3;
  }
  for (const t of prepared) {
    w.bytes(t.data);
    w.pad(4);
  }
  const out = w.result();
  const headIndex = prepared.findIndex((t) => t.tag === 'head');
  const headOffset = offsets[headIndex];
  if (headOffset !== undefined && (prepared[headIndex]?.data.length ?? 0) >= 12) {
    const adjust = (0xb1b0afba - checksum(out)) >>> 0;
    new DataView(out.buffer).setUint32(headOffset + 8, adjust);
  }
  return out;
}

/** Tabellen einer SFNT-Schrift ab `dirOffset` (Tabellen-Offsets relativ zum Dateianfang). */
function sfntTables(bytes: Uint8Array, dirOffset: number): { flavor: number; tables: Table[] } {
  const r = new Reader(bytes, dirOffset, 'font table directory');
  const flavor = r.u32();
  const numTables = r.u16();
  r.offset += 6;
  const tables: Table[] = [];
  for (let i = 0; i < numTables; i++) {
    const tag = r.tag();
    r.u32();
    const offset = r.u32();
    const length = r.u32();
    if (offset + length > bytes.byteLength) throw invalid(`Font table "${tag}" points outside the file.`, 'Download the font file again.');
    tables.push({ tag, data: bytes.subarray(offset, offset + length) });
  }
  return { flavor, tables };
}

/**
 * Anzahl der Schriften in einer Datei: bei TTC/OTC und WOFF2-Sammlungen die Zahl der Faces, sonst 1.
 *
 * @example
 * ```ts
 * fontFaceCount(readFileSync('NotoSansCJK.ttc')); // 10
 * ```
 */
export function fontFaceCount(bytes: Uint8Array): number {
  const container = fontContainer(bytes);
  if (container === 'collection') return new Reader(bytes, 8, 'collection header').u32();
  if (container === 'woff2' && new Reader(bytes, 4).u32() === 0x74746366) return readWoff2Directory(bytes).collection?.length ?? 1;
  return 1;
}

function faceIndexError(index: number, count: number): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_FONT_FACE_INDEX',
    errorClass: 'FontError',
    problem: `Font face index ${String(index)} does not exist; the collection has ${String(count)} face(s).`,
    suggestions: [`Use faceIndex 0 … ${String(Math.max(0, count - 1))} in project.fonts.`],
  });
}

/**
 * Zieht eine Schrift aus einer TTC/OTC-Sammlung als eigene SFNT-Datei heraus.
 *
 * @example
 * ```ts
 * const bold = collectionFace(readFileSync('Family.ttc'), 1);
 * ```
 */
export function collectionFace(bytes: Uint8Array, faceIndex: number): Uint8Array {
  const r = new Reader(bytes, 0, 'collection header');
  if (r.tag() !== 'ttcf') throw invalid('File is not a font collection (.ttc/.otc).');
  r.u32();
  const count = r.u32();
  if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= count) throw faceIndexError(faceIndex, count);
  r.offset += faceIndex * 4;
  const { flavor, tables } = sfntTables(bytes, r.u32());
  return buildSfnt(flavor, tables);
}

/**
 * Wandelt WOFF 1.0 in SFNT (Tabellen mit zlib, sonst unverändert).
 *
 * @example
 * ```ts
 * const ttf = woffToSfnt(readFileSync('Brand.woff'));
 * ```
 */
export function woffToSfnt(bytes: Uint8Array): Uint8Array {
  const r = new Reader(bytes, 0, 'WOFF header');
  if (r.tag() !== 'wOFF') throw invalid('File is not a WOFF font.');
  const flavor = r.u32();
  const length = r.u32();
  if (length !== bytes.byteLength) throw invalid(`WOFF header says ${String(length)} bytes, the file has ${String(bytes.byteLength)}.`, 'Download the font file again.');
  const numTables = r.u16();
  r.u16();
  const totalSfntSize = r.u32();
  if (totalSfntSize > MAX_SFNT_BYTES) throw tooLarge('The WOFF font (totalSfntSize)', totalSfntSize);
  r.offset = 44;
  const tables: Table[] = [];
  let sum = 0;
  for (let i = 0; i < numTables; i++) {
    const tag = r.tag();
    const offset = r.u32();
    const compLength = r.u32();
    const origLength = r.u32();
    r.u32();
    const data = new Reader(bytes, offset, `WOFF table "${tag}"`).take(compLength);
    if (compLength > origLength) throw invalid(`WOFF table "${tag}" is larger compressed than uncompressed.`);
    sum += origLength;
    if (sum > totalSfntSize) throw invalid(`WOFF tables are larger (${String(sum)} bytes) than totalSfntSize (${String(totalSfntSize)} bytes).`, 'Download the font file again.');
    let table: Uint8Array;
    if (compLength === origLength) {
      table = data;
    } else {
      try {
        // Nie mehr entpacken als angegeben (Dekompressionsbombe, Review Q1).
        table = new Uint8Array(inflateSync(data, { maxOutputLength: origLength }));
      } catch (error: unknown) {
        throw invalid(`WOFF table "${tag}" cannot be decompressed: ${error instanceof Error ? error.message : String(error)}.`);
      }
    }
    if (table.length !== origLength) throw invalid(`WOFF table "${tag}" has ${String(table.length)} bytes after decompression, expected ${String(origLength)}.`);
    tables.push({ tag, data: table });
  }
  return buildSfnt(flavor, tables);
}

/** Tabellen-Kürzel der WOFF2-Kurzform (Index 0…62). */
const WOFF2_TAGS: readonly string[] = [
  'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT',
  'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH',
  'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar',
  'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill',
];

interface Woff2Entry {
  readonly tag: string;
  readonly transform: number;
  readonly origLength: number;
  /** Länge im entpackten Strom. */
  readonly length: number;
  /** Offset im entpackten Strom. */
  readonly offset: number;
}

interface Woff2Directory {
  readonly flavor: number;
  readonly entries: readonly Woff2Entry[];
  /** Je Schrift der Sammlung: Flavor und Tabellen-Indizes. */
  readonly collection?: readonly { readonly flavor: number; readonly indices: readonly number[] }[];
  readonly compressedOffset: number;
  readonly compressedLength: number;
  /** Summe der Tabellenlängen im entpackten Strom (höchstens {@link MAX_SFNT_BYTES}). */
  readonly decompressedLength: number;
}

function readWoff2Directory(bytes: Uint8Array): Woff2Directory {
  const r = new Reader(bytes, 0, 'WOFF2 header');
  if (r.tag() !== 'wOF2') throw invalid('File is not a WOFF2 font.');
  const flavor = r.u32();
  const length = r.u32();
  if (length !== bytes.byteLength) throw invalid(`WOFF2 header says ${String(length)} bytes, the file has ${String(bytes.byteLength)}.`, 'Download the font file again.');
  const numTables = r.u16();
  r.u16();
  const totalSfntSize = r.u32();
  if (totalSfntSize > MAX_SFNT_BYTES) throw tooLarge('The WOFF2 font (totalSfntSize)', totalSfntSize);
  const compressedLength = r.u32();
  r.offset = 48;
  const entries: Woff2Entry[] = [];
  let offset = 0;
  for (let i = 0; i < numTables; i++) {
    const flags = r.u8();
    const tag = (flags & 0x3f) === 0x3f ? r.tag() : WOFF2_TAGS[flags & 0x3f];
    if (tag === undefined) throw invalid(`Unknown WOFF2 table tag index ${String(flags & 0x3f)}.`);
    const transform = flags >> 6;
    const origLength = r.base128();
    const glyfLike = tag === 'glyf' || tag === 'loca';
    const transformed = glyfLike ? transform === 0 : transform !== 0;
    const length = transformed ? r.base128() : origLength;
    if (origLength > MAX_SFNT_BYTES) throw tooLarge(`WOFF2 table "${tag}"`, origLength);
    if (transformed && !glyfLike && !(tag === 'hmtx' && transform === 1)) throw invalid(`WOFF2 table "${tag}" uses unknown transform ${String(transform)}.`);
    if (glyfLike && transform !== 0 && transform !== 3) throw invalid(`WOFF2 table "${tag}" uses unknown transform ${String(transform)}.`);
    entries.push({ tag, transform: transformed ? (glyfLike ? 0 : transform) : -1, origLength, length, offset });
    offset += length;
    if (offset > MAX_SFNT_BYTES) throw tooLarge('The WOFF2 decompressed data', offset);
  }
  let collection: { flavor: number; indices: number[] }[] | undefined;
  if (flavor === 0x74746366) {
    r.u32();
    const numFonts = r.u255();
    collection = [];
    for (let f = 0; f < numFonts; f++) {
      const count = r.u255();
      const fontFlavor = r.u32();
      const indices: number[] = [];
      const tags = new Set<string>();
      for (let i = 0; i < count; i++) {
        const index = r.u255();
        const entry = entries[index];
        if (entry === undefined) throw invalid(`WOFF2 collection font ${String(f)} references table ${String(index)} of ${String(entries.length)}.`);
        if (tags.has(entry.tag)) throw duplicateTag(entry.tag);
        tags.add(entry.tag);
        indices.push(index);
      }
      collection.push({ flavor: fontFlavor, indices });
    }
  }
  if (collection === undefined) {
    const tags = new Set<string>();
    for (const e of entries) {
      if (tags.has(e.tag)) throw duplicateTag(e.tag);
      tags.add(e.tag);
    }
  }
  return { flavor, entries, decompressedLength: offset, ...(collection !== undefined ? { collection } : {}), compressedOffset: r.offset, compressedLength };
}

/** Punkt-Flags im `glyf`-Format. */
const ON_CURVE = 0x01;
const X_SHORT = 0x02;
const Y_SHORT = 0x04;
const X_SAME_OR_POSITIVE = 0x10;
const Y_SAME_OR_POSITIVE = 0x20;
const OVERLAP_SIMPLE = 0x40;
/** Composite-Flags. */
const ARG_1_AND_2_ARE_WORDS = 0x0001;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;
const WE_HAVE_INSTRUCTIONS = 0x0100;

function withSign(flag: number, value: number): number {
  return (flag & 1) !== 0 ? value : -value;
}

/** Schreibt eine einfache Glyphe (Punkte absolut) im `glyf`-Format. */
function writeSimpleGlyph(w: Writer, endPts: readonly number[], xs: Int32Array, ys: Int32Array, on: Uint8Array, bbox: readonly [number, number, number, number], instructions: Uint8Array, overlap: boolean): void {
  w.u16(endPts.length);
  for (const v of bbox) w.u16(v & 0xffff);
  for (const e of endPts) w.u16(e);
  w.u16(instructions.length);
  w.bytes(instructions);
  const n = xs.length;
  const flags = new Uint8Array(n);
  let px = 0;
  let py = 0;
  const xBytes = new Writer();
  const yBytes = new Writer();
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - px;
    const dy = (ys[i] ?? 0) - py;
    px = xs[i] ?? 0;
    py = ys[i] ?? 0;
    let f = (on[i] ?? 0) !== 0 ? ON_CURVE : 0;
    if (i === 0 && overlap) f |= OVERLAP_SIMPLE;
    if (dx === 0) f |= X_SAME_OR_POSITIVE;
    else if (dx > -256 && dx < 256) {
      f |= X_SHORT | (dx > 0 ? X_SAME_OR_POSITIVE : 0);
      xBytes.u8(Math.abs(dx));
    } else xBytes.u16(dx & 0xffff);
    if (dy === 0) f |= Y_SAME_OR_POSITIVE;
    else if (dy > -256 && dy < 256) {
      f |= Y_SHORT | (dy > 0 ? Y_SAME_OR_POSITIVE : 0);
      yBytes.u8(Math.abs(dy));
    } else yBytes.u16(dy & 0xffff);
    flags[i] = f;
  }
  w.bytes(flags);
  w.bytes(xBytes.result());
  w.bytes(yBytes.result());
}

/** Rekonstruiert `glyf` und `loca` aus der WOFF2-Transformation (Version 0). */
function reconstructGlyf(data: Uint8Array): { glyf: Uint8Array; loca: Uint8Array; xMins: Int16Array; numGlyphs: number; indexFormat: number } {
  const h = new Reader(data, 0, 'transformed glyf table');
  h.u16();
  const optionFlags = h.u16();
  const numGlyphs = h.u16();
  const indexFormat = h.u16();
  if (indexFormat !== 0 && indexFormat !== 1) throw invalid(`Transformed glyf table has an invalid indexFormat ${String(indexFormat)}.`);
  const sizes = [h.u32(), h.u32(), h.u32(), h.u32(), h.u32(), h.u32(), h.u32()];
  let at = h.offset;
  const streams = sizes.map((size) => {
    const s = new Reader(data, at, 'transformed glyf stream');
    s.take(size);
    const r = new Reader(data.subarray(at, at + size), 0, 'transformed glyf stream');
    at += size;
    return r;
  });
  const [nContourStream, nPointsStream, flagStream, glyphStream, compositeStream, bboxStream, instructionStream] = streams;
  if (nContourStream === undefined || nPointsStream === undefined || flagStream === undefined || glyphStream === undefined || compositeStream === undefined || bboxStream === undefined || instructionStream === undefined) {
    throw invalid('Transformed glyf table is incomplete.');
  }
  const bitmapLength = 4 * Math.floor((numGlyphs + 31) / 32);
  const bboxBitmap = bboxStream.take(bitmapLength);
  const overlapBitmap = (optionFlags & 1) !== 0 ? new Reader(data, at, 'overlap bitmap').take(Math.floor((numGlyphs + 7) / 8)) : undefined;
  const hasBit = (bitmap: Uint8Array, i: number): boolean => ((bitmap[i >> 3] ?? 0) & (0x80 >> (i & 7))) !== 0;
  const glyf = new Writer();
  const offsets: number[] = [];
  const xMins = new Int16Array(numGlyphs);
  for (let g = 0; g < numGlyphs; g++) {
    offsets.push(glyf.length);
    if (glyf.length > MAX_SFNT_BYTES) throw tooLarge('The reconstructed glyf table', glyf.length);
    const nContours = nContourStream.i16();
    const hasBbox = hasBit(bboxBitmap, g);
    if (nContours === 0) {
      if (hasBbox) throw invalid(`Empty glyph ${String(g)} has an explicit bounding box in WOFF2 data.`);
      continue;
    }
    if (nContours === -1) {
      if (!hasBbox) throw invalid(`Composite glyph ${String(g)} has no bounding box in WOFF2 data.`);
      const bbox = [bboxStream.i16(), bboxStream.i16(), bboxStream.i16(), bboxStream.i16()] as const;
      xMins[g] = bbox[0];
      const start = compositeStream.offset;
      let more = true;
      let instructions = false;
      while (more) {
        const flags = compositeStream.u16();
        compositeStream.u16();
        let skip = (flags & ARG_1_AND_2_ARE_WORDS) !== 0 ? 4 : 2;
        if ((flags & WE_HAVE_A_SCALE) !== 0) skip += 2;
        else if ((flags & WE_HAVE_AN_X_AND_Y_SCALE) !== 0) skip += 4;
        else if ((flags & WE_HAVE_A_TWO_BY_TWO) !== 0) skip += 8;
        compositeStream.take(skip);
        if ((flags & WE_HAVE_INSTRUCTIONS) !== 0) instructions = true;
        more = (flags & MORE_COMPONENTS) !== 0;
      }
      const components = compositeStream.bytes.subarray(start, compositeStream.offset);
      glyf.u16(0xffff);
      for (const v of bbox) glyf.u16(v & 0xffff);
      glyf.bytes(components);
      if (instructions) {
        const len = glyphStream.u255();
        glyf.u16(len);
        glyf.bytes(instructionStream.take(len));
      }
      glyf.pad(indexFormat === 0 ? 2 : 4);
      continue;
    }
    if (nContours < 0) throw invalid(`Glyph ${String(g)} has an invalid contour count ${String(nContours)} in WOFF2 data.`);
    const endPts: number[] = [];
    let total = 0;
    for (let c = 0; c < nContours; c++) {
      total += nPointsStream.u255();
      endPts.push(total - 1);
    }
    if (total > 0xffff) throw invalid(`Glyph ${String(g)} has too many points in WOFF2 data.`);
    const xs = new Int32Array(total);
    const ys = new Int32Array(total);
    const on = new Uint8Array(total);
    let x = 0;
    let y = 0;
    for (let i = 0; i < total; i++) {
      const raw = flagStream.u8();
      on[i] = (raw & 0x80) === 0 ? 1 : 0;
      const flag = raw & 0x7f;
      let dx: number;
      let dy: number;
      if (flag < 10) {
        dx = 0;
        dy = withSign(flag, ((flag & 14) << 7) + glyphStream.u8());
      } else if (flag < 20) {
        dx = withSign(flag, (((flag - 10) & 14) << 7) + glyphStream.u8());
        dy = 0;
      } else if (flag < 84) {
        const b0 = flag - 20;
        const b1 = glyphStream.u8();
        dx = withSign(flag, 1 + (b0 & 0x30) + (b1 >> 4));
        dy = withSign(flag >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f));
      } else if (flag < 120) {
        const b0 = flag - 84;
        const b1 = glyphStream.u8();
        const b2 = glyphStream.u8();
        dx = withSign(flag, 1 + (Math.floor(b0 / 12) << 8) + b1);
        dy = withSign(flag >> 1, 1 + (((b0 % 12) >> 2) << 8) + b2);
      } else if (flag < 124) {
        const b1 = glyphStream.u8();
        const b2 = glyphStream.u8();
        const b3 = glyphStream.u8();
        dx = withSign(flag, (b1 << 4) + (b2 >> 4));
        dy = withSign(flag >> 1, ((b2 & 0x0f) << 8) + b3);
      } else {
        const b1 = glyphStream.u8();
        const b2 = glyphStream.u8();
        const b3 = glyphStream.u8();
        const b4 = glyphStream.u8();
        dx = withSign(flag, (b1 << 8) + b2);
        dy = withSign(flag >> 1, (b3 << 8) + b4);
      }
      x += dx;
      y += dy;
      xs[i] = x;
      ys[i] = y;
    }
    const instructionLength = glyphStream.u255();
    const instructions = instructionStream.take(instructionLength);
    let bbox: [number, number, number, number];
    if (hasBbox) {
      bbox = [bboxStream.i16(), bboxStream.i16(), bboxStream.i16(), bboxStream.i16()];
    } else {
      let x0 = Number.POSITIVE_INFINITY;
      let y0 = Number.POSITIVE_INFINITY;
      let x1 = Number.NEGATIVE_INFINITY;
      let y1 = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < total; i++) {
        x0 = Math.min(x0, xs[i] ?? 0);
        y0 = Math.min(y0, ys[i] ?? 0);
        x1 = Math.max(x1, xs[i] ?? 0);
        y1 = Math.max(y1, ys[i] ?? 0);
      }
      bbox = total > 0 ? [x0, y0, x1, y1] : [0, 0, 0, 0];
    }
    xMins[g] = bbox[0];
    writeSimpleGlyph(glyf, endPts, xs, ys, on, bbox, instructions, overlapBitmap !== undefined && hasBit(overlapBitmap, g));
    glyf.pad(indexFormat === 0 ? 2 : 4);
  }
  offsets.push(glyf.length);
  if (glyf.length > MAX_SFNT_BYTES) throw tooLarge('The reconstructed glyf table', glyf.length);
  // Kurze loca speichert Offset/2 als uint16: höchstens 0x1FFFE Bytes glyf (Review Q1).
  if (indexFormat === 0 && glyf.length > 0x1fffe) {
    throw invalid(
      `The reconstructed glyf table has ${String(glyf.length)} bytes, too many for a short loca table (indexFormat 0, at most 131070 bytes).`,
      'Re-encode the WOFF2 file from a font with a long loca table (head.indexToLocFormat = 1).',
    );
  }
  const loca = new Writer();
  for (const o of offsets) {
    if (indexFormat === 0) loca.u16(o >> 1);
    else loca.u32(o);
  }
  return { glyf: glyf.result(), loca: loca.result(), xMins, numGlyphs, indexFormat };
}

/** Rekonstruiert `hmtx` aus der WOFF2-Transformation (Version 1). */
function reconstructHmtx(data: Uint8Array, numGlyphs: number, numberOfHMetrics: number, xMins: Int16Array): Uint8Array {
  const r = new Reader(data, 0, 'transformed hmtx table');
  const flags = r.u8();
  if ((flags & 0xfc) !== 0) throw invalid('Transformed hmtx table has reserved flags set.');
  const advances: number[] = [];
  for (let i = 0; i < numberOfHMetrics; i++) advances.push(r.u16());
  const lsbs: number[] = [];
  for (let i = 0; i < numberOfHMetrics; i++) lsbs.push((flags & 1) !== 0 ? (xMins[i] ?? 0) : r.i16());
  for (let i = numberOfHMetrics; i < numGlyphs; i++) lsbs.push((flags & 2) !== 0 ? (xMins[i] ?? 0) : r.i16());
  const w = new Writer();
  for (let i = 0; i < numberOfHMetrics; i++) {
    w.u16(advances[i] ?? 0);
    w.u16((lsbs[i] ?? 0) & 0xffff);
  }
  for (let i = numberOfHMetrics; i < numGlyphs; i++) w.u16((lsbs[i] ?? 0) & 0xffff);
  return w.result();
}

/**
 * Wandelt WOFF 2.0 in SFNT, inklusive der Rücktransformationen von `glyf`/`loca` und `hmtx`.
 * Bei WOFF2-Sammlungen wählt `faceIndex` die Schrift.
 *
 * @example
 * ```ts
 * const ttf = woff2ToSfnt(readFileSync('Inter.woff2'));
 * ```
 */
export function woff2ToSfnt(bytes: Uint8Array, faceIndex = 0): Uint8Array {
  const dir = readWoff2Directory(bytes);
  const compressed = new Reader(bytes, dir.compressedOffset, 'WOFF2 compressed data').take(dir.compressedLength);
  let stream: Uint8Array;
  try {
    // Höchstens die Summe der Tabellenlängen entpacken (Dekompressionsbombe, Review Q1).
    stream = new Uint8Array(brotliDecompressSync(compressed, { maxOutputLength: Math.max(1, dir.decompressedLength) }));
  } catch (error: unknown) {
    throw invalid(`WOFF2 data cannot be decompressed: ${error instanceof Error ? error.message : String(error)}.`);
  }
  const last = dir.entries[dir.entries.length - 1];
  if (last !== undefined && last.offset + last.length > stream.length) throw invalid('WOFF2 decompressed data is shorter than the table directory says.');
  let flavor = dir.flavor;
  let indices = dir.entries.map((_, i) => i);
  if (dir.collection !== undefined) {
    const face = dir.collection[faceIndex];
    if (face === undefined) throw faceIndexError(faceIndex, dir.collection.length);
    flavor = face.flavor;
    indices = [...face.indices];
  } else if (faceIndex !== 0) {
    throw faceIndexError(faceIndex, 1);
  }
  const raw = (i: number): Uint8Array => {
    const e = dir.entries[i];
    return e === undefined ? new Uint8Array(0) : stream.subarray(e.offset, e.offset + e.length);
  };
  const entryOf = (tag: string): number | undefined => indices.find((i) => dir.entries[i]?.tag === tag);
  const tables: Table[] = [];
  const glyfIndex = entryOf('glyf');
  const glyfEntry = glyfIndex !== undefined ? dir.entries[glyfIndex] : undefined;
  let glyph: ReturnType<typeof reconstructGlyf> | undefined;
  if (glyfIndex !== undefined && glyfEntry?.transform === 0) glyph = reconstructGlyf(raw(glyfIndex));
  for (const i of indices) {
    const e = dir.entries[i];
    if (e === undefined) continue;
    if (e.transform < 0) {
      tables.push({ tag: e.tag, data: raw(i) });
      continue;
    }
    if (e.tag === 'glyf' || e.tag === 'loca') {
      if (glyph === undefined) throw invalid('WOFF2 "loca" is transformed but "glyf" is not.');
      tables.push({ tag: e.tag, data: e.tag === 'glyf' ? glyph.glyf : glyph.loca });
      continue;
    }
    // hmtx, Version 1
    const hhea = entryOf('hhea');
    const maxp = entryOf('maxp');
    if (hhea === undefined || maxp === undefined) throw invalid('WOFF2 transformed "hmtx" needs "hhea" and "maxp".');
    const hheaData = raw(hhea);
    const numberOfHMetrics = new Reader(hheaData, 34, 'hhea table').u16();
    const numGlyphs = new Reader(raw(maxp), 4, 'maxp table').u16();
    if (glyph === undefined) throw invalid('WOFF2 transformed "hmtx" needs a transformed "glyf" table.');
    tables.push({ tag: e.tag, data: reconstructHmtx(raw(i), numGlyphs, numberOfHMetrics, glyph.xMins) });
  }
  // head.indexToLocFormat muss zur rekonstruierten loca passen.
  if (glyph !== undefined) {
    const headAt = tables.findIndex((t) => t.tag === 'head');
    const head = tables[headAt];
    if (head !== undefined && head.data.length >= 52) {
      const copy = head.data.slice();
      new DataView(copy.buffer).setInt16(50, glyph.indexFormat);
      tables[headAt] = { tag: 'head', data: copy };
    }
  }
  return buildSfnt(flavor, tables);
}

/**
 * Wandelt jede unterstützte Schriftdatei in eine einzelne SFNT-Datei: TTF/OTF bleiben
 * unverändert, WOFF/WOFF2 werden entpackt, aus Sammlungen wird die Schrift `faceIndex` gezogen.
 *
 * @example
 * ```ts
 * const sfnt = toSfnt(readFileSync('Brand.woff2'));
 * const second = toSfnt(readFileSync('Family.ttc'), 1);
 * ```
 */
export function toSfnt(bytes: Uint8Array, faceIndex = 0): Uint8Array {
  switch (fontContainer(bytes)) {
    case 'woff':
      if (faceIndex !== 0) throw faceIndexError(faceIndex, 1);
      return woffToSfnt(bytes);
    case 'woff2':
      return woff2ToSfnt(bytes, faceIndex);
    case 'collection':
      return collectionFace(bytes, faceIndex);
    case 'sfnt':
      if (faceIndex !== 0) throw faceIndexError(faceIndex, 1);
      return bytes;
    default:
      throw invalid('File is not a TrueType, OpenType, TTC, WOFF or WOFF2 font.');
  }
}
