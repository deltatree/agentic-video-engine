/**
 * Export von Cues als SRT und WebVTT.
 */
import type { SubtitleCue } from '@agentic-video/core';
import { timeToSeconds } from './time.js';

/** Optionen für den Export. */
export interface FormatOptions {
  /** Framerate für Zeiten, die als Frame-Zahl vorliegen (Standard 30). */
  readonly fps?: number;
}

function clock(seconds: number, separator: ',' | '.'): string {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const p = (n: number, w: number) => String(n).padStart(w, '0');
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)}${separator}${p(ms % 1000, 3)}`;
}

/**
 * Schreibt Cues als SubRip (SRT). Sprecher und Wortzeiten gehen dabei verloren.
 *
 * @example
 * ```ts
 * formatSrt([{ start: '1s', end: '2.5s', text: 'Hello' }]);
 * // '1\n00:00:01,000 --> 00:00:02,500\nHello\n'
 * ```
 */
export function formatSrt(cues: readonly SubtitleCue[], options: FormatOptions = {}): string {
  const fps = options.fps ?? 30;
  return cues
    .map((c, i) => `${i + 1}\n${clock(timeToSeconds(c.start, fps), ',')} --> ${clock(timeToSeconds(c.end, fps), ',')}\n${c.text}\n`)
    .join('\n');
}

function escapeVtt(text: string): string {
  return text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/** Setzt innere Zeitstempel vor jedes Wort nach dem ersten; ohne passende Wörter bleibt der Text unverändert. */
function vttPayload(cue: SubtitleCue, fps: number): string {
  const words = cue.words ?? [];
  if (words.length === 0) return escapeVtt(cue.text);
  let out = '';
  let cursor = 0;
  for (const [i, w] of words.entries()) {
    const at = cue.text.indexOf(w.text, cursor);
    if (at < 0) return escapeVtt(cue.text);
    out += escapeVtt(cue.text.slice(cursor, at));
    if (i > 0) out += `<${clock(timeToSeconds(w.start, fps), '.')}>`;
    out += escapeVtt(w.text);
    cursor = at + w.text.length;
  }
  return out + escapeVtt(cue.text.slice(cursor));
}

/**
 * Schreibt Cues als WebVTT. Sprecher werden als `<v Name>`, Wortzeiten als innere
 * Zeitstempel geschrieben.
 *
 * @example
 * ```ts
 * formatVtt([{ start: '1s', end: '2s', text: 'Hi there', speaker: 'Ana' }]);
 * // 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Ana>Hi there\n'
 * ```
 */
export function formatVtt(cues: readonly SubtitleCue[], options: FormatOptions = {}): string {
  const fps = options.fps ?? 30;
  const body = cues.map((c) => {
    const voice = c.speaker !== undefined && c.speaker !== '' ? `<v ${escapeVtt(c.speaker)}>` : '';
    return `${clock(timeToSeconds(c.start, fps), '.')} --> ${clock(timeToSeconds(c.end, fps), '.')}\n${voice}${vttPayload(c, fps)}\n`;
  });
  return ['WEBVTT\n', ...body].join('\n');
}
