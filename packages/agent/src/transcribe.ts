/**
 * Operation `subtitles.transcribe` (Story 19.5): erzeugt Untertitel-Cues mit Wortzeiten aus
 * einem Audio- oder Video-Asset über einen ASR-Provider der Registry (z. B. whisper.cpp)
 * und speichert sie im Untertitel-Track. `tracks[].fromAudio` gibt Quelle und Provider vor.
 */
import Type from 'typebox';
import { OpenVideoError, applyPatches, findComposition, isRecord } from '@agentic-video/core';
import { WHISPER_HINTS, transcribe } from '@agentic-video/speech';
import { defineOperation } from './operation.js';
import { CompositionId, Diagnostics, ProjectId, loadProject, plainDiagnostics, tsxProjectError, withEnv } from './shared.js';
import { isSourceEntry } from './workspace.js';

function transcribeError(code: string, problem: string, suggestions: readonly string[]): OpenVideoError {
  return new OpenVideoError({ code, errorClass: 'SpeechError', problem, suggestions });
}

/**
 * `subtitles.transcribe`: Transkription eines Assets in einen Untertitel-Track.
 *
 * @example
 * ```ts
 * await invokeOperation(OPERATIONS, 'subtitles.transcribe', { projectId: 'demo', trackId: 'subs', source: 'voice' }, ctx);
 * ```
 */
export const subtitlesTranscribe = defineOperation({
  name: 'subtitles.transcribe',
  summary: 'Transcribe an audio/video asset with an ASR provider (e.g. whisper.cpp) into a subtitle track with word timings.',
  input: Type.Object(
    {
      projectId: ProjectId,
      compositionId: CompositionId,
      trackId: Type.String({ minLength: 1, description: 'Subtitle track to fill; created when missing. Its fromAudio gives default source and provider.' }),
      source: Type.Optional(Type.String({ description: 'Asset id of the audio or video; default tracks[].fromAudio.source.' })),
      provider: Type.Optional(Type.String({ description: 'ASR provider id, e.g. "whisper-cpp"; default fromAudio.provider or the only registered provider.' })),
      language: Type.Optional(Type.String({ description: 'Language code, e.g. "en".' })),
      dryRun: Type.Optional(Type.Boolean({ description: 'Return the cues without saving them.' })),
    },
    { additionalProperties: false },
  ),
  output: Type.Object({ ok: Type.Boolean(), trackId: Type.String(), provider: Type.String(), cues: Type.Array(Type.Record(Type.String(), Type.Unknown())), saved: Type.Boolean(), diagnostics: Diagnostics }),
  example: { input: { projectId: 'launch-video', trackId: 'subs', source: 'voiceover', provider: 'whisper-cpp', language: 'en' } },
  async handler(input, ctx) {
    const loaded = await loadProject(ctx, input.projectId);
    if (input.dryRun !== true && isSourceEntry(loaded.entry)) throw tsxProjectError();
    const comp = findComposition(loaded.project, input.compositionId);
    const compositionId = String(comp['id']);
    const tracks: unknown[] = Array.isArray(comp['tracks']) ? Array.from<unknown>(comp['tracks']) : [];
    const track = tracks.filter(isRecord).find((t) => t['id'] === input.trackId);
    if (track !== undefined && track['kind'] !== 'subtitle') {
      throw transcribeError('OV_TRACK_KIND', `Track "${input.trackId}" is a ${String(track['kind'])} track, not a subtitle track.`, ['Pass the id of a subtitle track, or a new id to create one.']);
    }
    const fromAudio = track !== undefined && isRecord(track['fromAudio']) ? track['fromAudio'] : undefined;
    const source = input.source ?? (typeof fromAudio?.['source'] === 'string' ? fromAudio['source'] : undefined);
    if (source === undefined) {
      throw transcribeError('OV_TRANSCRIBE_SOURCE', 'No audio source is given.', ['Pass "source": the id of an audio or video asset.', `Or set tracks[].fromAudio: { "source": "<asset id>", "provider": "whisper-cpp" } on track "${input.trackId}".`]);
    }
    return withEnv(ctx, loaded, async (env) => {
      const providers = [...env.registry.asrProviders.keys()];
      const wanted = input.provider ?? (typeof fromAudio?.['provider'] === 'string' ? fromAudio['provider'] : undefined);
      const provider = wanted ?? (providers.length === 1 ? providers[0] : undefined);
      if (providers.length === 0) {
        throw transcribeError('OV_ASR_UNAVAILABLE', 'No speech recognition (ASR) engine is installed on this host.', [
          ...WHISPER_HINTS,
          'Then set OPENVIDEO_WHISPER and OPENVIDEO_WHISPER_MODEL and restart the server.',
          'Alternatively write the cues yourself into tracks[].cues, or reference an .srt/.vtt file with tracks[].asset.',
        ]);
      }
      if (provider === undefined || !providers.includes(provider)) {
        throw transcribeError('OV_ASR_PROVIDER', provider === undefined ? 'Several ASR providers are installed; none was chosen.' : `ASR provider "${provider}" is not installed.`, [`Pass "provider": one of ${providers.join(', ')}.`]);
      }
      const asset = env.assets.get(source);
      if (asset === undefined) {
        const known = env.assets.all().map((a) => a.id);
        throw transcribeError('OV_ASSET_UNKNOWN', `Asset "${source}" is not declared in the project.`, [`Declared assets: ${known.join(', ') || '(none)'}.`, 'Import the audio with asset.import first.']);
      }
      if (asset.type !== 'audio' && asset.type !== 'video') {
        throw transcribeError('OV_TRANSCRIBE_SOURCE', `Asset "${source}" is ${asset.type}, not audio or video.`, ['Pass the id of an audio or video asset.']);
      }
      const cues = await transcribe(asset.path, { registry: env.registry, provider, cache: env.cache, ...(input.language !== undefined ? { language: input.language } : {}) });
      const plainCues = cues.map((c) => ({ ...c }));
      const saved = input.dryRun !== true;
      if (!saved) return { ok: true, trackId: input.trackId, provider, cues: plainCues, saved: false, diagnostics: [] };
      const nextTrack = { ...(track ?? { id: input.trackId, kind: 'subtitle' }), cues: plainCues, ...(input.language !== undefined ? { language: input.language } : {}) };
      const nextTracks = track !== undefined ? tracks.map((t) => (isRecord(t) && t['id'] === input.trackId ? nextTrack : t)) : [...tracks, nextTrack];
      const result = applyPatches(loaded.project, [{ op: 'setCompositionProperty', compositionId, property: 'tracks', value: nextTracks }]);
      if (!result.ok) return { ok: false, trackId: input.trackId, provider, cues: plainCues, saved: false, diagnostics: plainDiagnostics(result.diagnostics) };
      await ctx.services.workspace.save(input.projectId, result.project);
      return { ok: true, trackId: input.trackId, provider, cues: plainCues, saved: true, diagnostics: [] };
    });
  },
});
