import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isOpenVideoError, type RgbaImage } from '@agentic-video/core';
import { decodePng } from '@agentic-video/png';
import { checkerImage, compareImages, determinism, expectGolden, findOnsets, imageHash, integratedLoudness, peak, rms, solidImage } from '@agentic-video/testing';

const GOLDEN_DIR = fileURLToPath(new URL('./golden/', import.meta.url));

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(isOpenVideoError(caught) ? caught.diagnostic.code : caught).toBe(code);
}

function sine(freq: number, amplitude: number, seconds: number, sampleRate: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

describe('Testbilder und Hash', () => {
  it('solidImage ist vormultipliziert', () => {
    expect([...solidImage(1, 1, '#FFFFFF80').data]).toEqual([128, 128, 128, 128]);
    expect([...solidImage(2, 1, '#FF0000').data]).toEqual([255, 0, 0, 255, 255, 0, 0, 255]);
    expect([...solidImage(1, 1, 'transparent').data]).toEqual([0, 0, 0, 0]);
  });

  it('checkerImage wechselt die Felder', () => {
    const img = checkerImage(4, 4, 2, '#FFFFFF', '#000000');
    const at = (x: number, y: number) => img.data[(y * 4 + x) * 4];
    expect([at(0, 0), at(1, 1), at(2, 0), at(0, 2), at(2, 2)]).toEqual([255, 255, 0, 0, 255]);
  });

  it('imageHash ist stabil und unterscheidet Größe und Inhalt', () => {
    const a = solidImage(2, 2, '#123456');
    expect(imageHash(a)).toMatch(/^[0-9a-f]{64}$/u);
    expect(imageHash(a)).toBe(imageHash(solidImage(2, 2, '#123456')));
    expect(imageHash(a)).not.toBe(imageHash(solidImage(4, 1, '#123456')));
    expect(imageHash(a)).not.toBe(imageHash(solidImage(2, 2, '#123457')));
  });
});

describe('compareImages', () => {
  const base = solidImage(10, 10, '#808080');
  const withPixel = (delta: number): RgbaImage => {
    const data = base.data.slice();
    data[0] = (data[0] ?? 0) + delta;
    return { ...base, data };
  };

  it('gleiche Bilder bestehen', () => {
    expect(compareImages(base, base)).toMatchObject({ pass: true, diffPixels: 0, maxDelta: 0 });
  });

  it('Abweichung innerhalb maxChannelDelta zählt nicht', () => {
    expect(compareImages(withPixel(2), base)).toMatchObject({ pass: true, diffPixels: 0, maxDelta: 2 });
  });

  it('ein abweichender Pixel von 100 überschreitet 0.001 und wird rot markiert', () => {
    const r = compareImages(withPixel(3), base);
    expect(r).toMatchObject({ pass: false, diffPixels: 1, maxDelta: 3 });
    expect([...r.diffImage.data.slice(0, 4)]).toEqual([255, 0, 0, 255]);
    expect(r.diffImage.data[4]).toBeLessThan(255);
    expect(compareImages(withPixel(3), base, { maxDiffRatio: 0.01 }).pass).toBe(true);
  });

  it('verschiedene Größen bestehen nie', () => {
    const r = compareImages(solidImage(2, 2, '#000000'), solidImage(3, 2, '#000000'));
    expect(r).toMatchObject({ pass: false, diffPixels: 6, diffImage: { width: 3, height: 2 } });
  });
});

describe('expectGolden', () => {
  let dir = '';
  let saved: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ov-golden-'));
    saved = process.env['UPDATE_GOLDENS'];
    delete process.env['UPDATE_GOLDENS'];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env['UPDATE_GOLDENS'];
    else process.env['UPDATE_GOLDENS'] = saved;
  });

  it('fehlendes Golden: Fehler und .actual.png', () => {
    const path = join(dir, 'missing.png');
    expectCode(() => expectGolden(solidImage(2, 2, '#FF0000'), path), 'OV_TEST_GOLDEN_MISSING');
    expect(existsSync(join(dir, 'missing.actual.png'))).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('UPDATE_GOLDENS=1 schreibt, danach besteht der Vergleich', () => {
    const path = join(dir, 'sub', 'board.png');
    const img = checkerImage(8, 8, 2, '#FF000080', '#00FF00');
    process.env['UPDATE_GOLDENS'] = '1';
    expect(expectGolden(img, path).pass).toBe(true);
    expect(decodePng(readFileSync(path))).toEqual(img);
    delete process.env['UPDATE_GOLDENS'];
    expect(expectGolden(img, path).pass).toBe(true);
  });

  it('Abweichung: Fehler, .actual.png und .diff.png neben dem Golden', () => {
    const path = join(dir, 'frame.png');
    process.env['UPDATE_GOLDENS'] = '1';
    expectGolden(solidImage(4, 4, '#000000'), path);
    delete process.env['UPDATE_GOLDENS'];
    expectCode(() => expectGolden(solidImage(4, 4, '#FFFFFF'), path), 'OV_TEST_GOLDEN_MISMATCH');
    expect(decodePng(readFileSync(join(dir, 'frame.actual.png')))).toEqual(solidImage(4, 4, '#FFFFFF'));
    expect([...decodePng(readFileSync(join(dir, 'frame.diff.png'))).data.slice(0, 4)]).toEqual([255, 0, 0, 255]);
    // Ein bestandener Lauf räumt die Nebendateien auf.
    expectGolden(solidImage(4, 4, '#000000'), path);
    expect(existsSync(join(dir, 'frame.actual.png'))).toBe(false);
    expect(existsSync(join(dir, 'frame.diff.png'))).toBe(false);
  });
});

describe('Golden im Repository', () => {
  it('Schachbrett 64×64', () => {
    expect(expectGolden(checkerImage(64, 64, 8, '#FF8800', '#202040'), join(GOLDEN_DIR, 'checker.png')).pass).toBe(true);
  });
});

describe('Audio-Analyse', () => {
  it('rms und peak eines Sinus', () => {
    const s = sine(1000, 0.5, 1, 48000);
    expect(rms(s)).toBeCloseTo(0.5 / Math.SQRT2, 4);
    expect(peak(s)).toBeCloseTo(0.5, 4);
    expect(rms(new Float32Array(0))).toBe(0);
    expect(peak(new Float32Array([0.1, -0.75, 0.3]))).toBeCloseTo(0.75, 6);
  });

  it('1 kHz Sinus −20 dBFS stereo 48 kHz → −20 LUFS (±0.5)', () => {
    const s = sine(1000, 0.1, 5, 48000);
    expect(Math.abs(integratedLoudness([s, s], 48000) - -20)).toBeLessThanOrEqual(0.5);
  });

  it('Referenz BS.1770: 997 Hz, 0 dBFS, ein Kanal → −3.01 LUFS', () => {
    expect(integratedLoudness([sine(997, 1, 5, 48000)], 48000)).toBeCloseTo(-3.01, 1);
  });

  it('funktioniert bei 44.1 kHz', () => {
    const s = sine(997, 0.1, 5, 44100);
    expect(integratedLoudness([s, s], 44100)).toBeCloseTo(-20, 1);
  });

  it('Gating ignoriert Stille', () => {
    const s = sine(997, 0.1, 6, 48000);
    s.fill(0, 0, 3 * 48000);
    // Ohne Gating ergäbe die halbe Stille −23 LUFS; Blöcke am Übergang zählen laut Norm mit.
    expect(Math.abs(integratedLoudness([s, s], 48000) - -20)).toBeLessThanOrEqual(0.5);
    expect(integratedLoudness([new Float32Array(48000)], 48000)).toBe(-Infinity);
    expect(integratedLoudness([new Float32Array(100)], 48000)).toBe(-Infinity);
  });

  it('prüft Eingaben', () => {
    expectCode(() => integratedLoudness([], 48000), 'OV_TEST_AUDIO_INPUT');
    expectCode(() => integratedLoudness([new Float32Array(10), new Float32Array(11)], 48000), 'OV_TEST_AUDIO_INPUT');
    expectCode(() => integratedLoudness([new Float32Array(10)], 0), 'OV_TEST_AUDIO_INPUT');
    expectCode(() => findOnsets(new Float32Array(10), 48000, 0), 'OV_TEST_AUDIO_INPUT');
  });

  it('findOnsets findet Klicks und Sinus-Einsätze', () => {
    const rate = 48000;
    const s = new Float32Array(2 * rate);
    s.set(sine(440, 0.8, 0.1, rate), Math.round(0.5 * rate));
    s.set(sine(440, 0.8, 0.1, rate), Math.round(1.25 * rate) + 1);
    const onsets = findOnsets(s, rate, 0.5);
    expect(onsets).toHaveLength(2);
    expect(Math.abs((onsets[0] ?? 0) - 0.5)).toBeLessThan(0.001);
    expect(Math.abs((onsets[1] ?? 0) - 1.25)).toBeLessThan(0.001);
  });
});

describe('determinism', () => {
  const render = (frame: number): RgbaImage => solidImage(4, 4, `#${(frame * 10).toString(16).padStart(2, '0')}0000`);

  it('reine Funktion ist deterministisch', async () => {
    const r = await determinism(render, [0, 1, 2, 5]);
    expect(r.deterministic).toBe(true);
    expect(r.mismatches).toEqual([]);
    expect(r.forward.get(2)).toBe(r.backward.get(2));
  });

  it('versteckter Zustand fällt auf', async () => {
    let calls = 0;
    const stateful = (frame: number): Promise<RgbaImage> => Promise.resolve(solidImage(2, 2, `#0000${((frame + calls++) % 16).toString(16).padStart(2, '0')}`));
    const r = await determinism(stateful, [0, 1, 2]);
    expect(r.deterministic).toBe(false);
    expect(r.mismatches.length).toBeGreaterThan(0);
  });
});
