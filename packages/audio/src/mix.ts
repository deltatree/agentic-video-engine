/**
 * Offline-Mix der Audiospuren einer Composition (FR-52, FR-53).
 *
 * Signalfluss je Spur:
 * Clips (Trim, Loop, Tempo, Clip-Volume, Fades, Crossfade, Pan) → EQ → Kompressor → Spur-Volume → Limiter → Ducking.
 * Danach werden alle nicht stummen Spuren summiert. Das Mastering übernimmt {@link masterAudio}.
 *
 * Regeln:
 * - Pan-Gesetz mit konstanter Leistung ({@link panGains}): Mitte −3 dB je Kanal. Clip- und Spur-Pan
 *   werden addiert und auf [−1, 1] begrenzt; das Gesetz wirkt einmal.
 * - Animierbare Werte (`volume`, `pan`) werden mit `evaluateAnimated` alle 1/1000 s ausgewertet,
 *   dazwischen linear interpoliert. Clip-Werte laufen in Clip-Zeit, Spur-Werte in Composition-Zeit.
 * - Fades (`fadeIn`, `fadeOut`) sind linear.
 * - `crossfade` einer Spur: Beginnt ein Clip höchstens 1 Frame nach dem Ende des vorherigen (oder
 *   überlappt ihn), spielt der vorherige Clip bis `start + crossfade` des nächsten weiter. In diesem
 *   Bereich blendet er mit `cos` aus und der nächste mit `sin` ein (konstante Leistung).
 * - Clips, die bei oder nach dem Ende der Composition beginnen, werden ignoriert.
 */
import { OpenVideoError, evaluateAnimated, resolveMarkers, toFrames, type AudioClip, type AudioTrack, type Marker, type TimeValue, type Track } from '@agentic-video/core';
import type { FfmpegLocateOptions } from '@agentic-video/ffmpeg';
import { decodeAudio, type PcmBuffer } from './decode.js';
import { applyCompressor, applyDucking, applyEq, applyLimiter, panGains } from './dsp.js';

/** Aufgelöste Audioquelle. */
export interface ResolvedAudioSource {
  /** Lokaler Pfad einer von FFmpeg lesbaren Datei. */
  readonly path: string;
  /** Dauer in Sekunden. */
  readonly duration: number;
}

/** Eingabe für {@link mixComposition}. */
export interface MixInput extends FfmpegLocateOptions {
  /** `tracks` der Composition; Untertitelspuren werden übersprungen. */
  readonly tracks: readonly Track[];
  /** Löst die `source`-ID eines Clips auf. */
  resolveSource(id: string): ResolvedAudioSource | Promise<ResolvedAudioSource>;
  readonly fps: number;
  /** Dauer der Composition in Frames. */
  readonly durationFrames: number;
  /** Marker der Composition (IR-Liste oder bereits aufgelöst in Frames). */
  readonly markers?: readonly Marker[] | ReadonlyMap<string, number>;
  readonly seed?: number;
  /** Standard 48 000. */
  readonly sampleRate?: number;
  /** Timeout je Dekodier-Aufruf in Millisekunden. */
  readonly timeoutMs?: number;
}

/** Automationsblock: 1/1000 s. */
const BLOCKS_PER_SECOND = 1000;

interface TimeCtx {
  readonly fps: number;
  readonly seed: number;
  readonly markers: ReadonlyMap<string, number>;
}

/** Stückweise lineare Kurve eines animierbaren Wertes. */
class Automation {
  constructor(
    readonly constant: number | undefined,
    private readonly values: Float64Array,
    private readonly firstBlock: number,
  ) {}

  at(t: number): number {
    if (this.constant !== undefined) return this.constant;
    const x = t * BLOCKS_PER_SECOND - this.firstBlock;
    const last = this.values.length - 1;
    if (x <= 0) return this.values[0] ?? 0;
    if (x >= last) return this.values[last] ?? 0;
    const k = Math.floor(x);
    const a = this.values[k] ?? 0;
    const b = this.values[k + 1] ?? a;
    return a + (b - a) * (x - k);
  }
}

function audioError(code: string, problem: string, suggestions: readonly string[], extra: { path?: string } = {}): OpenVideoError {
  return new OpenVideoError({ code, errorClass: 'AudioError', problem, suggestions, ...extra });
}

/**
 * Wertet einen animierbaren Wert blockweise aus.
 * `origin` ist die Composition-Zeit (s), an der die lokale Zeit 0 beginnt.
 */
function automation(value: unknown, fallback: number, ctx: TimeCtx, origin: number, durationFrames: number, from: number, to: number, path: string): Automation {
  if (value === undefined) return new Automation(fallback, new Float64Array(0), 0);
  if (typeof value === 'number') return new Automation(value, new Float64Array(0), 0);
  const first = Math.floor(Math.max(0, from) * BLOCKS_PER_SECOND);
  const last = Math.ceil(Math.max(0, to) * BLOCKS_PER_SECOND) + 1;
  const values = new Float64Array(Math.max(2, last - first + 1));
  const markerOffset = origin * ctx.fps;
  for (let k = 0; k < values.length; k++) {
    const t = (first + k) / BLOCKS_PER_SECOND;
    const v = evaluateAnimated(value, { frame: (t - origin) * ctx.fps, fps: ctx.fps, seed: ctx.seed, durationFrames, markers: ctx.markers, markerOffset });
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw audioError('OV_AUDIO_AUTOMATION', `${path} must evaluate to a finite number, got ${JSON.stringify(v)}.`, ['Use a number or a numeric animation ($keyframes, $spring, $expr).'], { path });
    }
    values[k] = v;
  }
  return new Automation(undefined, values, first);
}

/** Ein platzierter Clip mit allen aufgelösten Zeiten in Sekunden (Composition-Zeit). */
interface Placed {
  readonly clip: AudioClip;
  readonly index: number;
  readonly path: string;
  readonly start: number;
  end: number;
  readonly offset: number;
  readonly rate: number;
  readonly loop: boolean;
  /** Länge der Quelle ab `offset` in Timeline-Sekunden (∞ bei Loop). */
  readonly natural: number;
  readonly fadeIn: number;
  readonly fadeOut: number;
  xfIn: { readonly start: number; readonly length: number } | undefined;
  xfOut: { readonly start: number; readonly length: number } | undefined;
}

function seconds(value: TimeValue | undefined, ctx: TimeCtx, markerOffset = 0): number {
  if (value === undefined) return 0;
  const markers = markerOffset === 0 ? ctx.markers : new Map([...ctx.markers].map(([k, v]) => [k, v - markerOffset]));
  return toFrames(value, { fps: ctx.fps, markers }) / ctx.fps;
}

async function placeClips(track: AudioTrack, trackIndex: number, input: MixInput, ctx: TimeCtx, total: number): Promise<Placed[]> {
  const placed: Placed[] = [];
  for (const [index, clip] of track.clips.entries()) {
    const start = seconds(clip.start, ctx);
    if (start >= total) continue;
    const src = await input.resolveSource(clip.source);
    const startFrame = start * ctx.fps;
    const offset = seconds(clip.offset, ctx, startFrame);
    const rate = clip.playbackRate ?? 1;
    const loop = clip.loop ?? false;
    const natural = loop ? Number.POSITIVE_INFINITY : Math.max(0, (src.duration - offset) / rate);
    const wanted = clip.duration !== undefined ? seconds(clip.duration, ctx, startFrame) : natural;
    const length = Math.min(wanted, natural);
    if (!(length > 0) || start + length <= 0) continue;
    placed.push({
      clip,
      index,
      path: src.path,
      start,
      end: start + length,
      offset,
      rate,
      loop,
      natural,
      fadeIn: seconds(clip.fadeIn, ctx, startFrame),
      fadeOut: seconds(clip.fadeOut, ctx, startFrame),
      xfIn: undefined,
      xfOut: undefined,
    });
    if (loop && src.duration - offset <= 0) {
      throw audioError('OV_AUDIO_CLIP', `Clip "${clip.id}" loops a source that is empty after offset ${String(offset)} s.`, ['Reduce the clip offset below the source duration.'], {
        path: `tracks[${String(trackIndex)}].clips[${String(index)}]`,
      });
    }
  }
  placed.sort((a, b) => a.start - b.start || a.index - b.index);
  const xf = track.crossfade !== undefined ? seconds(track.crossfade, ctx) : 0;
  if (xf > 0) {
    for (let i = 0; i + 1 < placed.length; i++) {
      const a = placed[i];
      const b = placed[i + 1];
      if (a === undefined || b === undefined || b.start <= a.start) continue;
      if (b.start - a.end >= 1 / ctx.fps) continue;
      a.end = Math.min(b.start + xf, a.start + a.natural);
      a.xfOut = { start: b.start, length: xf };
      b.xfIn = { start: b.start, length: xf };
    }
  }
  for (const p of placed) p.end = Math.min(p.end, total);
  return placed;
}

function fade(p: Placed, t: number): number {
  let f = 1;
  if (p.fadeIn > 0) f *= Math.min(1, Math.max(0, (t - p.start) / p.fadeIn));
  if (p.fadeOut > 0) f *= Math.min(1, Math.max(0, (p.end - t) / p.fadeOut));
  if (p.xfIn !== undefined && t < p.xfIn.start + p.xfIn.length) f *= Math.sin((Math.PI / 2) * Math.max(0, (t - p.xfIn.start) / p.xfIn.length));
  if (p.xfOut !== undefined && t >= p.xfOut.start) f *= Math.cos((Math.PI / 2) * Math.min(1, (t - p.xfOut.start) / p.xfOut.length));
  return f;
}

async function renderTrack(track: AudioTrack, trackIndex: number, input: MixInput, ctx: TimeCtx, sr: number, n: number, cache: Map<string, Promise<PcmBuffer>>): Promise<Float32Array[]> {
  const out = [new Float32Array(n), new Float32Array(n)];
  const total = n / sr;
  const base = `tracks[${String(trackIndex)}]`;
  const trackPan = automation(track.pan, 0, ctx, 0, input.durationFrames, 0, total, `${base}.pan`);
  const decodeOptions = {
    sampleRate: sr,
    channels: 2,
    ...(input.ffmpegPath !== undefined ? { ffmpegPath: input.ffmpegPath } : {}),
    ...(input.ffprobePath !== undefined ? { ffprobePath: input.ffprobePath } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  };
  for (const p of await placeClips(track, trackIndex, input, ctx, total)) {
    const clipPath = `${base}.clips[${String(p.index)}]`;
    const durationFrames = (p.end - p.start) * ctx.fps;
    const volume = automation(p.clip.volume, 1, ctx, p.start, durationFrames, p.start, p.end, `${clipPath}.volume`);
    const pan = automation(p.clip.pan, 0, ctx, p.start, durationFrames, p.start, p.end, `${clipPath}.pan`);
    const sourceSeconds = p.loop ? undefined : (p.end - p.start) * p.rate + 2 / sr;
    const key = JSON.stringify([p.path, p.offset, sourceSeconds ?? null, p.rate]);
    let pending = cache.get(key);
    if (pending === undefined) {
      pending = decodeAudio(p.path, { ...decodeOptions, start: p.offset, rate: p.rate, ...(sourceSeconds !== undefined ? { duration: sourceSeconds } : {}) });
      cache.set(key, pending);
    }
    const seg = await pending;
    const srcL = seg.channels[0] ?? new Float32Array(0);
    const srcR = seg.channels[1] ?? srcL;
    const segLen = srcL.length;
    if (segLen === 0) continue;
    const s0 = Math.round(p.start * sr);
    const s1 = Math.min(n, Math.round(p.end * sr));
    const constPan = pan.constant !== undefined && trackPan.constant !== undefined ? panGains(pan.constant + trackPan.constant) : undefined;
    const [outL, outR] = out;
    if (outL === undefined || outR === undefined) continue;
    for (let i = Math.max(0, s0); i < s1; i++) {
      let j = i - s0;
      if (p.loop) j %= segLen;
      else if (j >= segLen) break;
      const t = i / sr;
      const g = volume.at(t) * fade(p, t);
      const [gl, gr] = constPan ?? panGains(pan.at(t) + trackPan.at(t));
      outL[i] = (outL[i] ?? 0) + (srcL[j] ?? 0) * g * gl;
      outR[i] = (outR[i] ?? 0) + (srcR[j] ?? 0) * g * gr;
    }
  }
  if (track.eq !== undefined && track.eq.length > 0) applyEq(out, track.eq, sr);
  if (track.compressor !== undefined) applyCompressor(out, track.compressor, sr);
  const volume = automation(track.volume, 1, ctx, 0, input.durationFrames, 0, total, `${base}.volume`);
  if (volume.constant !== 1) {
    for (const ch of out) for (let i = 0; i < n; i++) ch[i] = (ch[i] ?? 0) * volume.at(i / sr);
  }
  if (track.limiter !== undefined) applyLimiter(out, track.limiter, sr);
  return out;
}

/** Reihenfolge, in der Führungsspuren vor den geduckten Spuren fertig sind. */
function duckingOrder(tracks: readonly AudioTrack[]): AudioTrack[] {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const order: AudioTrack[] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (t: AudioTrack, chain: readonly string[]) => {
    const s = state.get(t.id);
    if (s === 'done') return;
    if (s === 'visiting') {
      throw audioError('OV_AUDIO_DUCKING_CYCLE', `Ducking forms a cycle: ${[...chain, t.id].join(' → ')}.`, ['Remove one ducking reference so that no track ducks itself indirectly.']);
    }
    state.set(t.id, 'visiting');
    if (t.ducking !== undefined) {
      const leader = byId.get(t.ducking.by);
      if (leader === undefined) {
        throw audioError('OV_AUDIO_DUCKING_UNKNOWN', `Track "${t.id}" ducks by unknown audio track "${t.ducking.by}".`, [`Use the id of an audio track: ${[...byId.keys()].join(', ')}.`]);
      }
      visit(leader, [...chain, t.id]);
    }
    state.set(t.id, 'done');
    order.push(t);
  };
  for (const t of tracks) visit(t, []);
  return order;
}

/**
 * Mischt alle Audiospuren einer Composition zu Stereo. Deterministisch: gleiche Eingabe → bitgleiche Ausgabe.
 *
 * @example
 * ```ts
 * const mix = await mixComposition({
 *   tracks: composition.tracks ?? [],
 *   resolveSource: (id) => ({ path: `assets/${id}.wav`, duration: 12 }),
 *   fps: 30,
 *   durationFrames: 300,
 *   markers: composition.markers,
 *   seed: 1,
 * });
 * ```
 */
export async function mixComposition(input: MixInput): Promise<PcmBuffer> {
  const sr = input.sampleRate ?? 48000;
  if (!(input.fps > 0) || !(input.durationFrames >= 0)) {
    throw audioError('OV_AUDIO_TIMING', `Invalid fps ${String(input.fps)} or duration ${String(input.durationFrames)} frames.`, ['Pass the composition fps (> 0) and its duration in frames (>= 0).']);
  }
  const markers = input.markers === undefined ? new Map<string, number>() : input.markers instanceof Map ? input.markers : resolveMarkers(Array.isArray(input.markers) ? input.markers : [], input.fps);
  const ctx: TimeCtx = { fps: input.fps, seed: input.seed ?? 0, markers };
  const n = Math.round((input.durationFrames / input.fps) * sr);
  const audio = input.tracks.filter((t): t is AudioTrack => t.kind === 'audio');
  const cache = new Map<string, Promise<PcmBuffer>>();
  const rendered = new Map<string, Float32Array[]>();
  for (const [i, track] of audio.entries()) {
    rendered.set(track.id, track.muted === true ? [new Float32Array(n), new Float32Array(n)] : await renderTrack(track, i, input, ctx, sr, n, cache));
  }
  for (const track of duckingOrder(audio)) {
    if (track.ducking === undefined || track.muted === true) continue;
    const target = rendered.get(track.id);
    const key = rendered.get(track.ducking.by);
    if (target !== undefined && key !== undefined) applyDucking(target, key, track.ducking, sr);
  }
  const master = [new Float32Array(n), new Float32Array(n)];
  for (const track of audio) {
    if (track.muted === true) continue;
    const buf = rendered.get(track.id);
    if (buf === undefined) continue;
    for (let c = 0; c < 2; c++) {
      const dst = master[c];
      const src = buf[c];
      if (dst === undefined || src === undefined) continue;
      for (let i = 0; i < n; i++) dst[i] = (dst[i] ?? 0) + (src[i] ?? 0);
    }
  }
  return { sampleRate: sr, channels: master };
}
