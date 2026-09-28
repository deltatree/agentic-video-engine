/**
 * Parser für SRT, WebVTT und ASS/SSA (FR-55).
 *
 * Alle Parser sind tolerant: Eine fehlerhafte Zeile oder ein fehlerhafter Block erzeugt
 * eine Diagnose und wird übersprungen; der Rest der Datei bleibt nutzbar.
 * Zeiten stehen als Sekunden-Texte (`"1.5s"`) im Ergebnis, siehe `time.ts`.
 */
import type { Diagnostic, SubtitleCue } from '@agentic-video/core';
import { secondsToTime } from './time.js';
import { timedWords, type TimedSegment } from './words.js';

/** Unterstützte Untertitel-Formate. */
export type SubtitleFormat = 'srt' | 'vtt' | 'ass';

/** Zusatzangaben zu einem Cue, die nicht in die IR gehören (gleicher Index wie `cues`). */
export interface CueInfo {
  /** Cue-Kennung (SRT-Nummer, VTT-Identifier). */
  readonly id?: string;
  /** VTT-Cue-Einstellungen, z. B. `{ line: '10%', align: 'start' }`. */
  readonly settings?: Readonly<Record<string, string>>;
  /** ASS-Stilname. */
  readonly style?: string;
  /** 1-basierte Zeile in der Quelldatei. */
  readonly line: number;
}

/** Ein ASS-Stil (Auszug der Felder, die für Captions zählen). */
export interface AssStyle {
  readonly name: string;
  readonly fontFamily?: string;
  readonly fontSize?: number;
  /** Primärfarbe als `#RRGGBB` oder `#RRGGBBAA`. */
  readonly color?: string;
  readonly bold: boolean;
  readonly italic: boolean;
  /** Numpad-Ausrichtung 1..9 (ASS v4+). */
  readonly alignment?: number;
}

/** Ergebnis eines Parsers. */
export interface SubtitleParseResult {
  readonly format: SubtitleFormat;
  readonly cues: SubtitleCue[];
  readonly info: CueInfo[];
  /** Nur ASS: definierte Stile. */
  readonly styles: AssStyle[];
  readonly diagnostics: Diagnostic[];
}

function diagnostic(code: string, severity: Diagnostic['severity'], problem: string, line: number, suggestions: readonly string[]): Diagnostic {
  return { code, severity, errorClass: 'SubtitleError', problem, details: { line }, suggestions };
}

function normalize(text: string): string[] {
  return text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').split('\n');
}

interface Block {
  readonly line: number;
  readonly lines: readonly string[];
}

/** Zerlegt Zeilen in Blöcke, getrennt durch Leerzeilen. `line` ist 1-basiert. */
function blocks(lines: readonly string[]): Block[] {
  const out: Block[] = [];
  let current: string[] = [];
  let start = 0;
  lines.forEach((l, i) => {
    if (l.trim() === '') {
      if (current.length > 0) out.push({ line: start + 1, lines: current });
      current = [];
      return;
    }
    if (current.length === 0) start = i;
    current.push(l);
  });
  if (current.length > 0) out.push({ line: start + 1, lines: current });
  return out;
}

function fraction(digits: string | undefined): number {
  return digits === undefined || digits === '' ? 0 : Number(`0.${digits}`);
}

function hms(h: string | undefined, m: string | undefined, s: string | undefined, f: string | undefined): number {
  return Number(h ?? '0') * 3600 + Number(m ?? '0') * 60 + Number(s ?? '0') + fraction(f);
}

function checkedCue(start: number, end: number, line: number, diagnostics: Diagnostic[]): boolean {
  if (end < start) {
    diagnostics.push(diagnostic('OV_SUBTITLE_TIME', 'warning', `Cue at line ${line} ends before it starts; it was skipped.`, line, ['Swap the start and end time of this cue.']));
    return false;
  }
  return true;
}

function makeCue(start: number, end: number, text: string, speaker: string | undefined, words: readonly TimedSegment[] | undefined): SubtitleCue {
  return {
    start: secondsToTime(start),
    end: secondsToTime(end),
    text,
    ...(speaker !== undefined && speaker !== '' ? { speaker } : {}),
    ...(words !== undefined && words.length > 0 ? { words: words.map((w) => ({ text: w.text, start: secondsToTime(w.start), end: secondsToTime(w.end) })) } : {}),
  };
}

// ---------------------------------------------------------------------------
// SRT
// ---------------------------------------------------------------------------

const SRT_TIME = /^\s*(\d+):(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?\s*-->\s*(\d+):(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?/u;

/** Entfernt HTML-artige Tags (`<i>`, `<font …>`) und ASS-Override-Blöcke aus SRT-Text. */
function stripSrtMarkup(text: string): string {
  return text.replace(/<[^>]*>/gu, '').replace(/\{\\[^}]*\}/gu, '');
}

/**
 * Liest SubRip (SRT). Stunden dürfen mehrstellig sein; BOM und CRLF werden akzeptiert.
 *
 * @example
 * ```ts
 * const { cues, diagnostics } = parseSrt('1\n00:00:01,000 --> 00:00:02,500\nHello\n');
 * cues[0]; // { start: '1s', end: '2.5s', text: 'Hello' }
 * ```
 */
export function parseSrt(text: string): SubtitleParseResult {
  const cues: SubtitleCue[] = [];
  const info: CueInfo[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const block of blocks(normalize(text))) {
    let timingIndex = block.lines.findIndex((l) => l.includes('-->'));
    if (timingIndex > 1) timingIndex = -1;
    const timing = timingIndex >= 0 ? SRT_TIME.exec(block.lines[timingIndex] ?? '') : null;
    if (timing === null) {
      diagnostics.push(
        diagnostic('OV_SUBTITLE_PARSE', 'warning', `SRT block at line ${block.line} has no valid timing line; it was skipped.`, block.line, [
          'Use the timing format "00:00:01,000 --> 00:00:02,000" on the line after the cue number.',
        ]),
      );
      continue;
    }
    const line = block.line + timingIndex;
    const start = hms(timing[1], timing[2], timing[3], timing[4]);
    const end = hms(timing[5], timing[6], timing[7], timing[8]);
    if (!checkedCue(start, end, line, diagnostics)) continue;
    const id = timingIndex === 1 ? block.lines[0]?.trim() : undefined;
    const body = stripSrtMarkup(block.lines.slice(timingIndex + 1).join('\n')).trim();
    cues.push(makeCue(start, end, body, undefined, undefined));
    info.push({ line, ...(id !== undefined ? { id } : {}) });
  }
  return { format: 'srt', cues, info, styles: [], diagnostics };
}

// ---------------------------------------------------------------------------
// WebVTT
// ---------------------------------------------------------------------------

const VTT_STAMP = '(?:(\\d+):)?(\\d{2}):(\\d{2})\\.(\\d{3})';
const VTT_TIME = new RegExp(`^\\s*${VTT_STAMP}\\s*-->\\s*${VTT_STAMP}(.*)$`, 'u');
const VTT_INNER = new RegExp(`<${VTT_STAMP}>`, 'gu');

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', nbsp: '\u00A0', lrm: '\u200E', rlm: '\u200F', quot: '"', apos: "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|nbsp|lrm|rlm|quot|apos);/gu, (m, name: string) => ENTITIES[name] ?? m);
}

function stripVttTags(text: string): string {
  return decodeEntities(text.replace(/<[^>]*>/gu, ''));
}

/** Zerlegt eine VTT-Nutzlast in Segmente an inneren Zeitstempeln. */
function vttPayload(payload: string, start: number, end: number): { text: string; speaker: string | undefined; words: TimedSegment[] | undefined } {
  const voice = /<v(?:\.[^\s>]*)?\s+([^>]*)>/u.exec(payload);
  const speaker = voice?.[1]?.trim();
  const stamps = [...payload.matchAll(VTT_INNER)];
  if (stamps.length === 0) return { text: stripVttTags(payload).trim(), speaker, words: undefined };
  const segments: TimedSegment[] = [];
  let cursor = 0;
  let segStart = start;
  for (const m of stamps) {
    const t = hms(m[1], m[2], m[3], m[4]);
    segments.push({ text: stripVttTags(payload.slice(cursor, m.index)), start: segStart, end: Math.max(segStart, t) });
    cursor = m.index + m[0].length;
    segStart = Math.min(Math.max(t, start), end);
  }
  segments.push({ text: stripVttTags(payload.slice(cursor)), start: segStart, end: Math.max(segStart, end) });
  const text = segments.map((s) => s.text).join('').trim();
  return { text, speaker, words: timedWords(segments) };
}

function vttSettings(rest: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const part of rest.trim().split(/\s+/u)) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Liest WebVTT: Cue-Einstellungen, Sprecher (`<v Name>`) und innere Zeitstempel
 * (`<00:00:01.500>`) als Wortzeiten. `NOTE`, `STYLE` und `REGION` werden übersprungen.
 *
 * @example
 * ```ts
 * const { cues } = parseVtt('WEBVTT\n\n00:01.000 --> 00:03.000 align:start\n<v Ana>Hi <00:02.000>there\n');
 * cues[0].speaker; // 'Ana'
 * cues[0].words; // [{ text: 'Hi', … }, { text: 'there', start: '2s', end: '3s' }]
 * ```
 */
export function parseVtt(text: string): SubtitleParseResult {
  const cues: SubtitleCue[] = [];
  const info: CueInfo[] = [];
  const diagnostics: Diagnostic[] = [];
  const all = blocks(normalize(text));
  const header = all[0];
  if (header === undefined || !/^WEBVTT(?:[ \t].*)?$/u.test(header.lines[0] ?? '')) {
    diagnostics.push(diagnostic('OV_SUBTITLE_FORMAT', 'error', 'WebVTT file does not start with "WEBVTT".', 1, ['Add the line "WEBVTT" as the first line of the file.']));
    return { format: 'vtt', cues, info, styles: [], diagnostics };
  }
  for (const block of all.slice(1)) {
    const first = block.lines[0] ?? '';
    if (/^(NOTE|STYLE|REGION)(?:\s|$)/u.test(first)) continue;
    let timingIndex = block.lines.findIndex((l) => l.includes('-->'));
    if (timingIndex > 1) timingIndex = -1;
    const timing = timingIndex >= 0 ? VTT_TIME.exec(block.lines[timingIndex] ?? '') : null;
    if (timing === null) {
      diagnostics.push(
        diagnostic('OV_SUBTITLE_PARSE', 'warning', `WebVTT block at line ${block.line} has no valid timing line; it was skipped.`, block.line, [
          'Use the timing format "00:00:01.000 --> 00:00:02.000" (hours optional, three-digit milliseconds).',
        ]),
      );
      continue;
    }
    const line = block.line + timingIndex;
    const start = hms(timing[1], timing[2], timing[3], timing[4]);
    const end = hms(timing[5], timing[6], timing[7], timing[8]);
    if (!checkedCue(start, end, line, diagnostics)) continue;
    const payload = vttPayload(block.lines.slice(timingIndex + 1).join('\n'), start, end);
    const settings = vttSettings(timing[9] ?? '');
    const id = timingIndex === 1 ? first.trim() : undefined;
    cues.push(makeCue(start, end, payload.text, payload.speaker, payload.words));
    info.push({ line, ...(id !== undefined ? { id } : {}), ...(settings !== undefined ? { settings } : {}) });
  }
  return { format: 'vtt', cues, info, styles: [], diagnostics };
}

// ---------------------------------------------------------------------------
// ASS / SSA
// ---------------------------------------------------------------------------

const ASS_TIME = /^\s*(\d+):(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\s*$/u;
const DEFAULT_EVENT_FORMAT = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
const KARAOKE_TAGS = new Set(['k', 'K', 'kf', 'ko']);

/** Wandelt eine ASS-Farbe (`&HAABBGGRR` oder Dezimalzahl) in `#RRGGBB[AA]`. */
function assColor(value: string): string | undefined {
  const v = value.trim();
  const hex = /^&H([0-9A-Fa-f]{1,8})&?$/u.exec(v);
  const n = hex !== null ? Number.parseInt(hex[1] ?? '0', 16) : /^-?\d+$/u.test(v) ? Number(v) >>> 0 : undefined;
  if (n === undefined || !Number.isFinite(n)) return undefined;
  const r = n & 0xff;
  const g = (n >>> 8) & 0xff;
  const b = (n >>> 16) & 0xff;
  const alpha = 255 - ((n >>> 24) & 0xff);
  const h = (x: number) => x.toString(16).padStart(2, '0').toUpperCase();
  return `#${h(r)}${h(g)}${h(b)}${alpha === 255 ? '' : h(alpha)}`;
}

/** Teilt eine Zeile in genau `count` Felder; das letzte Feld behält alle weiteren Kommas. */
function splitFields(rest: string, count: number): string[] | undefined {
  const parts = rest.split(',');
  if (parts.length < count) return undefined;
  return [...parts.slice(0, count - 1), parts.slice(count - 1).join(',')];
}

function assStyle(fields: Readonly<Record<string, string>>): AssStyle | undefined {
  const name = fields['name']?.trim();
  if (name === undefined || name === '') return undefined;
  const fontFamily = fields['fontname']?.trim();
  const size = Number(fields['fontsize']);
  const color = assColor(fields['primarycolour'] ?? fields['primarycolor'] ?? '');
  const alignment = Number(fields['alignment']);
  const flag = (v: string | undefined) => v !== undefined && v.trim() !== '0' && v.trim() !== '';
  return {
    name,
    ...(fontFamily !== undefined && fontFamily !== '' ? { fontFamily } : {}),
    ...(Number.isFinite(size) && size > 0 ? { fontSize: size } : {}),
    ...(color !== undefined ? { color } : {}),
    bold: flag(fields['bold']),
    italic: flag(fields['italic']),
    ...(Number.isInteger(alignment) && alignment >= 1 && alignment <= 9 ? { alignment } : {}),
  };
}

/** Wertet den Text einer Dialogue-Zeile aus: Karaoke-Zeiten, entfernte Tags. */
function assText(raw: string, start: number): { text: string; words: TimedSegment[] | undefined; removed: Set<string> } {
  const removed = new Set<string>();
  const segments: TimedSegment[] = [{ text: '', start, end: start }];
  let karaoke = false;
  let cursor = start;
  const plain = (s: string) => s.replace(/\\[Nn]/gu, '\n').replace(/\\h/gu, '\u00A0');
  const append = (s: string) => {
    const last = segments[segments.length - 1];
    if (last !== undefined) segments[segments.length - 1] = { ...last, text: last.text + s };
  };
  let pos = 0;
  for (const block of raw.matchAll(/\{([^}]*)\}/gu)) {
    append(plain(raw.slice(pos, block.index)));
    pos = block.index + block[0].length;
    for (const tag of (block[1] ?? '').matchAll(/\\(\d?[A-Za-z]+)([^\\]*)/gu)) {
      const name = tag[1] ?? '';
      if (KARAOKE_TAGS.has(name)) {
        const cs = Number((tag[2] ?? '').trim());
        const duration = Number.isFinite(cs) && cs > 0 ? cs / 100 : 0;
        karaoke = true;
        segments.push({ text: '', start: cursor, end: cursor + duration });
        cursor += duration;
      } else removed.add(`\\${name}`);
    }
  }
  append(plain(raw.slice(pos)));
  const text = segments.map((s) => s.text).join('').trim();
  return { text, words: karaoke ? timedWords(segments) : undefined, removed };
}

/**
 * Liest ASS/SSA: Stile (`[V4+ Styles]`), Ereignisse (`[Events]`) und Karaoke-Tags
 * (`\k`, `\K`, `\kf`, `\ko`) als Wortzeiten. Andere Override-Tags werden entfernt
 * und je Zeile mit einer Diagnose `OV_SUBTITLE_ASS_TAG` gemeldet.
 *
 * @example
 * ```ts
 * const { cues, styles } = parseAss(assText);
 * cues[0].words; // Wortzeiten aus {\k…}
 * styles[0].name; // 'Default'
 * ```
 */
export function parseAss(text: string): SubtitleParseResult {
  const cues: SubtitleCue[] = [];
  const info: CueInfo[] = [];
  const styles: AssStyle[] = [];
  const diagnostics: Diagnostic[] = [];
  let section = '';
  let styleFormat: string[] = [];
  let eventFormat = DEFAULT_EVENT_FORMAT;
  normalize(text).forEach((rawLine, i) => {
    const lineNo = i + 1;
    const l = rawLine.trim();
    if (l === '' || l.startsWith(';')) return;
    const head = /^\[(.+)\]$/u.exec(l);
    if (head !== null) {
      section = (head[1] ?? '').trim().toLowerCase();
      return;
    }
    const colon = l.indexOf(':');
    if (colon < 0) return;
    const key = l.slice(0, colon).trim().toLowerCase();
    const rest = l.slice(colon + 1).replace(/^\s/u, '');
    const isStyles = section === 'v4+ styles' || section === 'v4 styles';
    if (key === 'format') {
      const fields = rest.split(',').map((f) => f.trim().toLowerCase());
      if (isStyles) styleFormat = fields;
      else if (section === 'events') eventFormat = fields;
      return;
    }
    if (isStyles && key === 'style') {
      const parts = splitFields(rest, styleFormat.length);
      const style = parts === undefined ? undefined : assStyle(Object.fromEntries(styleFormat.map((f, j) => [f, parts[j] ?? ''])));
      if (style === undefined) {
        diagnostics.push(diagnostic('OV_SUBTITLE_PARSE', 'warning', `ASS style at line ${lineNo} does not match the style format; it was skipped.`, lineNo, ['Give every Style line one value per Format field.']));
      } else styles.push(style);
      return;
    }
    if (section !== 'events' || key !== 'dialogue') return;
    const parts = splitFields(rest, eventFormat.length);
    const field = (name: string) => {
      const j = eventFormat.indexOf(name);
      return j < 0 ? undefined : parts?.[j];
    };
    const startMatch = ASS_TIME.exec(field('start') ?? '');
    const endMatch = ASS_TIME.exec(field('end') ?? '');
    const body = field('text');
    if (parts === undefined || startMatch === null || endMatch === null || body === undefined) {
      diagnostics.push(
        diagnostic('OV_SUBTITLE_PARSE', 'warning', `ASS dialogue at line ${lineNo} is malformed; it was skipped.`, lineNo, [
          'Use "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Text" with one value per Format field.',
        ]),
      );
      return;
    }
    const start = hms(startMatch[1], startMatch[2], startMatch[3], startMatch[4]);
    const end = hms(endMatch[1], endMatch[2], endMatch[3], endMatch[4]);
    if (!checkedCue(start, end, lineNo, diagnostics)) return;
    const parsed = assText(body, start);
    if (parsed.removed.size > 0) {
      diagnostics.push(
        diagnostic('OV_SUBTITLE_ASS_TAG', 'warning', `Removed unsupported ASS override tags ${[...parsed.removed].join(', ')} at line ${lineNo}.`, lineNo, [
          'Style captions with the subtitles node (color, box, speakerStyles) instead of ASS override tags.',
        ]),
      );
    }
    const speaker = field('name')?.trim();
    const style = field('style')?.trim();
    cues.push(makeCue(start, end, parsed.text, speaker, parsed.words));
    info.push({ line: lineNo, ...(style !== undefined && style !== '' ? { style } : {}) });
  });
  return { format: 'ass', cues, info, styles, diagnostics };
}

// ---------------------------------------------------------------------------
// Formaterkennung
// ---------------------------------------------------------------------------

/**
 * Erkennt das Format eines Untertitel-Textes.
 *
 * @example
 * ```ts
 * detectSubtitleFormat('WEBVTT\n\n…'); // 'vtt'
 * ```
 */
export function detectSubtitleFormat(text: string): SubtitleFormat | undefined {
  const t = text.replace(/^\uFEFF/u, '').trimStart();
  if (/^WEBVTT(?:\s|$)/u.test(t)) return 'vtt';
  if (/^\[Script Info\]/imu.test(t) || /^\[Events\]/imu.test(t)) return 'ass';
  if (/\d+:\d{1,2}:\d{1,2}[,.]\d{1,3}\s*-->/u.test(t)) return 'srt';
  return undefined;
}

/**
 * Liest Untertitel in einem der Formate SRT, WebVTT oder ASS. Ohne `format`
 * wird das Format erkannt; unbekannte Formate ergeben eine Fehler-Diagnose und keine Cues.
 *
 * @example
 * ```ts
 * const { format, cues, diagnostics } = parseSubtitles(fileText);
 * ```
 */
export function parseSubtitles(text: string, format?: SubtitleFormat): SubtitleParseResult {
  const f = format ?? detectSubtitleFormat(text);
  if (f === 'srt') return parseSrt(text);
  if (f === 'vtt') return parseVtt(text);
  if (f === 'ass') return parseAss(text);
  return {
    format: 'srt',
    cues: [],
    info: [],
    styles: [],
    diagnostics: [diagnostic('OV_SUBTITLE_FORMAT', 'error', 'The subtitle format could not be detected.', 1, ['Use SRT, WebVTT (starts with "WEBVTT") or ASS (contains "[Events]").', 'Pass the format explicitly: parseSubtitles(text, "srt").'])],
  };
}
