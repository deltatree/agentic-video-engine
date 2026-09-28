/**
 * Audio-Stufe der Pipeline (FR-52..FR-54, FR-59): Tonspuren, Ton aus Video-Nodes und erzeugte
 * Stimmen werden offline gemischt, gemastert und als WAV geschrieben. Ergebnis im Audio-Cache.
 */
import { writeFile } from 'node:fs/promises';
import { masterAudio, measureLoudness, mixComposition, encodeWav, type PcmBuffer } from '@agentic-video/audio';
import type { Cache } from '@agentic-video/cache';
import { contentHash, isRecord, type AssetResolver, type Track } from '@agentic-video/core';
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
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isTrack(value: Record<string, unknown>): value is Record<string, unknown> & Track {
  return value['kind'] === 'audio' && Array.isArray(value['clips']) && typeof value['id'] === 'string';
}

/** Ton aus Video-Nodes als zusätzliche Spur (nicht stumm geschaltete Videos). */
export function videoAudioTrack(project: Readonly<Record<string, unknown>>, composition: Readonly<Record<string, unknown>>, assets: AssetResolver): Track | undefined {
  const timeline = inspectTimeline(project, String(composition['id']));
  const byId = new Map(timeline.nodes.map((n) => [n.id, n]));
  const clips: Record<string, unknown>[] = [];
  const visit = (list: unknown): void => {
    for (const n of records(list)) {
      if (n['type'] === 'video' && n['muted'] !== true && typeof n['asset'] === 'string') {
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
      const tracks: Track[] = records(composition['tracks']).filter(isTrack);
      const fromVideo = videoAudioTrack(project, composition, options.assets);
      if (fromVideo !== undefined) tracks.push(fromVideo);
      if (tracks.every((t) => t.kind !== 'audio' || t.clips.length === 0)) return undefined;
      const voices = options.synthesizeVoices !== undefined ? await options.synthesizeVoices(project) : new Map<string, SynthesizedVoice>();
      const sources = new Map<string, { path: string; duration: number; hash: string }>();
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
      const fps = Number(composition['fps']);
      const settings = isRecord(composition['audio']) ? composition['audio'] : {};
      const sampleRate = settings['sampleRate'] === 44100 ? 44100 : (options.sampleRate ?? 48000);
      const key = contentHash({ tracks, sources: [...sources].map(([id, s]) => [id, s.hash]), fps, startFrame, endFrame, settings, markers: composition['markers'] ?? [], sampleRate, engine: 'openvideo-audio-1' });
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
          fps,
          durationFrames: endFrame,
          sampleRate,
          ...(Array.isArray(composition['markers']) ? { markers: records(composition['markers']).map((m) => ({ id: String(m['id']), time: typeof m['time'] === 'number' ? m['time'] : String(m['time']) })) } : {}),
          ...(typeof composition['seed'] === 'number' ? { seed: composition['seed'] } : {}),
          resolveSource: (id) => {
            const s = sources.get(id);
            if (s === undefined) throw new Error(`Audio source "${id}" is not resolved.`);
            return { path: s.path, duration: s.duration };
          },
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
