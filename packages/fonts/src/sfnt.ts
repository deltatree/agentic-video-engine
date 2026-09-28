/**
 * Kleiner Parser für OpenType/TrueType-Dateien (sfnt).
 * Er liest nur, was OpenVideo braucht: Namen, Gewicht, Stil und variable Achsen.
 */
import { OpenVideoError } from '@agentic-video/core';

/** Eine variable Achse aus der Tabelle `fvar`. */
export interface FontAxis {
  /** Vierstelliges Kürzel, z. B. `wght`. */
  readonly tag: string;
  readonly min: number;
  readonly default: number;
  readonly max: number;
}

/** Ausgelesene Eigenschaften einer Schriftdatei. */
export interface FontInfo {
  /** Familienname (Name-ID 16, sonst 1). */
  readonly family: string;
  /** Unterfamilie, z. B. `Regular` oder `Bold Italic`. */
  readonly subfamily: string;
  readonly postscriptName: string;
  /** Gewicht aus `OS/2.usWeightClass` (Standard 400). */
  readonly weight: number;
  readonly italic: boolean;
  readonly axes: readonly FontAxis[];
  /** Tabellenkürzel in Dateireihenfolge. */
  readonly tables: readonly string[];
}

interface TableRecord {
  readonly offset: number;
  readonly length: number;
}

function invalid(problem: string, suggestion: string): OpenVideoError {
  return new OpenVideoError({ code: 'OV_FONT_INVALID', errorClass: 'FontError', problem, suggestions: [suggestion] });
}

function tag(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

function utf16be(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i + 1 < length; i += 2) out += String.fromCharCode(view.getUint16(offset + i));
  return out;
}

function latin1(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

/** Liest die Name-Tabelle; bevorzugt Windows-Unicode (Englisch), dann Mac Roman. */
function readNames(view: DataView, table: TableRecord): Map<number, string> {
  const count = view.getUint16(table.offset + 2);
  const storage = table.offset + view.getUint16(table.offset + 4);
  const ranked = new Map<number, { rank: number; value: string }>();
  for (let i = 0; i < count; i++) {
    const rec = table.offset + 6 + i * 12;
    if (rec + 12 > table.offset + table.length) break;
    const platform = view.getUint16(rec);
    const encoding = view.getUint16(rec + 2);
    const language = view.getUint16(rec + 4);
    const nameId = view.getUint16(rec + 6);
    const length = view.getUint16(rec + 8);
    const offset = storage + view.getUint16(rec + 10);
    if (offset + length > view.byteLength) continue;
    let rank: number;
    let value: string;
    if (platform === 3 && (encoding === 1 || encoding === 10)) {
      rank = language === 0x409 ? 0 : 1;
      value = utf16be(view, offset, length);
    } else if (platform === 0) {
      rank = 2;
      value = utf16be(view, offset, length);
    } else if (platform === 1 && encoding === 0) {
      rank = 3;
      value = latin1(view, offset, length);
    } else {
      continue;
    }
    const prev = ranked.get(nameId);
    if (prev === undefined || rank < prev.rank) ranked.set(nameId, { rank, value });
  }
  return new Map([...ranked].map(([id, v]) => [id, v.value]));
}

function readAxes(view: DataView, table: TableRecord): FontAxis[] {
  const axesOffset = table.offset + view.getUint16(table.offset + 4);
  const axisCount = view.getUint16(table.offset + 8);
  const axisSize = view.getUint16(table.offset + 10);
  const axes: FontAxis[] = [];
  for (let i = 0; i < axisCount; i++) {
    const rec = axesOffset + i * axisSize;
    if (rec + 20 > view.byteLength) break;
    axes.push({
      tag: tag(view, rec),
      min: view.getInt32(rec + 4) / 65536,
      default: view.getInt32(rec + 8) / 65536,
      max: view.getInt32(rec + 12) / 65536,
    });
  }
  return axes;
}

/**
 * Liest Familie, Gewicht, Stil und variable Achsen aus einer TTF- oder OTF-Datei.
 * Wirft `OV_FONT_INVALID`, wenn die Datei keine lesbare Einzelschrift ist.
 *
 * @example
 * ```ts
 * const info = parseFontInfo(readFileSync('Inter.ttf'));
 * info.axes; // [{ tag: 'wght', min: 100, default: 400, max: 900 }, …]
 * ```
 */
export function parseFontInfo(bytes: Uint8Array): FontInfo {
  if (bytes.byteLength < 12) throw invalid('Font file is too small to be a TrueType or OpenType font.', 'Provide a .ttf or .otf file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = tag(view, 0);
  if (signature === 'wOFF' || signature === 'wOF2') throw invalid('WOFF and WOFF2 fonts are not supported.', 'Convert the font to .ttf or .otf, e.g. with `fonttools ttLib.woff2 decompress`.');
  if (signature === 'ttcf') throw invalid('Font collections (.ttc) are not supported.', 'Extract the wanted face into a single .ttf or .otf file.');
  if (view.getUint32(0) !== 0x00010000 && signature !== 'OTTO' && signature !== 'true') {
    throw invalid('File is not a TrueType or OpenType font.', 'Provide a .ttf or .otf file.');
  }
  const numTables = view.getUint16(4);
  if (12 + numTables * 16 > bytes.byteLength) throw invalid('Font table directory is truncated.', 'Download the font file again.');
  const tables = new Map<string, TableRecord>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const offset = view.getUint32(rec + 8);
    const length = view.getUint32(rec + 12);
    if (offset + length > bytes.byteLength) throw invalid(`Font table "${tag(view, rec)}" points outside the file.`, 'Download the font file again.');
    tables.set(tag(view, rec), { offset, length });
  }
  const nameTable = tables.get('name');
  if (nameTable === undefined || !tables.has('cmap')) throw invalid('Font has no "name" or "cmap" table.', 'Provide a complete .ttf or .otf file.');
  const names = readNames(view, nameTable);
  const family = names.get(16) ?? names.get(1);
  if (family === undefined || family.length === 0) throw invalid('Font has no family name.', 'Provide a font with a valid "name" table.');
  const os2 = tables.get('OS/2');
  const head = tables.get('head');
  const weight = os2 !== undefined && os2.length >= 6 ? view.getUint16(os2.offset + 4) : 400;
  const italicOs2 = os2 !== undefined && os2.length >= 64 ? (view.getUint16(os2.offset + 62) & 1) === 1 : false;
  const italicHead = head !== undefined && head.length >= 46 ? (view.getUint16(head.offset + 44) & 2) === 2 : false;
  const fvar = tables.get('fvar');
  return {
    family,
    subfamily: names.get(17) ?? names.get(2) ?? 'Regular',
    postscriptName: names.get(6) ?? family.replace(/\s+/gu, ''),
    weight: weight > 0 ? weight : 400,
    italic: italicOs2 || italicHead,
    axes: fvar !== undefined ? readAxes(view, fvar) : [],
    tables: [...tables.keys()],
  };
}
