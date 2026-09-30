/**
 * Story 17.8: ASS-Stile, Umbruch mit echter Textmessung, Karaoke-Fill im Wort,
 * per-Wort-textAnimation und Transkripte für `fromAudio`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { textUnitState, type EvaluatedNode, type ExpandContext, type IrNode } from '@agentic-video/core';
import { subtitlesExpander, type SubtitleTextStyle } from '@agentic-video/subtitles';

const W = 1920;
const H = 1080;
const ass = readFileSync(fileURLToPath(new URL('fixtures/karaoke.ass', import.meta.url)), 'utf8');

const CUES = [
  {
    start: '1s',
    end: '3s',
    text: 'Hello brave new world',
    words: [
      { text: 'Hello', start: '1s', end: '1.5s' },
      { text: 'brave', start: '1.5s', end: '2s' },
      { text: 'new', start: '2s', end: '2.5s' },
      { text: 'world', start: '2.5s', end: '3s' },
    ],
  },
];

function project(tracks: unknown[]): Record<string, unknown> {
  return { schemaVersion: '1.0.0', compositions: [{ id: 'main', width: W, height: H, fps: 30, duration: '12s', tracks, nodes: [] }] };
}

function ctx(p: Record<string, unknown>, seconds: number): ExpandContext {
  return { id: 'captions', frame: seconds * 30, fps: 30, seed: 0, durationFrames: 360, compositionWidth: W, compositionHeight: H, theme: {}, project: p, compositionId: 'main' };
}

function record(n: IrNode | undefined): Record<string, unknown> {
  if (n === undefined) throw new Error('no caption');
  return { ...n };
}

function spansOf(n: Record<string, unknown>): { text: string; fill: unknown }[] {
  const spans = n['spans'];
  return Array.isArray(spans) ? spans.map((s: { text: string; fill: unknown }) => ({ text: s.text, fill: s.fill })) : [];
}

/** Test-Messer: 0,5 em je Zeichen, fett 0,6 em. */
const measureText = (text: string, style: SubtitleTextStyle): number => Array.from(text).length * style.fontSize * ((style.fontWeight ?? 400) >= 700 ? 0.6 : 0.5);

describe('ASS-Stile (Story 17.8)', () => {
  const tracks = [{ id: 'subs', kind: 'subtitle', asset: 'k' }];
  const expander = () => subtitlesExpander({ loadTrackText: () => ass });

  it('übernimmt Schrift, Größe, Fett, Kontur, Ausrichtung unten und Ränder', () => {
    const p = project(tracks);
    const n = record(expander().expand({ id: 'captions', type: 'subtitles', track: 'subs' }, ctx(p, 1.2))[0]);
    expect(n).toMatchObject({ fontFamily: 'Inter', fontSize: 64, fontWeight: 700, fill: '#FFFFFF', stroke: '#000000', strokeWidth: 2, textAlign: 'center' });
    // Ränder links/rechts 10 px, unten 40 px (PlayRes 1920 × 1080 = Composition).
    expect(n['width']).toBe(1900);
    expect(n['x']).toBe(10);
    expect(Number(n['y']) + 64 * 1.2).toBeCloseTo(H - 40, 6);
  });

  it('setzt Stil "Sign" oben, kursiv, mit Farbe und Alpha', () => {
    const p = project(tracks);
    const n = record(expander().expand({ id: 'captions', type: 'subtitles', track: 'subs' }, ctx(p, 4.5))[0]);
    expect(n).toMatchObject({ fontFamily: 'Roboto', fontSize: 48, fontStyle: 'italic', fill: '#FFD400BF', y: 40 });
  });

  it('skaliert Größen und Ränder von PlayResY auf die Composition', () => {
    const small = ass.replace('PlayResX: 1920', 'PlayResX: 960').replace('PlayResY: 1080', 'PlayResY: 540');
    const p = project(tracks);
    const n = record(subtitlesExpander({ loadTrackText: () => small }).expand({ id: 'captions', type: 'subtitles', track: 'subs' }, ctx(p, 1.2))[0]);
    expect(n['fontSize']).toBe(128);
    expect(n['strokeWidth']).toBe(4);
    expect(n['x']).toBe(20);
  });

  it('Node-Props und speakerStyles haben Vorrang vor dem ASS-Stil', () => {
    const p = project(tracks);
    const n = record(expander().expand({ id: 'captions', type: 'subtitles', track: 'subs', fontSize: 40, position: 'top', speakerStyles: { Mia: { color: '#00FF00' } } }, ctx(p, 1.2))[0]);
    expect(n).toMatchObject({ fontSize: 40, fill: '#00FF00', textAlign: 'center', fontFamily: 'Inter' });
    expect(n['y']).toBe(40);
  });

  it('BorderStyle 3 wird zur Box in BackColour', () => {
    const boxed = ass.replace('Style: Default,Inter,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,', 'Style: Default,Inter,64,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,3,');
    const n = record(subtitlesExpander({ loadTrackText: () => boxed }).expand({ id: 'captions', type: 'subtitles', track: 'subs' }, ctx(project(tracks), 1.2))[0]);
    expect(n['background']).toMatchObject({ color: '#0000007F', perLine: true });
    expect(n['stroke']).toBeUndefined();
  });
});

describe('Umbruch mit echter Textmessung (Story 17.8)', () => {
  it('bricht an der gemessenen Breite statt an 0,6 em', () => {
    const text = 'aaaa bbbb cccc dddd eeee ffff gggg';
    const p = project([{ id: 'subs', kind: 'subtitle', cues: [{ start: '0s', end: '5s', text }] }]);
    const node = { id: 'captions', type: 'subtitles', track: 'subs', fontSize: 100, maxWidth: 1000 };
    const estimated = record(subtitlesExpander().expand(node, ctx(p, 1))[0]);
    const measured = record(subtitlesExpander({ measureText }).expand(node, ctx(p, 1))[0]);
    const lines = (n: Record<string, unknown>) => spansOf(n).map((s) => s.text).join('').split('\n');
    // 0,6 em: 16 Zeichen je Zeile; gemessen 0,5 em: 20 Zeichen.
    expect(lines(estimated)).toEqual(['aaaa bbbb cccc', 'dddd eeee ffff', 'gggg']);
    expect(lines(measured)).toEqual(['aaaa bbbb cccc dddd', 'eeee ffff gggg']);
  });
});

describe('Karaoke-Fill im Wort (Story 17.8)', () => {
  it('füllt das laufende Wort mit hartem Verlauf an der gemessenen Position', () => {
    const p = project([{ id: 'subs', kind: 'subtitle', cues: CUES }]);
    const n = record(subtitlesExpander({ measureText }).expand({ id: 'captions', type: 'subtitles', track: 'subs', style: 'karaoke', highlightColor: '#FF0000', fontSize: 100, maxWidth: 1600 }, ctx(p, 2.2))[0]);
    const spans = spansOf(n);
    expect(spans.map((s) => s.text)).toEqual(['Hello ', 'brave ', 'new ', 'world']);
    // Zeile "Hello brave new world" = 21 Zeichen × 50 px = 1050 px, zentriert in 1600 px → 275 px Einzug.
    // "new" beginnt nach "Hello brave " (12 × 50 px), 40 % von 150 px gefüllt.
    const fillX = 275 + 600 + 0.4 * 150;
    expect(spans[2]?.fill).toEqual({ type: 'linear', units: 'pixels', start: { x: fillX - 0.5, y: 0 }, end: { x: fillX + 0.5, y: 0 }, stops: [{ offset: 0, color: '#FF0000' }, { offset: 1, color: '#FFFFFF' }] });
    expect(spans[1]?.fill).toBe('#FF0000');
    expect(spans[3]?.fill).toBe('#FFFFFF');
  });
});

describe('per-Wort-textAnimation (Story 17.8)', () => {
  it('startet jedes Wort zu seiner Wortzeit', () => {
    const p = project([{ id: 'subs', kind: 'subtitle', cues: CUES }]);
    const anim = { unit: 'char', duration: 6, from: { opacity: 0, y: 20 } };
    const n = record(subtitlesExpander().expand({ id: 'captions', type: 'subtitles', track: 'subs', textAnimation: anim }, ctx(p, 1.6))[0]);
    expect(n['textAnimation']).toEqual({ unit: 'word', duration: 6, from: { opacity: 0, y: 20 }, starts: [30, 45, 60, 75] });
    const evaluated: EvaluatedNode = { id: 'c', type: 'rich-text', props: n, children: [], time: { localFrame: 48, relFrame: 48, durationFrames: 360, progress: 0, compositionFrame: 48 }, pointer: '' };
    // Frame 48: Wort 0 fertig, Wort 1 halb (3 von 6 Frames), Wort 2 noch nicht.
    expect(textUnitState(evaluated, 0, 4, 48, 30).opacity).toBe(1);
    const w1 = textUnitState(evaluated, 1, 4, 48, 30).opacity;
    expect(w1).toBeGreaterThan(0);
    expect(w1).toBeLessThan(1);
    expect(textUnitState(evaluated, 2, 4, 48, 30).opacity).toBe(0);
  });
});

describe('Transkripte für fromAudio (Story 17.8)', () => {
  const tracks = [{ id: 'subs', kind: 'subtitle', fromAudio: { source: 'vo', provider: 'whisper-cpp' } }];

  it('nutzt das vor dem Render aufgelöste Transkript', () => {
    const e = subtitlesExpander({ transcript: (c, t) => (c === 'main' && t === 'subs' ? { cues: CUES } : undefined) });
    const n = record(e.expand({ id: 'captions', type: 'subtitles', track: 'subs' }, ctx(project(tracks), 1.2))[0]);
    expect(spansOf(n).map((s) => s.text).join('')).toBe('Hello brave new world');
  });

  it('meldet den Grund, wenn die Transkription scheiterte', () => {
    const e = subtitlesExpander({
      transcript: () => ({ error: { code: 'OV_ASR_UNAVAILABLE', severity: 'error', errorClass: 'SpeechError', problem: 'No speech recognition (ASR) engine is installed on this host.', suggestions: ['Install whisper.cpp.'] } }),
    });
    expect(() => e.expand({ id: 'captions', type: 'subtitles', track: 'subs' }, ctx(project(tracks), 1.2))).toThrow(expect.objectContaining({ diagnostic: expect.objectContaining({ code: 'OV_ASR_UNAVAILABLE', nodeId: 'captions' }) }));
  });
});
