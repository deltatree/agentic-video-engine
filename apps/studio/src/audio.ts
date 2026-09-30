/**
 * Ton in der Vorschau (Story 20.2) und Audio-Spuren (Story 20.7).
 *
 * Die Planung (welcher Clip wann mit welchem Ausschnitt spielt) ist reine Logik und testbar.
 * Die Wiedergabe nutzt WebAudio: Lautstärke, Pan, Fades, Offset, Dauer, Schleife und Tempo
 * der Clips wirken wie beim Export; EQ, Kompressor, Limiter und Ducking bleiben in der Vorschau aus.
 */
import { isRecord } from '@agentic-video/core';
import { fetchFile } from './api.js';
import { frames, timeInfo, uniqueId } from './ir.js';
import { num, records, str, type PatchJson, type Rec } from './json.js';

/** Ein spielbarer Clip in Sekunden der Composition. */
export interface ClipPlan {
  readonly trackId: string;
  readonly clipId: string;
  /** Pfad der Audiodatei im Projekt. */
  readonly src: string;
  readonly start: number;
  readonly offset: number;
  /** Länge im Ergebnis; `undefined` = bis zum Dateiende (bzw. endlos bei `loop`). */
  readonly duration: number | undefined;
  readonly volume: number;
  readonly pan: number;
  readonly fadeIn: number;
  readonly fadeOut: number;
  readonly loop: boolean;
  readonly rate: number;
}

/** Zeitwert (Frames, "2s", Marker) in Sekunden. */
function seconds(value: unknown, time: ReturnType<typeof timeInfo>, fallback: number): number {
  if (value === undefined) return fallback;
  return frames(value, time, fallback * time.fps) / time.fps;
}

/** Statischer Zahlenwert (animierte Lautstärke zählt in der Vorschau mit ihrem Standard). */
function staticNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Alle Clips der Audiospuren einer Composition, die eine Datei haben (erzeugte Stimmen fehlen,
 * bis sie gerendert sind). Stumme Spuren fallen weg.
 *
 * @example
 * ```ts
 * planClips(comp, project)[0]; // { trackId: 'music', clipId: 'bed', src: 'assets/bed.wav', start: 0, … }
 * ```
 */
export function planClips(comp: Readonly<Rec> | undefined, project: Readonly<Rec> | undefined): ClipPlan[] {
  const time = timeInfo(comp);
  const sources = records(project?.['audio']);
  const assets = records(project?.['assets']);
  const out: ClipPlan[] = [];
  for (const track of records(comp?.['tracks'])) {
    if (track['kind'] !== 'audio' || track['muted'] === true) continue;
    const trackVolume = staticNumber(track['volume'], 1);
    const trackPan = staticNumber(track['pan'], 0);
    for (const clip of records(track['clips'])) {
      const source = sources.find((s) => s['id'] === clip['source']);
      const asset = assets.find((a) => a['id'] === source?.['asset']);
      const src = str(asset?.['src'], '');
      if (src === '' || src.startsWith('http')) continue;
      const duration = clip['duration'] !== undefined ? seconds(clip['duration'], time, 0) : undefined;
      out.push({
        trackId: str(track['id'], ''),
        clipId: str(clip['id'], ''),
        src,
        start: seconds(clip['start'], time, 0),
        offset: seconds(clip['offset'], time, 0),
        duration,
        volume: staticNumber(clip['volume'], 1) * trackVolume,
        pan: Math.max(-1, Math.min(1, staticNumber(clip['pan'], 0) + trackPan)),
        fadeIn: seconds(clip['fadeIn'], time, 0),
        fadeOut: seconds(clip['fadeOut'], time, 0),
        loop: clip['loop'] === true,
        rate: num(clip['playbackRate'], 1),
      });
    }
  }
  return out;
}

/** Wann und mit welchem Ausschnitt ein Clip ab `from` (Sekunden der Composition) startet. */
export interface ClipSchedule {
  /** Verzögerung ab Wiedergabestart in Sekunden. */
  readonly delay: number;
  /** Position in der Datei in Sekunden. */
  readonly offset: number;
  /** Restlänge im Ergebnis (Sekunden); `undefined` = bis Dateiende bzw. endlos. */
  readonly length: number | undefined;
  /** Bereits vergangene Zeit im Clip (für Fades). */
  readonly elapsed: number;
}

/**
 * Plant einen Clip für eine Wiedergabe ab `from`. Liefert `undefined`, wenn der Clip dann schon vorbei ist.
 *
 * @example
 * ```ts
 * scheduleClip({ start: 2, offset: 0.5, duration: 3, rate: 1, loop: false, … }, 3, 10);
 * // { delay: 0, offset: 1.5, length: 2, elapsed: 1 }
 * ```
 */
export function scheduleClip(clip: Pick<ClipPlan, 'start' | 'offset' | 'duration' | 'rate' | 'loop'>, from: number, fileDuration: number): ClipSchedule | undefined {
  const natural = clip.loop ? undefined : Math.max(0, (fileDuration - clip.offset) / clip.rate);
  const total = clip.duration ?? natural;
  const elapsed = Math.max(0, from - clip.start);
  if (total !== undefined && elapsed >= total) return undefined;
  const raw = clip.offset + elapsed * clip.rate;
  const offset = clip.loop && fileDuration > 0 ? raw % fileDuration : raw;
  return { delay: Math.max(0, clip.start - from), offset, length: total !== undefined ? total - elapsed : undefined, elapsed };
}

/**
 * Sichtbare Länge eines Clips in Sekunden (für die Timeline); ohne bekannte Dateilänge 0.
 *
 * @example
 * ```ts
 * clipLength({ offset: 1, duration: undefined, rate: 1, loop: false }, 5); // 4
 * ```
 */
export function clipLength(clip: Pick<ClipPlan, 'offset' | 'duration' | 'rate' | 'loop'>, fileDuration: number | undefined): number {
  if (clip.duration !== undefined) return clip.duration;
  if (fileDuration === undefined || clip.loop) return 0;
  return Math.max(0, (fileDuration - clip.offset) / clip.rate);
}

/**
 * Spitzenwerte je Spalte für eine Wellenform (0…1) über den Ausschnitt `[from, to)` der Samples.
 *
 * @example
 * ```ts
 * peaks(new Float32Array([0, 0.5, -1, 0.25]), 2); // Float32Array [0.5, 1]
 * ```
 */
export function peaks(data: Float32Array, columns: number, from = 0, to = data.length): Float32Array {
  const out = new Float32Array(Math.max(0, columns));
  const start = Math.max(0, Math.min(data.length, Math.floor(from)));
  const end = Math.max(start, Math.min(data.length, Math.floor(to)));
  const per = (end - start) / Math.max(1, columns);
  for (let c = 0; c < columns; c++) {
    let peak = 0;
    const a = start + Math.floor(c * per);
    const b = Math.max(a + 1, start + Math.floor((c + 1) * per));
    for (let i = a; i < Math.min(end, b); i++) peak = Math.max(peak, Math.abs(data[i] ?? 0));
    out[c] = Math.min(1, peak);
  }
  return out;
}

/**
 * Patches, die ein Audio-Asset als neuen Clip ab `startFrame` einfügen (Story 20.7): Fehlt die
 * Audioquelle, wird sie angelegt; ohne passende Spur entsteht eine neue.
 *
 * @example
 * ```ts
 * addAudioClipPatches(project, comp, 'voice', 30); // [setProjectProperty audio, setCompositionProperty tracks]
 * ```
 */
export function addAudioClipPatches(project: Readonly<Rec> | undefined, comp: Readonly<Rec> | undefined, assetId: string, startFrame: number, trackId?: string): { patches: PatchJson[]; trackId: string; clipId: string } {
  const sources = records(project?.['audio']);
  const patches: PatchJson[] = [];
  let source = sources.find((s) => s['asset'] === assetId);
  if (source === undefined) {
    source = { id: uniqueId(assetId, new Set(sources.map((s) => str(s['id'], '')))), asset: assetId };
    patches.push({ op: 'setProjectProperty', property: 'audio', value: [...sources, source] });
  }
  const sourceId = str(source['id'], assetId);
  const tracks = records(comp?.['tracks']);
  const clipIds = new Set(tracks.flatMap((t) => records(t['clips']).map((c) => str(c['id'], ''))));
  const clipId = uniqueId(sourceId, clipIds);
  const clip = { id: clipId, source: sourceId, start: Math.max(0, Math.round(startFrame)) };
  const target = trackId !== undefined ? tracks.find((t) => t['id'] === trackId && t['kind'] === 'audio') : undefined;
  let nextTracks: Rec[];
  let chosen: string;
  if (target !== undefined) {
    chosen = str(target['id'], '');
    nextTracks = tracks.map((t) => (t === target ? { ...t, clips: [...records(t['clips']), clip] } : t));
  } else {
    chosen = uniqueId('audio', new Set(tracks.map((t) => str(t['id'], ''))));
    nextTracks = [...tracks, { id: chosen, kind: 'audio', clips: [clip] }];
  }
  patches.push({ op: 'setCompositionProperty', compositionId: str(comp?.['id'], 'main'), property: 'tracks', value: nextTracks });
  return { patches, trackId: chosen, clipId };
}

/** Änderung eines Clips aus der Timeline (Frames). */
export interface ClipEdit {
  readonly move?: number;
  readonly trimStart?: number;
  readonly trimEnd?: number;
  readonly fadeIn?: number;
  readonly fadeOut?: number;
}

/**
 * Wendet Ziehen/Trimmen/Fades auf einen Clip an (alle Zeiten danach in Frames).
 * Trimmen am Anfang verschiebt Start und Offset gemeinsam, damit der Ton an seiner Stelle bleibt.
 *
 * @example
 * ```ts
 * editClip({ id: 'c', source: 's', start: 10 }, { move: 5 }, { fps: 30, markers: new Map() }, 90); // start 15
 * ```
 */
export function editClip(clip: Readonly<Rec>, edit: ClipEdit, time: ReturnType<typeof timeInfo>, lengthFrames: number): Rec {
  const start = frames(clip['start'], time, 0);
  const offset = frames(clip['offset'], time, 0);
  const rate = num(clip['playbackRate'], 1);
  const next: Rec = { ...clip };
  let length = lengthFrames;
  if (edit.move !== undefined) next['start'] = Math.max(0, Math.round(start + edit.move));
  if (edit.trimStart !== undefined) {
    const d = Math.max(-Math.min(start, offset / rate), Math.min(edit.trimStart, length - 1));
    next['start'] = Math.round(start + d);
    next['offset'] = Math.max(0, Math.round(offset + d * rate));
    length = Math.max(1, Math.round(length - d));
    next['duration'] = length;
  }
  if (edit.trimEnd !== undefined) next['duration'] = Math.max(1, Math.round(length + edit.trimEnd));
  const finalLength = typeof next['duration'] === 'number' ? next['duration'] : length;
  const removed = new Set<string>();
  for (const key of ['fadeIn', 'fadeOut'] as const) {
    const change = edit[key];
    if (change === undefined) continue;
    const value = Math.max(0, Math.min(finalLength, Math.round(frames(clip[key], time, 0) + change)));
    if (value === 0) removed.add(key);
    else next[key] = value;
  }
  return removed.size === 0 ? next : Object.fromEntries(Object.entries(next).filter(([k]) => !removed.has(k)));
}

// ---------------------------------------------------------------------------
// WebAudio
// ---------------------------------------------------------------------------

const decoded = new Map<string, Promise<AudioBuffer>>();

/**
 * Lädt und dekodiert eine Audiodatei einmal je Projekt und Pfad (für Wellenform und Wiedergabe).
 *
 * @example
 * ```ts
 * const buffer = await decodeAudio('demo', 'assets/voice.wav');
 * ```
 */
export function decodeAudio(projectId: string, src: string): Promise<AudioBuffer> {
  const key = `${projectId}\u0000${src}`;
  let pending = decoded.get(key);
  if (pending === undefined) {
    pending = fetchFile(projectId, src).then((bytes) => new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes));
    // Fehlgeschlagene Dekodierung nicht zwischenspeichern (z. B. Datei erst später importiert).
    pending.catch(() => decoded.delete(key));
    decoded.set(key, pending);
  }
  return pending;
}

/**
 * Verwirft zwischengespeicherte Dekodierungen (nach einer Fremdänderung können Dateien anders sein).
 *
 * @example
 * ```ts
 * forgetDecodedAudio();
 * ```
 */
export function forgetDecodedAudio(): void {
  decoded.clear();
}

/**
 * Spielt die Clips einer Composition synchron zum Playhead ab.
 *
 * @example
 * ```ts
 * const player = new AudioPlayer();
 * await player.start('demo', planClips(comp, project), 2.5);
 * player.position(); // Sekunden der Composition, läuft mit der Audiouhr
 * player.stop();
 * ```
 */
export class AudioPlayer {
  private ctx: AudioContext | undefined;
  private master: GainNode | undefined;
  private nodes: AudioScheduledSourceNode[] = [];
  private startedAt = 0;
  private from = 0;
  private active = false;
  private muted = false;

  /** Läuft gerade Ton? */
  get playing(): boolean {
    return this.active;
  }

  /** Stummschalten, ohne die Wiedergabe zu stoppen. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master !== undefined && this.ctx !== undefined) this.master.gain.setValueAtTime(muted ? 0 : 1, this.ctx.currentTime);
  }

  /** Startet alle Clips ab `from` Sekunden. Liefert `false`, wenn nichts zu spielen ist. */
  async start(projectId: string, clips: readonly ClipPlan[], from: number): Promise<boolean> {
    this.stop();
    if (clips.length === 0) return false;
    const buffers = await Promise.all(clips.map((c) => decodeAudio(projectId, c.src).catch(() => undefined)));
    const ctx = this.ctx ?? new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    if (ctx.state === 'suspended') await ctx.resume();
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : 1;
    master.connect(ctx.destination);
    this.master = master;
    // Kleiner Vorlauf, damit alle Clips gleichzeitig beginnen.
    const t0 = ctx.currentTime + 0.05;
    clips.forEach((clip, i) => {
      const buffer = buffers[i];
      if (buffer === undefined) return;
      const s = scheduleClip(clip, from, buffer.duration);
      if (s === undefined) return;
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.loop = clip.loop;
      node.playbackRate.value = clip.rate;
      const gain = ctx.createGain();
      const at = t0 + s.delay;
      gain.gain.setValueAtTime(clip.volume, t0);
      if (clip.fadeIn > 0 && s.elapsed < clip.fadeIn) {
        gain.gain.setValueAtTime(clip.volume * (s.elapsed / clip.fadeIn), at);
        gain.gain.linearRampToValueAtTime(clip.volume, at + (clip.fadeIn - s.elapsed));
      }
      if (clip.fadeOut > 0 && s.length !== undefined) {
        const fadeStart = at + Math.max(0, s.length - clip.fadeOut);
        gain.gain.setValueAtTime(clip.volume * Math.min(1, s.length / clip.fadeOut), fadeStart);
        gain.gain.linearRampToValueAtTime(0, at + s.length);
      }
      const panner = ctx.createStereoPanner();
      panner.pan.value = clip.pan;
      node.connect(gain).connect(panner).connect(master);
      if (s.length !== undefined) node.start(at, s.offset, clip.loop ? undefined : s.length * clip.rate);
      else node.start(at, s.offset);
      if (s.length !== undefined && clip.loop) node.stop(at + s.length);
      this.nodes.push(node);
    });
    this.startedAt = t0;
    this.from = from;
    this.active = this.nodes.length > 0;
    return true;
  }

  /** Position in Sekunden der Composition nach der Audiouhr (vor dem Start: `from`). */
  position(): number {
    if (this.ctx === undefined) return this.from;
    return this.from + Math.max(0, this.ctx.currentTime - this.startedAt);
  }

  /** Stoppt alle Clips. */
  stop(): void {
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch (error) {
        // Ein noch nicht gestarteter Knoten wirft InvalidStateError; er ist dann ohnehin still.
        if (!(error instanceof DOMException)) throw error;
      }
      n.disconnect();
    }
    this.nodes = [];
    this.master?.disconnect();
    this.master = undefined;
    this.active = false;
  }
}

/**
 * Liest eine Audio-Asset-ID aus Drag-Daten der Assets-Liste (oder `undefined`).
 *
 * @example
 * ```ts
 * audioAssetOf('{"id":"voice","type":"audio"}'); // 'voice'
 * ```
 */
export function audioAssetOf(data: string): string | undefined {
  if (data === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(data);
    return isRecord(parsed) && parsed['type'] === 'audio' && typeof parsed['id'] === 'string' ? parsed['id'] : undefined;
  } catch {
    return undefined;
  }
}
