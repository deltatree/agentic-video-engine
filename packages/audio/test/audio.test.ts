import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AudioTrack, Track } from '@agentic-video/core';
import { locateFfmpeg, probeMedia } from '@agentic-video/ffmpeg';
import {
  applyCompressor,
  applyEq,
  applyLimiter,
  atempoChain,
  decodeAudio,
  masterAudio,
  measureLoudness,
  mixComposition,
  panGains,
  writeWav,
  type MixInput,
  type PcmBuffer,
} from '@agentic-video/audio';

const SR = 48000;
const FPS = 30;
let dir = '';
const sources = new Map<string, { path: string; duration: number }>();

/** Erzeugt eine WAV-Datei mit lavfi `aevalsrc`. */
function makeWav(id: string, expr: string, duration: number, channels = 1) {
  const path = join(dir, `${id}.wav`);
  const exprs = Array.from({ length: channels }, () => expr).join('|');
  execFileSync(locateFfmpeg().ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=${exprs}:s=${String(SR)}:d=${String(duration)}`, '-c:a', 'pcm_f32le', path]);
  sources.set(id, { path, duration });
}

function input(tracks: Track[], durationFrames: number, extra: Partial<MixInput> = {}): MixInput {
  return {
    tracks,
    resolveSource: (id) => {
      const s = sources.get(id);
      if (s === undefined) throw new Error(`unknown source ${id}`);
      return s;
    },
    fps: FPS,
    durationFrames,
    seed: 7,
    ...extra,
  };
}

function track(id: string, clips: AudioTrack['clips'], extra: Partial<AudioTrack> = {}): AudioTrack {
  return { id, kind: 'audio', clips, ...extra };
}

function rms(data: Float32Array, from: number, to: number): number {
  let s = 0;
  const a = Math.round(from * SR);
  const b = Math.round(to * SR);
  for (let i = a; i < b; i++) s += (data[i] ?? 0) ** 2;
  return Math.sqrt(s / Math.max(1, b - a));
}

function peak(data: Float32Array, from = 0, to = data.length / SR): number {
  let p = 0;
  for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) p = Math.max(p, Math.abs(data[i] ?? 0));
  return p;
}

/** Amplitude einer Frequenz im Fenster (Einzel-DFT). */
function tone(data: Float32Array, freq: number, from: number, to: number): number {
  let re = 0;
  let im = 0;
  const a = Math.round(from * SR);
  const b = Math.round(to * SR);
  for (let i = a; i < b; i++) {
    const w = (2 * Math.PI * freq * i) / SR;
    re += (data[i] ?? 0) * Math.cos(w);
    im += (data[i] ?? 0) * Math.sin(w);
  }
  return (2 * Math.hypot(re, im)) / (b - a);
}

function hashOf(buffer: PcmBuffer): string {
  const h = createHash('sha256');
  for (const ch of buffer.channels) h.update(new Uint8Array(ch.buffer, ch.byteOffset, ch.byteLength));
  return h.digest('hex');
}

function sine(freq: number, amp: number, seconds: number, channels = 2): PcmBuffer {
  const n = Math.round(seconds * SR);
  return {
    sampleRate: SR,
    channels: Array.from({ length: channels }, () => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / SR))),
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ov-audio-'));
  makeWav('tone', '0.5*sin(2*PI*440*t)', 3);
  makeWav('music', '0.5*sin(2*PI*220*t)', 10);
  makeWav('voice', '0.5*sin(2*PI*1000*t)*between(t\\,2\\,4)', 6);
  makeWav('click', 'if(lt(t\\,0.002)\\,0.9\\,0)', 0.5);
  makeWav('short', '0.5*sin(2*PI*440*t)', 1);
  makeWav('stereo', '0.5*sin(2*PI*440*t)', 2, 2);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('decodeAudio', () => {
  it('dekodiert zu Float32 je Kanal mit Zielrate', async () => {
    const buf = await decodeAudio(sources.get('tone')!.path);
    expect(buf.sampleRate).toBe(SR);
    expect(buf.channels).toHaveLength(2);
    expect(buf.channels[0]!.length).toBe(3 * SR);
    expect(peak(buf.channels[0]!)).toBeCloseTo(0.5, 3);
  });

  it('schneidet mit start/duration und ändert das Tempo per atempo', async () => {
    const part = await decodeAudio(sources.get('music')!.path, { start: 1, duration: 2 });
    expect(Math.abs(part.channels[0]!.length - 2 * SR)).toBeLessThanOrEqual(48);
    const fast = await decodeAudio(sources.get('music')!.path, { duration: 4, rate: 2 });
    expect(Math.abs(fast.channels[0]!.length - 2 * SR)).toBeLessThanOrEqual(SR * 0.02);
    expect(atempoChain(3)).toEqual(['atempo=2', 'atempo=1.5']);
    expect(atempoChain(0.25)).toEqual(['atempo=0.5', 'atempo=0.5']);
    expect(atempoChain(1)).toEqual([]);
  });

  it('meldet Fehler als OpenVideoError', async () => {
    await expect(decodeAudio(join(dir, 'missing.wav'))).rejects.toMatchObject({ diagnostic: { code: 'OV_FFMPEG_FAILED' } });
  });
});

describe('mixComposition', () => {
  it('liefert für eine leere Spur Stille in exakter Länge', async () => {
    const mix = await mixComposition(input([track('empty', [])], 90));
    expect(mix.channels).toHaveLength(2);
    expect(mix.channels[0]!.length).toBe(3 * SR);
    expect(peak(mix.channels[0]!)).toBe(0);
    expect(peak(mix.channels[1]!)).toBe(0);
  });

  it('ignoriert Clips nach dem Ende ohne Exception', async () => {
    const mix = await mixComposition(input([track('t', [{ id: 'late', source: 'tone', start: '5s' }, { id: 'edge', source: 'tone', start: 60 }])], 60));
    expect(mix.channels[0]!.length).toBe(2 * SR);
    expect(peak(mix.channels[0]!)).toBe(0);
  });

  it('Dauer: Länge = durationFrames / fps · sampleRate (±1 Block)', async () => {
    const mix = await mixComposition(input([track('t', [{ id: 'a', source: 'tone', start: 0 }])], 37, { sampleRate: 44100 }));
    expect(mix.sampleRate).toBe(44100);
    expect(Math.abs(mix.channels[0]!.length - (37 / FPS) * 44100)).toBeLessThanOrEqual(44.1);
  });

  it('Sync: Klick bei Frame 30 → Onset bei 1.000 s ±1 Frame', async () => {
    const mix = await mixComposition(input([track('sfx', [{ id: 'c', source: 'click', start: 30 }])], 60));
    const onset = mix.channels[0]!.findIndex((v) => Math.abs(v) > 0.1);
    expect(Math.abs(onset / SR - 1)).toBeLessThanOrEqual(1 / FPS);
    expect(Math.abs(onset - SR)).toBeLessThanOrEqual(2);
  });

  it('Mix-Pegel: konstante Leistung (−3 dB Mitte), Volume und Summe der Spuren', async () => {
    const one = await mixComposition(input([track('a', [{ id: 'a', source: 'tone', start: 0 }])], 60));
    expect(peak(one.channels[0]!, 0.1, 1.9)).toBeCloseTo(0.5 * Math.SQRT1_2, 3);
    expect(peak(one.channels[1]!, 0.1, 1.9)).toBeCloseTo(0.5 * Math.SQRT1_2, 3);
    const half = await mixComposition(input([track('a', [{ id: 'a', source: 'tone', start: 0, volume: 0.5 }])], 60));
    expect(peak(half.channels[0]!, 0.1, 1.9)).toBeCloseTo(0.25 * Math.SQRT1_2, 3);
    const trackVol = await mixComposition(input([track('a', [{ id: 'a', source: 'tone', start: 0 }], { volume: 0.5 })], 60));
    expect(hashOf(trackVol)).toBe(hashOf(half));
    const two = await mixComposition(input([track('a', [{ id: 'a', source: 'tone', start: 0 }]), track('b', [{ id: 'b', source: 'tone', start: 0 }])], 60));
    expect(peak(two.channels[0]!, 0.1, 1.9)).toBeCloseTo(Math.SQRT1_2, 3);
    const muted = await mixComposition(input([track('a', [{ id: 'a', source: 'tone', start: 0 }], { muted: true })], 60));
    expect(peak(muted.channels[0]!)).toBe(0);
  });

  it('Pan links/rechts', async () => {
    const left = await mixComposition(input([track('a', [{ id: 'a', source: 'tone', start: 0, pan: -1 }])], 30));
    expect(peak(left.channels[0]!)).toBeCloseTo(0.5, 3);
    expect(peak(left.channels[1]!)).toBe(0);
    const right = await mixComposition(input([track('a', [{ id: 'a', source: 'tone', start: 0 }], { pan: 1 })], 30));
    expect(peak(right.channels[0]!)).toBe(0);
    expect(peak(right.channels[1]!)).toBeCloseTo(0.5, 3);
    expect(panGains(0)[0]).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('animiert Volume und Pan (1/1000-s-Blöcke, linear dazwischen)', async () => {
    const volume = { $keyframes: [{ t: 0, v: 0 }, { t: '1s', v: 1 }] };
    const pan = { $keyframes: [{ t: 0, v: -1 }, { t: '2s', v: 1 }] };
    const mix = await mixComposition(input([track('a', [{ id: 'a', source: 'tone', start: 0, volume, pan }])], 60));
    const l = mix.channels[0]!;
    const r = mix.channels[1]!;
    expect(peak(l, 0, 0.01)).toBeLessThan(0.01);
    expect(rms(l, 0.45, 0.55) + rms(r, 0.45, 0.55)).toBeGreaterThan(0.1);
    expect(peak(l, 1.95, 2)).toBeLessThan(0.02);
    expect(peak(r, 1.95, 2)).toBeCloseTo(0.5, 1);
  });

  it('Fades, Trim (offset), Loop und playbackRate', async () => {
    const mix = await mixComposition(
      input(
        [
          track('fades', [{ id: 'f', source: 'tone', start: 0, duration: '2s', fadeIn: '0.5s', fadeOut: '0.5s' }]),
          track('loop', [{ id: 'l', source: 'short', start: '2s', loop: true }], { pan: -1 }),
          track('rate', [{ id: 'r', source: 'music', start: 0, offset: '8s', playbackRate: 2 }], { pan: 1 }),
        ],
        120,
      ),
    );
    const l = mix.channels[0]!;
    const r = mix.channels[1]!;
    // Fade-in: am Anfang leise, nach 0.5 s voll.
    expect(peak(l, 0, 0.02)).toBeLessThan(0.05);
    // Loop: die 1-s-Quelle füllt 2 s bis 4 s.
    expect(rms(l, 3.4, 3.6)).toBeCloseTo(0.5 / Math.SQRT2, 2);
    // Trim + Tempo 2: 2 s Quelle ab 8 s → 1 s Timeline; danach Stille rechts (außer Fade-Spur bis 2 s).
    expect(rms(r, 2.1, 3.9)).toBe(0);
    expect(tone(r, 220, 0.6, 0.9)).toBeGreaterThan(0.1);
    expect(tone(r, 220, 1.1, 1.4)).toBeLessThan(0.01);
  });

  it('Crossfade ohne Lücke zwischen aufeinanderfolgenden Clips', async () => {
    const clips: AudioTrack['clips'] = [
      { id: 'a', source: 'tone', start: 0, duration: '1s' },
      { id: 'b', source: 'tone', start: '1s', duration: '1s' },
    ];
    const mix = await mixComposition(input([track('x', clips, { crossfade: '0.2s' })], 60));
    const l = mix.channels[0]!;
    const steady = rms(l, 0.2, 0.8);
    for (let t = 0.05; t < 1.95; t += 0.01) expect(rms(l, t, t + 0.01), `t=${t.toFixed(2)}`).toBeGreaterThan(0.6 * steady);
    // Ohne Crossfade endet der erste Clip hart bei 1 s; mit Crossfade klingt er bis 1.2 s aus.
    const plain = await mixComposition(input([track('x', clips)], 60));
    expect(hashOf(plain)).not.toBe(hashOf(mix));
  });

  it('Ducking senkt die Musik messbar, solange die Stimme spricht', async () => {
    const tracks = [
      track('voice', [{ id: 'v', source: 'voice', start: 0 }]),
      track('music', [{ id: 'm', source: 'music', start: 0 }], { ducking: { by: 'voice', amount: -12, attack: 10, release: 200 } }),
    ];
    const mix = await mixComposition(input(tracks, 180));
    const l = mix.channels[0]!;
    const before = tone(l, 220, 0.5, 1.5);
    const during = tone(l, 220, 2.5, 3.5);
    const after = tone(l, 220, 5, 5.9);
    expect(20 * Math.log10(during / before)).toBeCloseTo(-12, 0);
    expect(after / before).toBeGreaterThan(0.95);
  });

  it('meldet unbekannte und zyklische Ducking-Referenzen', async () => {
    await expect(mixComposition(input([track('a', [], { ducking: { by: 'nope', amount: -6 } })], 30))).rejects.toMatchObject({ diagnostic: { code: 'OV_AUDIO_DUCKING_UNKNOWN' } });
    const cyc = [track('a', [], { ducking: { by: 'b', amount: -6 } }), track('b', [], { ducking: { by: 'a', amount: -6 } })];
    await expect(mixComposition(input(cyc, 30))).rejects.toMatchObject({ diagnostic: { code: 'OV_AUDIO_DUCKING_CYCLE' } });
  });

  it('löst Marker auf und überspringt Untertitelspuren', async () => {
    const tracks: Track[] = [track('sfx', [{ id: 'c', source: 'click', start: 'marker:hit' }]), { id: 'subs', kind: 'subtitle', cues: [] }];
    const mix = await mixComposition(input(tracks, 60, { markers: [{ id: 'hit', time: '0.5s' }] }));
    const onset = mix.channels[0]!.findIndex((v) => Math.abs(v) > 0.1);
    expect(Math.abs(onset - SR / 2)).toBeLessThanOrEqual(2);
  });

  it('ist deterministisch: gleiche Eingabe → bitgleiche Ausgabe (Hash)', async () => {
    const tracks = [
      track('voice', [{ id: 'v', source: 'voice', start: 0, pan: { $expr: 'sin(time * 3) * 0.5' } }], { eq: [{ type: 'highpass', frequency: 120 }], compressor: { threshold: -20, ratio: 3 } }),
      track('music', [{ id: 'm', source: 'music', start: 0, fadeIn: '1s', volume: { $keyframes: [{ t: 0, v: 0.2 }, { t: '3s', v: 1 }] } }, { id: 'm2', source: 'stereo', start: '4s' }], {
        crossfade: '0.1s',
        eq: [{ type: 'peak', frequency: 1000, gain: 3, q: 1 }, { type: 'lowshelf', frequency: 200, gain: -2 }],
        limiter: { ceiling: -3 },
        ducking: { by: 'voice', amount: -9 },
      }),
    ];
    const a = await mixComposition(input(tracks, 180));
    const b = await mixComposition(input(tracks, 180));
    expect(hashOf(a)).toBe(hashOf(b));
    const ma = masterAudio(a, { loudness: -16 });
    const mb = masterAudio(b, { loudness: -16 });
    expect(hashOf(ma)).toBe(hashOf(mb));
  });
});

describe('Mastering und DSP', () => {
  it('misst Lautheit nach BS.1770-4 (1 kHz, −20 dBFS, Stereo ≈ −20 LUFS)', () => {
    expect(measureLoudness(sine(1000, 0.1, 5))).toBeCloseTo(-20, 1);
    expect(measureLoudness(sine(1000, 0.1, 5, 1))).toBeCloseTo(-23.01, 1);
    expect(measureLoudness(sine(1000, 0, 5))).toBe(Number.NEGATIVE_INFINITY);
  });

  it('normalisiert auf −16 LUFS ±0.5', async () => {
    const mix = await mixComposition(input([track('m', [{ id: 'm', source: 'music', start: 0 }]), track('v', [{ id: 'v', source: 'voice', start: 0 }])], 180));
    const master = masterAudio(mix, { loudness: -16 });
    expect(Math.abs(measureLoudness(master) + 16)).toBeLessThanOrEqual(0.5);
    expect(peak(master.channels[0]!)).toBeLessThanOrEqual(10 ** (-1 / 20) + 1e-6);
  });

  it('Limiter hält die Obergrenze (5 ms Lookahead)', () => {
    const buf = sine(100, 0.9, 1);
    const ch = buf.channels;
    applyLimiter(ch, { ceiling: -6 }, SR);
    const ceiling = 10 ** (-6 / 20);
    expect(peak(ch[0]!)).toBeLessThanOrEqual(ceiling + 1e-7);
    expect(peak(ch[0]!, 0.5, 1)).toBeGreaterThan(ceiling * 0.95);
    const loud = masterAudio(sine(100, 0.2, 1), { loudness: -5, limiter: { ceiling: -3 } });
    expect(peak(loud.channels[0]!)).toBeLessThanOrEqual(10 ** (-3 / 20) + 1e-7);
  });

  it('EQ (RBJ) und Kompressor wirken', () => {
    const low = sine(5000, 0.5, 1);
    applyEq(low.channels, [{ type: 'lowpass', frequency: 500 }], SR);
    expect(rms(low.channels[0]!, 0.5, 1)).toBeLessThan(0.02);
    const boost = sine(1000, 0.1, 1);
    applyEq(boost.channels, [{ type: 'peak', frequency: 1000, gain: 6, q: 1 }], SR);
    expect(20 * Math.log10(peak(boost.channels[0]!, 0.5, 1) / 0.1)).toBeCloseTo(6, 1);
    const comp = sine(1000, 0.5, 1);
    applyCompressor(comp.channels, { threshold: -20, ratio: 4, attack: 1, release: 50 }, SR);
    // −6 dBFS Spitze, 14 dB über der Schwelle → 10.5 dB Reduktion.
    expect(20 * Math.log10(peak(comp.channels[0]!, 0.5, 1))).toBeCloseTo(-6 - 10.5, 0);
    expect(() => { applyEq(low.channels, [{ type: 'peak', frequency: 30000 }], SR); }).toThrow(/Nyquist/u);
  });

  it('schreibt WAV mit 16, 24 und 32 Bit', async () => {
    const buf = sine(440, 0.5, 0.5);
    for (const [bitDepth, codec] of [[16, 'pcm_s16le'], [24, 'pcm_s24le'], [32, 'pcm_f32le']] as const) {
      const path = join(dir, 'out', `w${String(bitDepth)}.wav`);
      await writeWav(buf, path, { bitDepth });
      const info = await probeMedia(path);
      expect(info.audio?.codec).toBe(codec);
      expect(info.audio?.sampleRate).toBe(SR);
      expect(info.audio?.channels).toBe(2);
      const back = await decodeAudio(path);
      expect(back.channels[0]!.length).toBe(buf.channels[0]!.length);
      expect(Math.abs(back.channels[0]![1000]! - buf.channels[0]![1000]!)).toBeLessThan(bitDepth === 16 ? 1e-4 : 1e-6);
    }
  });
});
