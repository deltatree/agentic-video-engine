/**
 * Audio-Stufe der Pipeline (FR-52..FR-54, FR-59): Tonspuren, Ton aus Video-Nodes und erzeugte
 * Stimmen werden offline gemischt, gemastert und als WAV geschrieben. Ergebnis im Audio-Cache.
 *
 * Verschachtelung und Zeitabbildung (Story 17.7):
 * - Video-Nodes in einfacher Einbettung (nur `timing.from`/`duration` an der Node und allen
 *   Vorfahren, außerhalb von `sequence` und Komponenten) werden als Clips gemischt; `playbackRate`
 *   ändert dabei das Tempo mit erhaltener Tonhöhe.
 * - Alle anderen Video-Nodes (mit `speed`, `reverse`, `remap`, `loop`, `pingPong`, `hold` an der Node
 *   oder einem Vorfahren, in `sequence` oder Komponenten) und jede `composition-ref` folgen der
 *   ausgewerteten Zeit: Je Composition-Frame wird die Quellzeit bestimmt, dazwischen linear
 *   interpoliert, und die Quelle wie ein Band abgespielt (Tonhöhe folgt der Geschwindigkeit).
 * - Eine `composition-ref` bringt den Mix ihrer Composition mit (Spuren, Video-Ton, weitere Refs,
 *   rekursiv), ohne deren eigenes Mastering; gemastert wird nur die äußere Composition.
 */
import { writeFile } from 'node:fs/promises';
import { masterAudio, measureLoudness, mixComposition, encodeWav, type MappedAudioSource, type PcmBuffer } from '@agentic-video/audio';
import type { Cache } from '@agentic-video/cache';
import {
  OpenVideoError,
  compositionDurationFrames,
  contentHash,
  evaluateScene,
  findComposition,
  isRecord,
  toFrames,
  type AssetResolver,
  type EvaluatedNode,
  type Registry,
  type Track,
} from '@agentic-video/core';
import type { AudioEngine } from './environment.js';
import { inspectTimeline } from './inspect.js';

/** Eine erzeugte Stimme als Audio-Datei. */
export interface SynthesizedVoice {
  readonly path: string;
  readonly duration: number;
  readonly hash: string;
}

/** Optionen für {@link createAudioEngine}. */
export interface AudioEngineOptions {
  readonly assets: AssetResolver;
  readonly cache: Cache;
  /** Erzeugt Stimmen für `project.audio`-Einträge mit `voice` (Paket `speech`); Ergebnis nach Quell-ID. */
  readonly synthesizeVoices?: (project: Readonly<Record<string, unknown>>) => Promise<ReadonlyMap<string, SynthesizedVoice>>;
  readonly sampleRate?: 44100 | 48000;
  /** Registry für die Auswertung von Komponenten beim Abtasten der Zeit (Story 17.7). */
  readonly registry?: Registry;
}

/** Größte Verschachtelung von `composition-ref` im Mix. */
const MAX_AUDIO_DEPTH = 16;

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isTrack(value: Record<string, unknown>): value is Record<string, unknown> & Track {
  return value['kind'] === 'audio' && Array.isArray(value['clips']) && typeof value['id'] === 'string';
}

/** Zeit-Schlüssel, die eine Node nur verschieben oder begrenzen, nicht strecken. */
const PLAIN_TIMING_KEYS: ReadonlySet<string> = new Set(['from', 'duration']);

function plainTiming(node: Readonly<Record<string, unknown>>): boolean {
  const timing = node['timing'];
  return !isRecord(timing) || Object.keys(timing).every((k) => PLAIN_TIMING_KEYS.has(k) || timing[k] === undefined);
}

/** Node-Typen, deren Kinder nicht in einfacher Einbettung liegen (Anordnung bzw. Expansion). */
const ARRANGING_TYPES: ReadonlySet<string> = new Set(['sequence', 'component']);

/** Einteilung der Ton-Quellen einer Composition (nur ihre eigenen Nodes, ohne verschachtelte Compositions). */
interface AudioNodes {
  /** IDs der Video-Nodes in einfacher Einbettung. */
  readonly plainVideos: ReadonlySet<string>;
  /** Gibt es Video-Nodes außerhalb einfacher Einbettung? */
  readonly timedVideos: boolean;
  /** `composition-ref`-Nodes der IR: ID → Composition. */
  readonly refs: ReadonlyMap<string, string>;
}

function classify(composition: Readonly<Record<string, unknown>>): AudioNodes {
  const plainVideos = new Set<string>();
  const refs = new Map<string, string>();
  let timedVideos = false;
  const visit = (list: unknown, plain: boolean): void => {
    for (const n of records(list)) {
      const type = String(n['type']);
      const here = plain && plainTiming(n);
      if (type === 'video' && n['muted'] !== true && typeof n['asset'] === 'string') {
        if (here) plainVideos.add(String(n['id']));
        else timedVideos = true;
      }
      if (type === 'composition-ref' && typeof n['composition'] === 'string') refs.set(String(n['id']), n['composition']);
      visit(n['children'], here && !ARRANGING_TYPES.has(type));
    }
  };
  visit(composition['nodes'], true);
  return { plainVideos, timedVideos, refs };
}

/**
 * Ton aus Video-Nodes in einfacher Einbettung als zusätzliche Spur (nicht stumm geschaltete Videos).
 * Videos mit Zeitabbildung (`speed`, `reverse`, `remap` …) mischt die Audio-Engine über die
 * abgetastete Quellzeit, nicht über diese Spur.
 *
 * @example
 * ```ts
 * const track = videoAudioTrack(project, composition, env.assets);
 * ```
 */
export function videoAudioTrack(project: Readonly<Record<string, unknown>>, composition: Readonly<Record<string, unknown>>, assets: AssetResolver): Track | undefined {
  const { plainVideos } = classify(composition);
  if (plainVideos.size === 0) return undefined;
  const timeline = inspectTimeline(project, String(composition['id']));
  const byId = new Map(timeline.nodes.map((n) => [n.id, n]));
  const clips: Record<string, unknown>[] = [];
  const visit = (list: unknown): void => {
    for (const n of records(list)) {
      if (n['type'] === 'video' && typeof n['asset'] === 'string' && plainVideos.has(String(n['id']))) {
        const info = byId.get(String(n['id']));
        const asset = assets.get(n['asset']);
        if (info !== undefined && asset !== undefined && isRecord(asset.metadata['audio'])) {
          clips.push({
            id: `video-${String(n['id'])}`,
            source: n['asset'],
            start: info.start,
            duration: info.end - info.start,
            ...(n['startFrom'] !== undefined ? { offset: n['startFrom'] } : {}),
            ...(n['volume'] !== undefined ? { volume: n['volume'] } : {}),
            ...(typeof n['playbackRate'] === 'number' ? { playbackRate: Math.min(4, Math.max(0.25, n['playbackRate'])) } : {}),
            ...(n['loop'] === true ? { loop: true } : {}),
          });
        }
      }
      visit(n['children']);
    }
  };
  visit(composition['nodes']);
  if (clips.length === 0) return undefined;
  const track = { id: '__video-audio', kind: 'audio', role: 'other', clips };
  return isTrack(track) ? track : undefined;
}

/** Abgetastete Quellzeit einer Node über die Frames der Composition. */
export interface SampledTime {
  /** Node-ID in der ausgewerteten Szene. */
  readonly id: string;
  readonly kind: 'video' | 'composition';
  /** Asset (Video) bzw. Composition-ID (Ref). */
  readonly source: string;
  readonly loop: boolean;
  readonly startFrame: number;
  /** Quellzeit in Sekunden je Frame ab `startFrame`; `NaN` = inaktiv. */
  readonly times: number[];
  /** Linearer Pegel je Frame. */
  readonly gains: number[];
}

/** Composition-ID einer ausgewerteten `composition-ref`-Gruppe (aus den Pointern der Kinder). */
function nestedCompositionOf(node: EvaluatedNode, refs: ReadonlyMap<string, string>): string | undefined {
  const direct = refs.get(node.id);
  if (direct !== undefined) return direct;
  const marker = `${node.pointer}->`;
  for (const child of node.children) {
    if (!child.pointer.startsWith(marker)) continue;
    const rest = child.pointer.slice(marker.length);
    const slash = rest.indexOf('/');
    return slash < 0 ? rest : rest.slice(0, slash);
  }
  return undefined;
}

/**
 * Tastet die Quellzeit aller Video-Nodes mit Zeitabbildung und aller `composition-ref`-Nodes einer
 * Composition je Frame ab (Story 17.7). Videos in einfacher Einbettung (siehe {@link videoAudioTrack})
 * und Inhalte verschachtelter Compositions sind nicht enthalten; letztere tastet der Mix der
 * verschachtelten Composition selbst ab.
 *
 * Video: Quellzeit = `startFrom + lokale Zeit · playbackRate` (vor `loop`), Pegel = `volume`.
 * Ref: Quellzeit = lokale Zeit der Ref in Sekunden (= Zeit der verschachtelten Composition).
 *
 * @example
 * ```ts
 * const sampled = sampleAudioTimes(project, 'main', { registry });
 * ```
 */
export function sampleAudioTimes(project: Readonly<Record<string, unknown>>, compositionId: string, options: { readonly registry?: Registry; readonly endFrame?: number } = {}): SampledTime[] {
  const composition = findComposition(project, compositionId);
  const nodes = classify(composition);
  if (!nodes.timedVideos && nodes.refs.size === 0) return [];
  const fps = Number(composition['fps']);
  const end = Math.ceil(options.endFrame ?? compositionDurationFrames(composition));
  const found = new Map<string, { kind: 'video' | 'composition'; source: string; loop: boolean; samples: Map<number, { u: number; gain: number }> }>();
  const take = (id: string, kind: 'video' | 'composition', source: string, loop: boolean, frame: number, u: number, gain: number): void => {
    let entry = found.get(id);
    if (entry === undefined) {
      entry = { kind, source, loop, samples: new Map() };
      found.set(id, entry);
    }
    entry.samples.set(frame, { u, gain });
  };
  for (let frame = 0; frame < end; frame++) {
    const scene = evaluateScene(project, compositionId, frame, { motionKey: false, ...(options.registry !== undefined ? { registry: options.registry } : {}) });
    const visit = (list: readonly EvaluatedNode[]): void => {
      for (const n of list) {
        const nested = n.type === 'group' ? nestedCompositionOf(n, nodes.refs) : undefined;
        if (nested !== undefined) {
          take(n.id, 'composition', nested, false, frame, n.time.localFrame / fps, 1);
          continue;
        }
        const asset = n.props['asset'];
        if (n.type === 'video' && typeof asset === 'string' && n.props['muted'] !== true && !nodes.plainVideos.has(n.id)) {
          const startFrom = n.props['startFrom'];
          const offset = typeof startFrom === 'number' || typeof startFrom === 'string' ? toFrames(startFrom, { fps }) / fps : 0;
          const rate = typeof n.props['playbackRate'] === 'number' ? n.props['playbackRate'] : 1;
          const volume = typeof n.props['volume'] === 'number' ? n.props['volume'] : 1;
          take(n.id, 'video', asset, n.props['loop'] === true, frame, offset + (n.time.localFrame / fps) * rate, volume);
        }
        visit(n.children);
      }
    };
    visit(scene.nodes);
  }
  const out: SampledTime[] = [];
  for (const [id, entry] of found) {
    const frames = [...entry.samples.keys()];
    const first = Math.min(...frames);
    const last = Math.max(...frames);
    const times: number[] = [];
    const gains: number[] = [];
    for (let f = first; f <= last; f++) {
      const s = entry.samples.get(f);
      times.push(s?.u ?? Number.NaN);
      gains.push(s?.gain ?? 0);
    }
    out.push({ id, kind: entry.kind, source: entry.source, loop: entry.loop, startFrame: first, times, gains });
  }
  return out;
}

interface ResolvedSource {
  readonly path: string;
  readonly duration: number;
  readonly hash: string;
}

/** Ton einer Composition: Spuren und Quellen mit Zeitabbildung, dazu eine Beschreibung für den Cache-Schlüssel. */
interface Contributions {
  readonly tracks: Track[];
  readonly mapped: MappedAudioSource[];
  readonly key: unknown;
}

/**
 * Erzeugt die Audio-Stufe der Pipeline.
 *
 * @example
 * ```ts
 * const audio = createAudioEngine({ assets, cache });
 * await audio.renderComposition({ project, composition, startFrame: 0, endFrame: 300, outPath: 'out/mix.wav' });
 * ```
 */
export function createAudioEngine(options: AudioEngineOptions): AudioEngine {
  return {
    async renderComposition({ project, composition, startFrame, endFrame, outPath }) {
      const voices = options.synthesizeVoices !== undefined ? await options.synthesizeVoices(project) : new Map<string, SynthesizedVoice>();
      const sources = new Map<string, ResolvedSource>();
      for (const s of records(project['audio'])) {
        const id = String(s['id']);
        if (typeof s['asset'] === 'string') {
          const a = options.assets.get(s['asset']);
          if (a !== undefined) sources.set(id, { path: a.path, duration: a.duration ?? 0, hash: a.hash });
        } else {
          const v = voices.get(id);
          if (v !== undefined) sources.set(id, v);
        }
      }
      for (const a of options.assets.all()) if (!sources.has(a.id) && (a.type === 'audio' || a.type === 'video')) sources.set(a.id, { path: a.path, duration: a.duration ?? 0, hash: a.hash });
      const settings = isRecord(composition['audio']) ? composition['audio'] : {};
      const sampleRate = settings['sampleRate'] === 44100 ? 44100 : (options.sampleRate ?? 48000);
      const resolveSource = (id: string): { path: string; duration: number } => {
        const s = sources.get(id);
        if (s === undefined) throw new Error(`Audio source "${id}" is not resolved.`);
        return { path: s.path, duration: s.duration };
      };
      const markersOf = (comp: Readonly<Record<string, unknown>>) =>
        Array.isArray(comp['markers']) ? { markers: records(comp['markers']).map((m) => ({ id: String(m['id']), time: typeof m['time'] === 'number' ? m['time'] : String(m['time']) })) } : {};

      /** Spuren, einfacher Video-Ton und Quellen mit Zeitabbildung einer Composition (rekursiv). */
      const nested = new Map<string, Promise<{ pcm: PcmBuffer; key: unknown } | undefined>>();
      const contributions = async (comp: Readonly<Record<string, unknown>>, depth: number, end: number | undefined): Promise<Contributions> => {
        const tracks: Track[] = records(comp['tracks']).filter(isTrack);
        const fromVideo = videoAudioTrack(project, comp, options.assets);
        if (fromVideo !== undefined) tracks.push(fromVideo);
        const mapped: MappedAudioSource[] = [];
        const mappedKey: unknown[] = [];
        for (const sampled of sampleAudioTimes(project, String(comp['id']), { ...(options.registry !== undefined ? { registry: options.registry } : {}), ...(end !== undefined ? { endFrame: end } : {}) })) {
          const base = { id: sampled.id, loop: sampled.loop, startFrame: sampled.startFrame, times: sampled.times, gains: sampled.gains };
          if (sampled.kind === 'video') {
            const asset = options.assets.get(sampled.source);
            if (asset === undefined || !isRecord(asset.metadata['audio'])) continue;
            mapped.push({ ...base, path: asset.path });
            mappedKey.push({ ...base, source: asset.hash });
          } else {
            const inner = await nestedMix(sampled.source, depth + 1);
            if (inner === undefined) continue;
            mapped.push({ ...base, pcm: inner.pcm });
            mappedKey.push({ ...base, source: inner.key });
          }
        }
        return { tracks, mapped, key: { tracks, mapped: mappedKey } };
      };
      const hasAudio = (c: Contributions): boolean => c.mapped.length > 0 || c.tracks.some((t) => t.kind === 'audio' && t.clips.length > 0);
      const nestedMix = (compositionId: string, depth: number): Promise<{ pcm: PcmBuffer; key: unknown } | undefined> => {
        if (depth > MAX_AUDIO_DEPTH) {
          throw new OpenVideoError({
            code: 'OV_AUDIO_NESTING',
            errorClass: 'AudioError',
            problem: `composition-ref audio is nested deeper than ${String(MAX_AUDIO_DEPTH)} levels (at "${compositionId}").`,
            suggestions: ['Remove the composition-ref that contains itself.', 'Flatten deeply nested compositions.'],
          });
        }
        let pending = nested.get(compositionId);
        if (pending === undefined) {
          pending = (async () => {
            const comp = findComposition(project, compositionId);
            const c = await contributions(comp, depth, undefined);
            if (!hasAudio(c)) return undefined;
            const fps = Number(comp['fps']);
            const pcm = await mixComposition({
              tracks: c.tracks,
              mapped: c.mapped,
              fps,
              durationFrames: compositionDurationFrames(comp),
              sampleRate,
              ...markersOf(comp),
              ...(typeof comp['seed'] === 'number' ? { seed: comp['seed'] } : {}),
              resolveSource,
            });
            return { pcm, key: { composition: compositionId, fps, ...(isRecord(c.key) ? c.key : {}), markers: comp['markers'] ?? [], seed: comp['seed'] ?? null, sources: sourceKeys(c.tracks) } };
          })();
          nested.set(compositionId, pending);
        }
        return pending;
      };
      const sourceKeys = (tracks: readonly Track[]): [string, string][] => {
        const ids = new Set<string>();
        for (const t of tracks) if (t.kind === 'audio') for (const clip of t.clips) ids.add(clip.source);
        return [...ids].sort().map((id) => [id, sources.get(id)?.hash ?? 'unresolved']);
      };

      const top = await contributions(composition, 0, endFrame);
      if (!hasAudio(top)) return undefined;
      const { tracks, mapped } = top;
      const fps = Number(composition['fps']);
      const key = contentHash({
        tracks,
        sources: [...sources].map(([id, s]) => [id, s.hash]),
        fps,
        startFrame,
        endFrame,
        settings,
        markers: composition['markers'] ?? [],
        sampleRate,
        engine: 'openvideo-audio-1',
        // Nur mit Quellen mit Zeitabbildung; ältere Schlüssel bleiben gültig.
        ...(mapped.length > 0 && isRecord(top.key) ? { mapped: top.key['mapped'] } : {}),
      });
      const tier = options.cache.tier('audio');
      const cached = await tier.get(key);
      let wav: Uint8Array;
      let loudness: number | undefined;
      let duration = (endFrame - startFrame) / fps;
      if (cached !== undefined) {
        wav = cached;
      } else {
        const mixed = await mixComposition({
          tracks,
          ...(mapped.length > 0 ? { mapped } : {}),
          fps,
          durationFrames: endFrame,
          sampleRate,
          ...markersOf(composition),
          ...(typeof composition['seed'] === 'number' ? { seed: composition['seed'] } : {}),
          resolveSource,
        });
        const startSample = Math.round((startFrame / fps) * mixed.sampleRate);
        const sliced: PcmBuffer = { ...mixed, channels: mixed.channels.map((c) => c.slice(startSample)) };
        const limiter = isRecord(settings['limiter']) && typeof settings['limiter']['ceiling'] === 'number' ? { ceiling: settings['limiter']['ceiling'] } : { ceiling: -1 };
        const mastered = masterAudio(sliced, { ...(typeof settings['loudness'] === 'number' ? { loudness: settings['loudness'] } : {}), limiter });
        loudness = measureLoudness(mastered);
        duration = (mastered.channels[0]?.length ?? 0) / mastered.sampleRate;
        wav = encodeWav(mastered, { bitDepth: 24 });
        await tier.put(key, wav);
      }
      await writeFile(outPath, wav);
      return { path: outPath, durationSeconds: duration, ...(loudness !== undefined && Number.isFinite(loudness) ? { loudness } : {}) };
    },
  };
}
