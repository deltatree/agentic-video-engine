import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Registry, RichTextNode, evaluateScene, validateProject, validateValue, type Diagnostic, type ExpandContext, type IrNode } from '@agentic-video/core';
import { registerSubtitles, subtitlesExpander } from '@agentic-video/subtitles';

interface Span {
  text: string;
  fill: string;
  fontSize?: number;
}
interface Caption {
  id: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  fill: string;
  fontFamily?: string;
  opacity?: number;
  spans: Span[];
  background?: { color: string; paddingX: number; paddingY: number; perLine?: boolean };
}

const W = 1920;
const H = 1080;

function project(node: Record<string, unknown>, tracks?: unknown[]): Record<string, unknown> {
  return {
    schemaVersion: '1.0.0',
    compositions: [
      {
        id: 'main',
        width: W,
        height: H,
        fps: 30,
        duration: '10s',
        tracks: tracks ?? [
          {
            id: 'subs',
            kind: 'subtitle',
            cues: [
              {
                start: '1s',
                end: '3s',
                text: 'Hello brave new world',
                speaker: 'ana',
                words: [
                  { text: 'Hello', start: '1s', end: '1.5s' },
                  { text: 'brave', start: '1.5s', end: '2s' },
                  { text: 'new', start: '2s', end: '2.5s' },
                  { text: 'world', start: '2.5s', end: '3s' },
                ],
              },
              { start: '3.2s', end: '5s', text: 'Second line' },
              { start: 150, end: 180, text: 'Frame based' },
            ],
          },
        ],
        nodes: [{ id: 'captions', type: 'subtitles', track: 'subs', ...node }],
      },
    ],
  };
}

function ctx(p: Record<string, unknown>, seconds: number): ExpandContext {
  return { id: 'captions', frame: seconds * 30, fps: 30, seed: 0, durationFrames: 300, compositionWidth: W, compositionHeight: H, theme: {}, project: p, compositionId: 'main' };
}

function captions(out: IrNode[]): Caption[] {
  for (const n of out) expect(validateValue(RichTextNode, n)).toEqual([]);
  return out as unknown as Caption[];
}

function expandAt(node: Record<string, unknown>, seconds: number, options: Parameters<typeof subtitlesExpander>[0] = {}): Caption[] {
  const p = project(node);
  return captions(subtitlesExpander(options).expand({ id: 'captions', type: 'subtitles', track: 'subs', ...node }, ctx(p, seconds)));
}

const fills = (n: Caption | undefined): string[] => n!.spans.map((s) => s.fill);
const texts = (n: Caption | undefined): string[] => n!.spans.map((s) => s.text);

describe('subtitlesExpander: aktiver Cue', () => {
  it('das Eingabeprojekt ist gültige IR', () => {
    expect(validateProject(project({ style: 'karaoke', box: { color: '#000000AA' } })).diagnostics).toEqual([]);
  });

  it('wählt den Cue zur lokalen Zeit', () => {
    expect(expandAt({}, 0.5)).toEqual([]);
    expect(texts(expandAt({}, 1.2)[0])).toEqual(['Hello ', 'brave ', 'new ', 'world']);
    expect(expandAt({}, 3.1)).toEqual([]);
    expect(expandAt({}, 4)[0]?.id).toBe('cue-1');
    expect(expandAt({}, 5.5)[0]?.id).toBe('cue-2');
    expect(expandAt({}, 6)).toEqual([]);
  });
});

describe('subtitlesExpander: Stile', () => {
  const red = '#FF0000';
  const white = '#FFFFFF';

  it('plain färbt alle Wörter gleich', () => {
    expect(fills(expandAt({}, 1.7)[0])).toEqual([white, white, white, white]);
  });

  it('word-highlight hebt das aktuelle Wort hervor', () => {
    expect(fills(expandAt({ style: 'word-highlight', highlightColor: red }, 1.7)[0])).toEqual([white, red, white, white]);
    expect(fills(expandAt({ style: 'word-highlight', highlightColor: red }, 2.9)[0])).toEqual([white, white, white, red]);
  });

  it('karaoke färbt gesungene Wörter und füllt das laufende Wort anteilig (Story 17.8)', () => {
    // 2,2 s: "new" läuft von 2 bis 2,5 s → 40 % gefüllt; ohne Textmesser nach Graphemen geteilt.
    const spans = expandAt({ style: 'karaoke', highlightColor: red }, 2.2)[0]!.spans;
    expect(spans.map((s) => [s.text, s.fill])).toEqual([['Hello ', red], ['brave ', red], ['n', red], ['ew ', white], ['world', white]]);
    expect(fills(expandAt({ style: 'karaoke', highlightColor: red }, 2.49)[0])).toEqual([red, red, red, white, white]);
  });

  it('pop vergrößert das aktuelle Wort', () => {
    const spans = expandAt({ style: 'pop', highlightColor: red, fontSize: 40 }, 1.7)[0]!.spans;
    expect(spans[1]).toMatchObject({ text: 'brave ', fill: red, fontSize: 50 });
    expect(spans[0]!.fontSize).toBeUndefined();
  });

  it('typewriter zeigt nur Wörter, die schon begonnen haben', () => {
    expect(texts(expandAt({ style: 'typewriter' }, 1.7)[0])).toEqual(['Hello ', 'brave']);
  });

  it('fade blendet den Cue ein und aus', () => {
    expect(expandAt({ style: 'fade' }, 1.05)[0]?.opacity).toBeCloseTo(0.2, 6);
    expect(expandAt({ style: 'fade' }, 2)[0]?.opacity).toBe(1);
    expect(expandAt({ style: 'fade' }, 2.9)[0]?.opacity).toBeCloseTo(0.4, 6);
  });

  it('speakerStyles setzen Farbe, Schrift und Box je Sprecher', () => {
    const n = expandAt({ speakerStyles: { ana: { color: '#00FF00', fontFamily: 'Roboto', box: '#112233' } } }, 1.2)[0];
    expect(n?.fill).toBe('#00FF00');
    expect(n?.fontFamily).toBe('Roboto');
    expect(n?.background).toMatchObject({ color: '#112233', perLine: true });
    // Cue ohne Sprecher: Standardstil
    const other = expandAt({ speakerStyles: { ana: { color: '#00FF00' } } }, 4)[0];
    expect(other?.fill).toBe('#FFFFFF');
    expect(other?.background).toBeUndefined();
  });

  it('wertet Theme-Referenzen und Animationen aus', () => {
    const p = project({ color: { $ref: 'theme.colors.caption' }, fontSize: { $keyframes: [{ t: 0, v: 20 }, { t: '10s', v: 120 }] } });
    const c = { ...ctx(p, 1.2), theme: { colors: { caption: '#ABCDEF' } } };
    const [n] = captions(subtitlesExpander().expand({ id: 'captions', type: 'subtitles', track: 'subs', color: { $ref: 'theme.colors.caption' }, fontSize: { $keyframes: [{ t: 0, v: 20 }, { t: '10s', v: 120 }] } }, c));
    expect(n?.fill).toBe('#ABCDEF');
    expect(n?.fontSize).toBeCloseTo(32, 6);
  });
});

describe('subtitlesExpander: Position in der Safe Area', () => {
  const inside = (c: Caption | undefined, safe: number) => {
    const n = c!;
    const bg = n.background ?? { paddingX: 0, paddingY: 0 };
    const lines = n.spans.filter((s) => s.text.endsWith('\n')).length + 1;
    const height = lines * n.fontSize * 1.2;
    expect(n.x - bg.paddingX).toBeGreaterThanOrEqual(W * safe - 1e-6);
    expect(n.x + n.width + bg.paddingX).toBeLessThanOrEqual(W * (1 - safe) + 1e-6);
    expect(n.y - bg.paddingY).toBeGreaterThanOrEqual(H * safe - 1e-6);
    expect(n.y + height + bg.paddingY).toBeLessThanOrEqual(H * (1 - safe) + 1e-6);
    return { top: n.y - bg.paddingY, bottom: n.y + height + bg.paddingY };
  };

  it('bottom liegt am unteren Rand der Safe Area', () => {
    const r = inside(expandAt({ box: { color: '#000000AA', paddingX: 20, paddingY: 10 } }, 1.2)[0], 0.05);
    expect(r.bottom).toBeCloseTo(H * 0.95, 6);
  });

  it('top liegt am oberen Rand, center in der Mitte', () => {
    expect(inside(expandAt({ position: 'top', safeArea: 0.1, box: { color: '#000000' } }, 1.2)[0], 0.1).top).toBeCloseTo(H * 0.1, 6);
    const c = expandAt({ position: 'center' }, 1.2)[0];
    expect(c!.y + (c!.fontSize * 1.2) / 2).toBeCloseTo(H / 2, 6);
  });

  it('custom überlässt die Position der Node', () => {
    expect(expandAt({ position: 'custom', x: 100, y: 200 }, 1.2)[0]).toMatchObject({ x: 0, y: 0 });
  });

  it('bricht lange Cues innerhalb von maxWidth um und bleibt in der Safe Area', () => {
    const long = 'This caption is much longer than a single line could ever hold on screen, so it wraps';
    const p = project({ fontSize: 64, maxWidth: 900 }, [{ id: 'subs', kind: 'subtitle', cues: [{ start: '0s', end: '5s', text: long }] }]);
    const [n] = captions(subtitlesExpander().expand({ id: 'captions', type: 'subtitles', track: 'subs', fontSize: 64, maxWidth: 900 }, ctx(p, 1)));
    expect(n?.width).toBe(900);
    const lines = texts(n).join('').split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length * 0.6 * 64).toBeLessThanOrEqual(900);
    inside(n, 0.05);
  });

  it('übernimmt harte Umbrüche aus dem Cue-Text', () => {
    const p = project({}, [{ id: 'subs', kind: 'subtitle', cues: [{ start: '0s', end: '5s', text: 'one\ntwo' }] }]);
    const [n] = captions(subtitlesExpander().expand({ id: 'captions', type: 'subtitles', track: 'subs' }, ctx(p, 1)));
    expect(texts(n)).toEqual(['one\n', 'two']);
  });
});

describe('subtitlesExpander: Tracks aus Assets und Fehler', () => {
  const srt = readFileSync(fileURLToPath(new URL('fixtures/broadcast.srt', import.meta.url)), 'utf8');
  const assetTracks = [{ id: 'subs', kind: 'subtitle', asset: 'srt' }];

  it('liest den Track über loadTrackText und meldet Parser-Diagnosen einmal', () => {
    const p = project({}, assetTracks);
    const seen: Diagnostic[] = [];
    const expander = subtitlesExpander({ loadTrackText: (id) => (id === 'srt' ? srt : undefined), onDiagnostic: (d) => seen.push(d) });
    const a = captions(expander.expand({ id: 'captions', type: 'subtitles', track: 'subs' }, ctx(p, 2)));
    const b = captions(expander.expand({ id: 'captions', type: 'subtitles', track: 'subs' }, ctx(p, 5)));
    expect(texts(a[0]).join('')).toBe('Welcome back to the show.');
    expect(texts(b[0]).join('')).toBe('Tonight we talk about\nopen-source video.');
    expect(seen.map((d) => d.code)).toEqual(['OV_SUBTITLE_PARSE', 'OV_SUBTITLE_TIME']);
  });

  it('wirft strukturierte Fehler für fehlende Tracks und Texte', () => {
    const p = project({}, assetTracks);
    const e = subtitlesExpander();
    expect(() => e.expand({ id: 'captions', type: 'subtitles', track: 'nope' }, ctx(p, 1))).toThrow(/Subtitle track "nope" does not exist/u);
    expect(() => e.expand({ id: 'captions', type: 'subtitles', track: 'subs' }, ctx(p, 1))).toThrow(/is not loaded/u);
    const pa = project({}, [{ id: 'subs', kind: 'subtitle', fromAudio: { source: 'vo', provider: 'whisper-cpp' } }]);
    expect(() => e.expand({ id: 'captions', type: 'subtitles', track: 'subs' }, ctx(pa, 1))).toThrow(/has fromAudio, but it was not transcribed/u);
  });
});

describe('Integration mit evaluateScene', () => {
  it('registerSubtitles expandiert die Node zu gültiger rich-text-IR', () => {
    const registry = new Registry();
    registerSubtitles(registry);
    const p = project({ style: 'word-highlight', highlightColor: '#FF0000', box: { color: '#000000AA', radius: 8 } });
    const scene = evaluateScene(p, 'main', 51, { registry });
    expect(scene.diagnostics).toEqual([]);
    const group = scene.nodes[0];
    expect(group?.type).toBe('group');
    const text = group?.children[0];
    expect(text?.type).toBe('rich-text');
    expect(text?.id).toBe('captions/cue-0');
    expect((text?.props['spans'] as { fill: string }[]).map((s) => s.fill)).toEqual(['#FFFFFF', '#FF0000', '#FFFFFF', '#FFFFFF']);
  });
});
