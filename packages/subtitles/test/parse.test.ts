import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { SubtitleCue, validateValue } from '@agentic-video/core';
import {
  detectSubtitleFormat,
  estimateWordTimings,
  formatSrt,
  formatVtt,
  parseAss,
  parseSrt,
  parseSubtitles,
  parseVtt,
  secondsToTime,
  timeToSeconds,
} from '@agentic-video/subtitles';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), 'utf8');

describe('secondsToTime', () => {
  it('schreibt Sekunden-Texte mit höchstens drei Nachkommastellen', () => {
    expect(secondsToTime(1.5)).toBe('1.5s');
    expect(secondsToTime(0)).toBe('0s');
    expect(secondsToTime(45296.789)).toBe('45296.789s');
    expect(secondsToTime(2.0504)).toBe('2.05s');
    expect(secondsToTime(-1)).toBe('0s');
  });

  it('ist umkehrbar auf Millisekunden genau', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 360_000_000 }), (ms) => {
        expect(timeToSeconds(secondsToTime(ms / 1000))).toBeCloseTo(ms / 1000, 6);
      }),
    );
  });
});

describe('parseSrt', () => {
  const result = parseSrt(fixture('broadcast.srt'));

  it('liest BOM, CRLF, Tags und Stunden > 9', () => {
    expect(result.cues.map((c) => c.text)).toEqual(['Welcome back to the show.', 'Tonight we talk about\nopen-source video.', 'Long-running broadcast.']);
    expect(result.cues[0]).toEqual({ start: '1s', end: '3.5s', text: 'Welcome back to the show.' });
    expect(result.cues[2]?.start).toBe('45296.789s');
    expect(result.info.map((i) => i.id)).toEqual(['1', '2', '5']);
  });

  it('meldet fehlerhafte Blöcke als Diagnose statt abzustürzen', () => {
    expect(result.diagnostics.map((d) => d.code)).toEqual(['OV_SUBTITLE_PARSE', 'OV_SUBTITLE_TIME']);
    expect(result.diagnostics[0]?.details?.['line']).toBe(10);
    expect(result.diagnostics.every((d) => d.suggestions.length > 0)).toBe(true);
  });

  it('erzeugt gültige IR-Cues', () => {
    for (const cue of result.cues) expect(validateValue(SubtitleCue, cue)).toEqual([]);
  });

  it('übersteht beliebigen Text', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => parseSubtitles(s)).not.toThrow();
        expect(() => parseSrt(s)).not.toThrow();
        expect(() => parseVtt(s)).not.toThrow();
        expect(() => parseAss(s)).not.toThrow();
      }),
    );
  });
});

describe('parseVtt', () => {
  const result = parseVtt(fixture('interview.vtt'));

  it('überspringt NOTE und STYLE, liest Identifier und Einstellungen', () => {
    expect(result.cues).toHaveLength(3);
    expect(result.info[0]).toMatchObject({ id: 'intro', settings: { line: '85%', align: 'center', position: '50%' } });
  });

  it('liest Sprecher und Entities', () => {
    expect(result.cues[0]).toMatchObject({ start: '0.5s', end: '2s', text: 'Hello & welcome!', speaker: 'Ana' });
    expect(result.cues[1]?.speaker).toBe('Ben');
  });

  it('liest innere Zeitstempel als Wortzeiten', () => {
    expect(result.cues[1]?.text).toBe('We ship today.');
    expect(result.cues[1]?.words).toEqual([
      { text: 'We', start: '2s', end: '2.5s' },
      { text: 'ship', start: '2.5s', end: '3s' },
      { text: 'today.', start: '3s', end: '4s' },
    ]);
  });

  it('entfernt Formatierungs-Tags und liest Stunden', () => {
    expect(result.cues[2]).toEqual({ start: '3600s', end: '3601.5s', text: 'Plain styled text' });
  });

  it('meldet den kaputten Block', () => {
    expect(result.diagnostics.map((d) => d.code)).toEqual(['OV_SUBTITLE_PARSE']);
  });

  it('verlangt die Kopfzeile WEBVTT', () => {
    const r = parseVtt('00:01.000 --> 00:02.000\nHi\n');
    expect(r.cues).toEqual([]);
    expect(r.diagnostics[0]).toMatchObject({ code: 'OV_SUBTITLE_FORMAT', severity: 'error' });
  });
});

describe('parseAss', () => {
  const result = parseAss(fixture('karaoke.ass'));

  it('liest Stile mit Farben', () => {
    // Story 17.8: auch Ränder, Kontur, Hintergrund und BorderStyle; dazu die Skript-Auflösung.
    expect(result.styles).toEqual([
      { name: 'Default', fontFamily: 'Inter', fontSize: 64, color: '#FFFFFF', bold: true, italic: false, alignment: 2, marginL: 10, marginR: 10, marginV: 40, outlineColor: '#000000', outline: 2, backColor: '#0000007F', borderStyle: 1 },
      { name: 'Sign', fontFamily: 'Roboto', fontSize: 48, color: '#FFD400BF', bold: false, italic: true, alignment: 8, marginL: 10, marginR: 10, marginV: 40, outlineColor: '#000000', outline: 2, backColor: '#000000', borderStyle: 1 },
    ]);
    expect(result.playRes).toEqual({ x: 1920, y: 1080 });
  });

  it('liest Karaoke-Tags als Wortzeiten', () => {
    const cue = result.cues[0];
    expect(cue?.text).toBe('Sing along, friends');
    expect(cue?.speaker).toBe('Mia');
    expect(cue?.words).toEqual([
      { text: 'Sing', start: '1s', end: '1.5s' },
      { text: 'along,', start: '1.5s', end: '2.2s' },
      { text: 'friends', start: '2.2s', end: '3s' },
    ]);
    expect(result.info[0]?.style).toBe('Default');
  });

  it('entfernt Override-Tags mit Diagnose und wandelt \\N in Umbrüche', () => {
    expect(result.cues[1]?.text).toBe('Closed\nfor repairs');
    const tag = result.diagnostics.find((d) => d.code === 'OV_SUBTITLE_ASS_TAG');
    expect(tag?.problem).toContain('\\pos');
    expect(tag?.problem).toContain('\\c');
  });

  it('überspringt Kommentare, meldet kaputte Zeiten und behält Kommas im Text', () => {
    expect(result.cues).toHaveLength(3);
    expect(result.cues[2]).toEqual({ start: '36000s', end: '36002s', text: 'Late line, with a comma' });
    expect(result.diagnostics.filter((d) => d.code === 'OV_SUBTITLE_PARSE')).toHaveLength(1);
  });
});

describe('parseSubtitles', () => {
  it('erkennt das Format', () => {
    expect(detectSubtitleFormat(fixture('broadcast.srt'))).toBe('srt');
    expect(detectSubtitleFormat(fixture('interview.vtt'))).toBe('vtt');
    expect(detectSubtitleFormat(fixture('karaoke.ass'))).toBe('ass');
    expect(parseSubtitles(fixture('karaoke.ass')).format).toBe('ass');
  });

  it('meldet unbekannte Formate', () => {
    const r = parseSubtitles('just some text');
    expect(r.cues).toEqual([]);
    expect(r.diagnostics[0]?.code).toBe('OV_SUBTITLE_FORMAT');
  });
});

describe('estimateWordTimings', () => {
  it('verteilt die Dauer proportional zur Zeichenzahl', () => {
    const cue = estimateWordTimings({ start: '1s', end: '2s', text: 'ab  cdef\ngh' });
    expect(cue.words).toEqual([
      { text: 'ab', start: '1s', end: '1.25s' },
      { text: 'cdef', start: '1.25s', end: '1.75s' },
      { text: 'gh', start: '1.75s', end: '2s' },
    ]);
  });

  it('lässt vorhandene Wortzeiten unverändert und rechnet Frames um', () => {
    const cue = { start: 0, end: 30, text: 'x', words: [{ text: 'x', start: 0, end: 30 }] };
    expect(estimateWordTimings(cue)).toBe(cue);
    expect(estimateWordTimings({ start: 24, end: 48, text: 'y' }, 24).words).toEqual([{ text: 'y', start: '1s', end: '2s' }]);
  });
});

describe('Export', () => {
  it('schreibt SRT und liest es verlustfrei zurück', () => {
    const cues = parseSrt(fixture('broadcast.srt')).cues;
    const text = formatSrt(cues);
    expect(text.split('\n').slice(0, 3)).toEqual(['1', '00:00:01,000 --> 00:00:03,500', 'Welcome back to the show.']);
    expect(text).toContain('12:34:56,789 --> 12:35:01,000');
    expect(parseSrt(text).cues).toEqual(cues);
  });

  it('schreibt VTT mit Sprechern und Wortzeiten und liest es zurück', () => {
    const cues = parseVtt(fixture('interview.vtt')).cues;
    const text = formatVtt(cues);
    expect(text).toContain('<v Ben>We <00:00:02.500>ship <00:00:03.000>today.');
    expect(text).toContain('Hello &amp; welcome!');
    expect(parseVtt(text).cues).toEqual(cues);
  });
});
