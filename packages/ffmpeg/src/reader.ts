/**
 * Frame-genaues Lesen von Videos als vormultipliziertes RGBA.
 *
 * Zuordnung: Quell-Frame-Index = `floor(seconds · fps + 1e-6)`, geklemmt auf `[0, frameCount − 1]`.
 * Ein laufender Decoder-Prozess liefert `rawvideo` fortlaufend. Fortlaufende Zugriffe lesen weiter.
 * Ein Sprung zurück oder weit nach vorn startet den Decoder neu: `-ss` eine halbe Frame-Dauer vor dem
 * Ziel-Frame als Eingabe-Option. FFmpeg dekodiert dann ab dem vorherigen Keyframe und verwirft exakt alle
 * Frames mit kleinerem Zeitstempel (Accurate Seek). Der erste gelieferte Frame ist damit der Ziel-Frame.
 * Voraussetzung ist eine konstante Bildrate der Quelle.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { OpenVideoError, type RgbaImage } from '@agentic-video/core';
import { locateFfmpeg } from './locate.js';
import { premultiplyInPlace } from './pixels.js';
import { decoderArgs, probeMedia, type MediaInfo, type ProbeOptions } from './probe.js';
import { appendLimited, lastLine, waitForExit } from './process.js';

/** Optionen für {@link VideoFrameReader.open}. */
export interface VideoFrameReaderOptions extends ProbeOptions {
  /** Anzahl der Frames im LRU-Cache (Standard 8). */
  readonly cacheSize?: number;
  /** Bis zu so vielen Frames Abstand liest der Decoder weiter statt neu zu starten (Standard 60). */
  readonly maxSkipFrames?: number;
}

interface Decoder {
  readonly child: ChildProcess;
  readonly iterator: AsyncIterator<unknown>;
  readonly chunks: Buffer[];
  bytes: number;
  /** Index des nächsten Frames, den der Decoder liefert. */
  next: number;
  stderr: string;
  last: RgbaImage | undefined;
}

/**
 * Liest einzelne Frames eines Videos frame-genau.
 *
 * @example
 * ```ts
 * const reader = await VideoFrameReader.open('clip.mp4');
 * const frame = await reader.frameAt(1.0); // Frame 30 bei 30 fps
 * await reader.close();
 * ```
 */
export class VideoFrameReader {
  readonly path: string;
  readonly info: MediaInfo;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frameCount: number;
  readonly #ffmpeg: string;
  readonly #timeoutMs: number;
  readonly #cacheSize: number;
  readonly #maxSkip: number;
  readonly #cache = new Map<number, RgbaImage>();
  #decoder: Decoder | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  private constructor(path: string, info: MediaInfo, ffmpeg: string, options: VideoFrameReaderOptions) {
    const video = info.video;
    if (video?.width === undefined || video.height === undefined || video.fps === undefined) {
      throw new OpenVideoError({
        code: 'OV_FFMPEG_PROBE',
        errorClass: 'FfmpegError',
        problem: `"${path}" has no video stream with known size and frame rate.`,
        details: { path },
        suggestions: ['Check that the file is a video, not an audio file or a still image.', 'Re-encode the video with a constant frame rate.'],
      });
    }
    this.path = path;
    this.info = info;
    this.width = video.width;
    this.height = video.height;
    this.fps = video.fps.value;
    const fromDuration = info.duration !== undefined ? Math.round(info.duration * this.fps) : 1;
    this.frameCount = Math.max(1, video.frameCount ?? fromDuration);
    this.#ffmpeg = ffmpeg;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.#cacheSize = Math.max(1, options.cacheSize ?? 8);
    this.#maxSkip = Math.max(0, options.maxSkipFrames ?? 60);
  }

  /**
   * Öffnet ein Video. Liest die Metadaten über ffprobe.
   *
   * @example
   * ```ts
   * const reader = await VideoFrameReader.open('clip.webm', { cacheSize: 16 });
   * ```
   */
  static async open(path: string, options: VideoFrameReaderOptions = {}): Promise<VideoFrameReader> {
    const { ffmpeg } = locateFfmpeg(options);
    const info = await probeMedia(path, options);
    return new VideoFrameReader(path, info, ffmpeg, options);
  }

  /**
   * Quell-Frame-Index für eine Zeit in Sekunden.
   *
   * @example
   * ```ts
   * reader.frameIndex(1 / 30); // 1 bei 30 fps
   * ```
   */
  frameIndex(seconds: number): number {
    const raw = Math.floor(seconds * this.fps + 1e-6);
    return Math.min(Math.max(raw, 0), this.frameCount - 1);
  }

  /**
   * Liefert den Frame zur Quellzeit `seconds` als vormultipliziertes RGBA.
   * Aufrufe werden nacheinander abgearbeitet.
   *
   * @example
   * ```ts
   * const img = await reader.frameAt(2.5);
   * ```
   */
  frameAt(seconds: number): Promise<RgbaImage> {
    const run = this.#queue.then(() => this.#frame(this.frameIndex(seconds)));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Beendet den Decoder-Prozess und leert den Cache.
   *
   * @example
   * ```ts
   * await reader.close();
   * ```
   */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#queue;
    await this.#stop();
    this.#cache.clear();
  }

  async #frame(index: number): Promise<RgbaImage> {
    if (this.#closed) {
      throw new OpenVideoError({ code: 'OV_FFMPEG_CLOSED', errorClass: 'FfmpegError', problem: 'The VideoFrameReader is closed.', details: { path: this.path }, suggestions: ['Open a new reader with VideoFrameReader.open().'] });
    }
    const hit = this.#cache.get(index);
    if (hit !== undefined) {
      this.#cache.delete(index);
      this.#cache.set(index, hit);
      return hit;
    }
    let dec = this.#decoder;
    if (dec === undefined || index < dec.next || index > dec.next + this.#maxSkip) {
      await this.#stop();
      dec = this.#start(index);
    }
    for (;;) {
      const image = await this.#read(dec);
      if (image === undefined) {
        // Ende des Streams vor dem Ziel: frameCount war zu hoch. Der letzte Frame gilt (Klemmung).
        const last = dec.last;
        await this.#stop();
        if (last !== undefined) return last;
        throw new OpenVideoError({
          code: 'OV_FFMPEG_NO_FRAME',
          errorClass: 'FfmpegError',
          problem: `Could not decode frame ${String(index)} of "${this.path}": ${lastLine(dec.stderr) || 'stream ended'}`,
          details: { path: this.path, frame: index, lastStderr: lastLine(dec.stderr) },
          suggestions: ['Check that the video is complete.', 'Re-encode the video with a constant frame rate.'],
        });
      }
      const current = dec.next;
      dec.next++;
      dec.last = image;
      this.#remember(current, image);
      if (current >= index) return image;
    }
  }

  #remember(index: number, image: RgbaImage): void {
    this.#cache.set(index, image);
    while (this.#cache.size > this.#cacheSize) {
      const oldest = this.#cache.keys().next();
      if (oldest.done === true) break;
      this.#cache.delete(oldest.value);
    }
  }

  #start(index: number): Decoder {
    const seek = index > 0 ? ['-ss', ((index - 0.5) / this.fps).toFixed(6)] : [];
    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      ...seek,
      ...decoderArgs(this.info.video),
      '-i', this.path,
      '-map', '0:v:0', '-an', '-sn', '-fps_mode', 'passthrough',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-',
    ];
    const child = spawn(this.#ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const dec: Decoder = { child, iterator: child.stdout[Symbol.asyncIterator](), chunks: [], bytes: 0, next: index, stderr: '', last: undefined };
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => { dec.stderr = appendLimited(dec.stderr, c); });
    child.on('error', (error) => { dec.stderr = appendLimited(dec.stderr, `\n${error.message}`); });
    this.#decoder = dec;
    return dec;
  }

  async #read(dec: Decoder): Promise<RgbaImage | undefined> {
    const size = this.width * this.height * 4;
    const timer = setTimeout(() => {
      dec.stderr = appendLimited(dec.stderr, `\ntimeout after ${String(this.#timeoutMs)} ms`);
      dec.child.kill('SIGKILL');
    }, this.#timeoutMs);
    try {
      while (dec.bytes < size) {
        const r = await dec.iterator.next();
        if (r.done === true) return undefined;
        const value: unknown = r.value;
        if (!(value instanceof Uint8Array)) continue;
        const buf = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        dec.chunks.push(buf);
        dec.bytes += buf.length;
      }
    } finally {
      clearTimeout(timer);
    }
    const all = dec.chunks.length === 1 ? (dec.chunks[0] ?? Buffer.alloc(0)) : Buffer.concat(dec.chunks);
    const data = new Uint8Array(size);
    data.set(all.subarray(0, size));
    dec.chunks.length = 0;
    const rest = all.subarray(size);
    if (rest.length > 0) dec.chunks.push(rest);
    dec.bytes = rest.length;
    return { width: this.width, height: this.height, data: premultiplyInPlace(data) };
  }

  async #stop(): Promise<void> {
    const dec = this.#decoder;
    this.#decoder = undefined;
    if (dec === undefined) return;
    // Ungelesene Ausgabe verwerfen, sonst meldet der Prozess nie `close`.
    dec.child.stdout?.destroy();
    if (dec.child.exitCode === null && dec.child.signalCode === null) dec.child.kill('SIGKILL');
    await waitForExit(dec.child);
  }
}
