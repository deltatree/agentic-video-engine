import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OutputFormat, RgbaImage, VideoCodec } from '@agentic-video/core';
import {
  VideoFrameReader,
  codecLicenses,
  concatSegments,
  createEncoder,
  extractThumbnail,
  licenseOf,
  locateFfmpeg,
  probeCapabilities,
  probeMedia,
  toRational,
  type EncoderOptions,
} from '@agentic-video/ffmpeg';

let dir = '';
const W = 64;
const H = 48;
const FPS = 30;

/** Deckendes Bild in einer Farbe (vormultipliziert = gerade bei Alpha 255). */
function solid(r: number, g: number, b: number, a = 255, w = W, h = H): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  const f = a / 255;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.round(r * f);
    data[i + 1] = Math.round(g * f);
    data[i + 2] = Math.round(b * f);
    data[i + 3] = a;
  }
  return { width: w, height: h, data };
}

async function encode(options: Omit<EncoderOptions, 'width' | 'height' | 'fps'> & { width?: number; height?: number; fps?: number }, frames: RgbaImage[]) {
  const enc = createEncoder({ width: W, height: H, fps: FPS, ...options });
  for (const f of frames) await enc.write(f);
  return enc.finish();
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as { diagnostic?: { code?: string } }).diagnostic?.code;
  }
  return undefined;
}

async function asyncErrorOf(promise: Promise<unknown>): Promise<{ code?: string; details?: Record<string, unknown> }> {
  try {
    await promise;
  } catch (error) {
    return (error as { diagnostic: { code?: string; details?: Record<string, unknown> } }).diagnostic;
  }
  throw new Error('expected an error');
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ov-ffmpeg-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('locateFfmpeg', () => {
  it('findet FFmpeg und ffprobe über PATH', () => {
    const bins = locateFfmpeg();
    expect(existsSync(bins.ffmpeg)).toBe(true);
    expect(existsSync(bins.ffprobe)).toBe(true);
  });

  it('meldet OV_FFMPEG_MISSING mit Installationshinweis', () => {
    try {
      locateFfmpeg({ ffmpegPath: '/nope' });
      throw new Error('expected an error');
    } catch (error) {
      const d = (error as { diagnostic: { code: string; suggestions: string[] } }).diagnostic;
      expect(d.code).toBe('OV_FFMPEG_MISSING');
      expect(d.suggestions.join(' ')).toMatch(/Install FFmpeg/u);
    }
  });

  it('beachtet OPENVIDEO_FFMPEG', () => {
    const before = process.env['OPENVIDEO_FFMPEG'];
    process.env['OPENVIDEO_FFMPEG'] = '/nope/ffmpeg';
    try {
      expect(errorCode(() => locateFfmpeg())).toBe('OV_FFMPEG_MISSING');
    } finally {
      if (before === undefined) delete process.env['OPENVIDEO_FFMPEG'];
      else process.env['OPENVIDEO_FFMPEG'] = before;
    }
  });
});

describe('probeCapabilities', () => {
  it('liest Version, Lizenz, Encoder und meldet ohne GPU keine Hardware', async () => {
    const caps = await probeCapabilities();
    expect(caps.version).not.toBe('unknown');
    expect(caps.license).toBe('GPL-3.0-or-later');
    expect(caps.encoders).toContain('libx264');
    expect(caps.decoders).toContain('h264');
    expect(caps.hardwareEncoders).toEqual({ nvenc: false, vaapi: false, qsv: false, videotoolbox: false });
    expect(probeCapabilities()).toBe(probeCapabilities());
  });

  it('leitet Lizenzen ab und kennt Codec-Lizenzen', () => {
    expect(licenseOf('--enable-gpl')).toBe('GPL-2.0-or-later');
    expect(licenseOf('--enable-shared')).toBe('LGPL-2.1-or-later');
    expect(licenseOf('--enable-gpl --enable-nonfree')).toBe('nonfree');
    expect(codecLicenses['libx264']?.license).toBe('GPL-2.0-or-later');
    expect(codecLicenses['libvpx-vp9']?.license).toBe('BSD-3-Clause');
    expect(codecLicenses['libaom-av1']?.license).toBe('BSD-2-Clause');
    expect(codecLicenses['prores_ks']?.license).toBe('LGPL-2.1-or-later');
  });

  it('bildet NTSC-Raten exakt ab', () => {
    expect(toRational(29.97)).toMatchObject({ num: 30000, den: 1001 });
    expect(toRational(30)).toMatchObject({ num: 30, den: 1 });
    expect(toRational(12.5)).toMatchObject({ num: 12500, den: 1000 });
  });
});

describe('createEncoder: Formate und Codecs', () => {
  const frames = Array.from({ length: 6 }, (_, i) => solid(40 * i, 255 - 40 * i, 128));
  const cases: { format: OutputFormat; codec?: VideoCodec; container: RegExp; probeCodec: string }[] = [
    { format: 'mp4', codec: 'h264', container: /mp4/u, probeCodec: 'h264' },
    { format: 'mp4', codec: 'h265', container: /mp4/u, probeCodec: 'hevc' },
    { format: 'mp4', codec: 'vp9', container: /mp4/u, probeCodec: 'vp9' },
    { format: 'mp4', codec: 'av1', container: /mp4/u, probeCodec: 'av1' },
    { format: 'mov', codec: 'h264', container: /mov/u, probeCodec: 'h264' },
    { format: 'mov', codec: 'h265', container: /mov/u, probeCodec: 'hevc' },
    { format: 'mov', codec: 'prores', container: /mov/u, probeCodec: 'prores' },
    { format: 'mov', codec: 'prores-4444', container: /mov/u, probeCodec: 'prores' },
    { format: 'mov', codec: 'ffv1', container: /mov/u, probeCodec: 'ffv1' },
    { format: 'webm', codec: 'vp9', container: /webm/u, probeCodec: 'vp9' },
    { format: 'webm', codec: 'av1', container: /webm/u, probeCodec: 'av1' },
    { format: 'gif', container: /gif/u, probeCodec: 'gif' },
  ];

  for (const c of cases) {
    it(`${c.format}/${c.codec ?? 'default'}: Container, Codec, Maße, Frame-Anzahl`, async () => {
      const out = join(dir, `matrix-${c.format}-${c.codec ?? 'default'}.${c.format}`);
      const result = await encode({ output: out, format: c.format, ...(c.codec !== undefined ? { codec: c.codec } : {}) }, frames);
      expect(result.frames).toBe(6);
      expect(result.duration).toBeCloseTo(6 / FPS, 9);
      const info = await probeMedia(out);
      expect(info.container).toMatch(c.container);
      expect(info.video?.codec).toBe(c.probeCodec);
      expect(info.video?.width).toBe(W);
      expect(info.video?.height).toBe(H);
      expect(info.video?.frameCount).toBe(6);
    });
  }

  it('webp (animiert): Container, Codec, Maße, Frame-Anzahl', async () => {
    const out = join(dir, 'anim.webp');
    const result = await encode({ output: out, format: 'webp' }, frames);
    expect(result.encoder).toMatch(/libwebp/u);
    const bytes = readFileSync(out);
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString('latin1')).toBe('WEBP');
    // FFmpeg 7 dekodiert animiertes WebP nicht; die Frames zählen wir über die ANMF-Chunks.
    const text = bytes.toString('latin1');
    expect(text.split('ANMF').length - 1).toBe(6);
    const vp8x = text.indexOf('VP8X');
    const width = 1 + (bytes[vp8x + 12]! | (bytes[vp8x + 13]! << 8) | (bytes[vp8x + 14]! << 16));
    const height = 1 + (bytes[vp8x + 15]! | (bytes[vp8x + 16]! << 8) | (bytes[vp8x + 17]! << 16));
    expect([width, height]).toEqual([W, H]);
  });

  const sequences: { format: OutputFormat; ext: string; probeCodec: string }[] = [
    { format: 'png-sequence', ext: 'png', probeCodec: 'png' },
    { format: 'jpeg-sequence', ext: 'jpg', probeCodec: 'mjpeg' },
    { format: 'webp-sequence', ext: 'webp', probeCodec: 'webp' },
  ];
  for (const s of sequences) {
    it(`${s.format}: Dateien, Codec, Maße, Frame-Anzahl`, async () => {
      const out = join(dir, `seq-${s.ext}`);
      const result = await encode({ output: out, format: s.format }, frames);
      expect(result.paths).toHaveLength(6);
      expect(readdirSync(out).filter((f) => f.endsWith(`.${s.ext}`)).sort()).toEqual(result.paths.map((p) => p.slice(out.length + 1)));
      expect(result.paths[0]).toMatch(new RegExp(`frame-000000\\.${s.ext}$`, 'u'));
      const info = await probeMedia(result.paths[5]!);
      expect(info.video?.codec).toBe(s.probeCodec);
      expect([info.video?.width, info.video?.height]).toEqual([W, H]);
    });
  }

  it('setzt Farbraum-Metadaten (bt709, sRGB-Transfer)', async () => {
    const info = await probeMedia(join(dir, 'matrix-mp4-h264.mp4'));
    expect(info.video?.colorSpace).toBe('bt709');
    expect(info.video?.colorPrimaries).toBe('bt709');
    expect(info.video?.colorTransfer).toBe('iec61966-2-1');
    expect(info.video?.pixFmt).toBe('yuv420p');
  });

  it('ist deterministisch: gleiche Frames → bitgleiche Datei', async () => {
    const a = join(dir, 'det-a.mp4');
    const b = join(dir, 'det-b.mp4');
    await encode({ output: a, format: 'mp4' }, frames);
    await encode({ output: b, format: 'mp4' }, frames);
    const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
    expect(hash(a)).toBe(hash(b));
  });

  it('nutzt ohne GPU die CPU (auto und explizite Familie)', async () => {
    const auto = await encode({ output: join(dir, 'hw-auto.mp4'), format: 'mp4', hardware: 'auto' }, frames.slice(0, 2));
    expect(auto.encoder).toBe('libx264');
    expect(auto.hardware).toBeUndefined();
    const nvenc = await encode({ output: join(dir, 'hw-nvenc.mp4'), format: 'mp4', hardware: 'nvenc' }, frames.slice(0, 2));
    expect(nvenc.encoder).toBe('libx264');
    expect(nvenc.args).toContain('libx264');
    expect(nvenc.args).toEqual(expect.arrayContaining(['-fflags', '+bitexact', '-map_metadata', '-1', '-threads', '4']));
  });

  it('muxt Audio (aac in mp4, opus in webm)', async () => {
    const wav = join(dir, 'tone.wav');
    execFileSync(locateFfmpeg().ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', wav]);
    const mp4 = await encode({ output: join(dir, 'audio.mp4'), format: 'mp4', audioPath: wav, audioBitrate: 128 }, frames);
    expect(mp4.audioEncoder).toBe('aac');
    const info = await probeMedia(mp4.paths[0]!);
    expect(info.audio?.codec).toBe('aac');
    expect(info.audio?.sampleRate).toBe(44100);
    const webm = await encode({ output: join(dir, 'audio.webm'), format: 'webm', audioPath: wav }, frames);
    expect((await probeMedia(webm.paths[0]!)).audio?.codec).toBe('opus');
    expect(errorCode(() => createEncoder({ output: join(dir, 'x.gif'), format: 'gif', width: W, height: H, fps: FPS, audioPath: wav }))).toBe('OV_ENCODE_AUDIO_UNSUPPORTED');
    expect(errorCode(() => createEncoder({ output: join(dir, 'x.webm'), format: 'webm', width: W, height: H, fps: FPS, audioPath: wav, audioCodec: 'aac' }))).toBe('OV_ENCODE_AUDIO_UNSUPPORTED');
  });

  it('liest Audio nur als lokale WAV-Datei: Protokoll- und Format-Whitelist (Story 16.5, M3)', async () => {
    const wav = join(dir, 'wl-tone.wav');
    execFileSync(locateFfmpeg().ffmpeg, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', wav]);
    const ok = await encode({ output: join(dir, 'wl-ok.mp4'), format: 'mp4', audioPath: wav }, frames.slice(0, 2));
    const at = ok.args.indexOf(wav);
    expect(ok.args.slice(at - 5, at + 1)).toEqual(['-protocol_whitelist', 'file', '-format_whitelist', 'wav,w64', '-i', wav]);
    // Eine concat-Liste, die als .wav getarnt eine andere Datei nachlädt, wird abgelehnt.
    const list = join(dir, 'wl-list.wav');
    writeFileSync(list, "ffconcat version 1.0\nfile 'wl-tone.wav'\n");
    await expect(encode({ output: join(dir, 'wl-bad.mp4'), format: 'mp4', audioPath: list }, frames.slice(0, 2))).rejects.toMatchObject({ diagnostic: { errorClass: expect.any(String) } });
  });

  it('prüft Codec, Maße und Frame-Größe', async () => {
    expect(errorCode(() => createEncoder({ output: join(dir, 'x.webm'), format: 'webm', codec: 'h264', width: W, height: H, fps: FPS }))).toBe('OV_ENCODE_CODEC_UNSUPPORTED');
    expect(errorCode(() => createEncoder({ output: join(dir, 'x.mp4'), format: 'mp4', width: 63, height: H, fps: FPS }))).toBe('OV_ENCODE_SIZE');
    const enc = createEncoder({ output: join(dir, 'size.mp4'), format: 'mp4', width: W, height: H, fps: FPS });
    expect((await asyncErrorOf(enc.write(solid(0, 0, 0, 255, 32, 32)))).code).toBe('OV_ENCODE_SIZE');
    expect((await asyncErrorOf(enc.finish())).code).toBe('OV_ENCODE_EMPTY');
    await enc.abort();
  });

  it('abort beendet FFmpeg und löscht die Ausgabe', async () => {
    const out = join(dir, 'aborted.mp4');
    const enc = createEncoder({ output: out, format: 'mp4', width: W, height: H, fps: FPS });
    await enc.write(frames[0]!);
    await enc.abort();
    expect(existsSync(out)).toBe(false);
    expect((await asyncErrorOf(enc.write(frames[0]!))).code).toBe('OV_ENCODE_CLOSED');
  });

  it('meldet FFmpeg-Fehler mit letzter stderr-Zeile', async () => {
    // Die Ausgabe ist ein Verzeichnis: FFmpeg kann die Datei nicht öffnen.
    const enc = createEncoder({ output: dir, format: 'mp4', width: W, height: H, fps: FPS });
    const d = await asyncErrorOf((async () => {
      for (let i = 0; i < 50; i++) await enc.write(frames[0]!);
      await enc.finish();
    })());
    expect(d.code).toBe('OV_FFMPEG_FAILED');
    expect(String(d.details?.['lastStderr'])).toMatch(/directory/iu);
    expect(String(d.details?.['exit'])).toMatch(/exit code [1-9]/u);
  });

  it('meldet nicht anlegbare Ausgabeverzeichnisse', async () => {
    // Ein Pfadteil ist eine Datei: das Verzeichnis lässt sich nicht anlegen.
    writeFileSync(join(dir, 'plain-file'), 'x');
    const enc = createEncoder({ output: join(dir, 'plain-file', 'sub', 'out.mp4'), format: 'mp4', width: W, height: H, fps: FPS });
    expect((await asyncErrorOf(enc.write(frames[0]!))).code).toBe('OV_ENCODE_OUTPUT');
  });

  it('concatSegments fügt Segmente per Stream Copy zusammen', async () => {
    const a = await encode({ output: join(dir, 'seg-0.mp4'), format: 'mp4' }, frames.slice(0, 3));
    const b = await encode({ output: join(dir, 'seg-1.mp4'), format: 'mp4' }, frames.slice(3));
    const out = join(dir, 'joined.mp4');
    const result = await concatSegments([a.paths[0]!, b.paths[0]!], out);
    expect(result.args).toEqual(expect.arrayContaining(['-c', 'copy']));
    const info = await probeMedia(out);
    expect(info.video?.frameCount).toBe(6);
    expect(info.duration).toBeCloseTo(0.2, 2);
  });
});

describe('Alpha-Export', () => {
  const half = solid(255, 0, 0, 128);

  it('lehnt nicht alpha-fähige Kombinationen ab', () => {
    expect(errorCode(() => createEncoder({ output: join(dir, 'x.mp4'), format: 'mp4', width: W, height: H, fps: FPS, alpha: true }))).toBe('OV_ENCODE_ALPHA_UNSUPPORTED');
    expect(errorCode(() => createEncoder({ output: join(dir, 'x.gif'), format: 'gif', width: W, height: H, fps: FPS, alpha: true }))).toBe('OV_ENCODE_ALPHA_UNSUPPORTED');
    expect(errorCode(() => createEncoder({ output: join(dir, 'x.mov'), format: 'mov', codec: 'prores', width: W, height: H, fps: FPS, alpha: true }))).toBe('OV_ENCODE_ALPHA_UNSUPPORTED');
  });

  it('VP9 mit yuva420p: ffprobe meldet Alpha, Alpha bleibt ~128', async () => {
    const out = join(dir, 'alpha.webm');
    await encode({ output: out, format: 'webm', codec: 'vp9', alpha: true }, [half, half, half]);
    const info = await probeMedia(out);
    expect(info.hasAlpha).toBe(true);
    expect(info.video?.metadata['alpha_mode']).toBe('1');
    const img = await extractThumbnail(out, 0);
    expect(Math.abs(img.data[3]! - 128)).toBeLessThanOrEqual(3);
  });

  it('ProRes 4444: ffprobe meldet yuva-Pixelformat', async () => {
    const out = join(dir, 'alpha.mov');
    const result = await encode({ output: out, format: 'mov', alpha: true }, [half, half]);
    expect(result.codec).toBe('prores-4444');
    const info = await probeMedia(out);
    expect(info.video?.pixFmt).toMatch(/^yuva444p/u);
    expect(info.hasAlpha).toBe(true);
    const img = await extractThumbnail(out, 0);
    expect(Math.abs(img.data[3]! - 128)).toBeLessThanOrEqual(1);
  });

  it('PNG-Sequenz: Pixel-Alpha 128 ±1, Farbe gerade gespeichert', async () => {
    const out = join(dir, 'alpha-png');
    const result = await encode({ output: out, format: 'png-sequence', alpha: true }, [half]);
    const info = await probeMedia(result.paths[0]!);
    expect(info.video?.pixFmt).toBe('rgba');
    const raw = execFileSync(locateFfmpeg().ffmpeg, ['-loglevel', 'error', '-i', result.paths[0]!, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
    expect(Math.abs(raw[3]! - 128)).toBeLessThanOrEqual(1);
    expect(raw[0]).toBe(255);
  });

  it('WebP-Sequenz speichert Alpha', async () => {
    const result = await encode({ output: join(dir, 'alpha-webp'), format: 'webp-sequence', alpha: true, quality: 100 }, [half]);
    const raw = execFileSync(locateFfmpeg().ffmpeg, ['-loglevel', 'error', '-i', result.paths[0]!, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
    expect(Math.abs(raw[3]! - 128)).toBeLessThanOrEqual(2);
  });
});

describe('VideoFrameReader und Einzelbilder', () => {
  const count = 40;
  let lossless = '';
  let lossy = '';

  beforeAll(async () => {
    // Frame n trägt seine Nummer in der Farbe: Rot = 6·n.
    const frames = Array.from({ length: count }, (_, n) => solid(6 * n, 0, 255 - 6 * n));
    lossless = (await encode({ output: join(dir, 'numbered.mov'), format: 'mov', codec: 'ffv1' }, frames)).paths[0]!;
    lossy = (await encode({ output: join(dir, 'numbered.mp4'), format: 'mp4', quality: 100 }, frames)).paths[0]!;
  });

  it('frameAt(n / fps) liefert Frame n (fortlaufend, rückwärts, Sprünge)', async () => {
    const reader = await VideoFrameReader.open(lossless, { maxSkipFrames: 4, cacheSize: 2 });
    expect(reader.frameCount).toBe(count);
    expect(reader.fps).toBe(FPS);
    const order = [0, 1, 2, 3, 10, 11, 5, 39, 38, 20, 21, 25, 0, 17];
    for (const n of order) {
      const img = await reader.frameAt(n / FPS);
      expect(img.data[0], `frame ${String(n)}`).toBe(6 * n);
    }
    expect((await reader.frameAt(10)).data[0]).toBe(6 * (count - 1));
    expect(reader.frameIndex(1 / FPS - 1e-9)).toBe(1);
    await reader.close();
  });

  it('liest frame-genau aus H.264 (verlustbehaftet, Toleranz)', async () => {
    const reader = await VideoFrameReader.open(lossy, { maxSkipFrames: 0 });
    for (const n of [0, 30, 7, 8, 33, 1]) {
      const img = await reader.frameAt(n / FPS);
      expect(Math.abs(img.data[0]! - 6 * n), `frame ${String(n)}`).toBeLessThanOrEqual(3);
    }
    await reader.close();
  });

  it('parallele Aufrufe bleiben korrekt', async () => {
    const reader = await VideoFrameReader.open(lossless);
    const images = await Promise.all([5, 6, 2, 30].map((n) => reader.frameAt(n / FPS)));
    expect(images.map((i) => i.data[0])).toEqual([30, 36, 12, 180]);
    await reader.close();
  });

  it('extractThumbnail skaliert auf die Zielbreite', async () => {
    const img = await extractThumbnail(lossless, 1, { width: 32 });
    expect([img.width, img.height]).toEqual([32, 24]);
    expect(img.data[0]).toBe(180);
  });

  it('probeMedia meldet Dauer, fps als Bruch und Zahl', async () => {
    const info = await probeMedia(lossy);
    expect(info.video?.fps).toEqual({ num: 30, den: 1, value: 30 });
    expect(info.duration).toBeCloseTo(count / FPS, 2);
    expect(info.video?.frameCount).toBe(count);
  });

  it('meldet fehlende Dateien mit stderr in details', async () => {
    const d = await asyncErrorOf(probeMedia(join(dir, 'missing.mp4')));
    expect(d.code).toBe('OV_FFMPEG_FAILED');
    expect(String(d.details?.['lastStderr'])).toMatch(/No such file/u);
  });
});
