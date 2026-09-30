/**
 * Transkription aus `tracks[].fromAudio` (Story 17.8): gemeinsame Logik für die Operation
 * `subtitles.transcribe` und für den Render, der `fromAudio`-Tracks vor dem ersten Frame auflöst.
 *
 * Der Cache-Schlüssel von {@link transcribe} enthält Provider, Provider-Version, den Hash der
 * Audiodaten und die Sprache: Gleiches Audio wird nie zweimal transkribiert.
 */
import type { Cache } from '@agentic-video/cache';
import { OpenVideoError, isOpenVideoError, isRecord, type AssetRecord, type AssetResolver, type Diagnostic, type Registry, type SubtitleCue } from '@agentic-video/core';
import { WHISPER_HINTS } from './asr.js';
import { transcribe } from './synthesize.js';

function speechError(code: string, problem: string, suggestions: readonly string[]): OpenVideoError {
  return new OpenVideoError({ code, errorClass: 'SpeechError', problem, suggestions });
}

/**
 * Wählt den ASR-Provider: den gewünschten, sonst den einzigen registrierten.
 * Wirft `OV_ASR_UNAVAILABLE` (keiner installiert) oder `OV_ASR_PROVIDER` (unbekannt oder mehrdeutig).
 *
 * @example
 * ```ts
 * const provider = chooseAsrProvider(registry, track.fromAudio?.provider);
 * ```
 */
export function chooseAsrProvider(registry: Registry, wanted: string | undefined): string {
  const providers = [...registry.asrProviders.keys()];
  if (providers.length === 0) {
    throw speechError('OV_ASR_UNAVAILABLE', 'No speech recognition (ASR) engine is installed on this host.', [
      ...WHISPER_HINTS,
      'Then set OPENVIDEO_WHISPER and OPENVIDEO_WHISPER_MODEL and restart the server.',
      'Alternatively write the cues yourself into tracks[].cues, or reference an .srt/.vtt file with tracks[].asset.',
    ]);
  }
  const provider = wanted ?? (providers.length === 1 ? providers[0] : undefined);
  if (provider === undefined || !providers.includes(provider)) {
    throw speechError('OV_ASR_PROVIDER', provider === undefined ? 'Several ASR providers are installed; none was chosen.' : `ASR provider "${provider}" is not installed.`, [`Pass "provider": one of ${providers.join(', ')}.`]);
  }
  return provider;
}

/**
 * Prüft die Audioquelle einer Transkription: ein deklariertes Audio- oder Video-Asset.
 * Wirft `OV_ASSET_UNKNOWN` oder `OV_TRANSCRIBE_SOURCE`.
 *
 * @example
 * ```ts
 * const asset = transcriptionSource(env.assets, 'voiceover');
 * ```
 */
export function transcriptionSource(assets: Pick<AssetResolver, 'get' | 'all'>, source: string): AssetRecord {
  const asset = assets.get(source);
  if (asset === undefined) {
    const known = assets.all().map((a) => a.id);
    throw speechError('OV_ASSET_UNKNOWN', `Asset "${source}" is not declared in the project.`, [`Declared assets: ${known.join(', ') || '(none)'}.`, 'Import the audio with asset.import first.']);
  }
  if (asset.type !== 'audio' && asset.type !== 'video') {
    throw speechError('OV_TRANSCRIBE_SOURCE', `Asset "${source}" is ${asset.type}, not audio or video.`, ['Pass the id of an audio or video asset.']);
  }
  return asset;
}

/** Eingabe für {@link transcribeFromAudio}. */
export interface TranscribeFromAudioInput {
  readonly registry: Registry;
  readonly assets: Pick<AssetResolver, 'get' | 'all'>;
  readonly cache: Cache;
  /** Asset-ID der Quelle. */
  readonly source: string;
  /** Gewünschter Provider; ohne Angabe der einzige registrierte. */
  readonly provider?: string;
  readonly language?: string;
}

/**
 * Transkribiert ein Audio- oder Video-Asset mit einem ASR-Provider (mit Cache).
 *
 * @example
 * ```ts
 * const { cues, provider } = await transcribeFromAudio({ registry, assets, cache, source: 'vo' });
 * ```
 */
export async function transcribeFromAudio(input: TranscribeFromAudioInput): Promise<{ cues: SubtitleCue[]; provider: string }> {
  const provider = chooseAsrProvider(input.registry, input.provider);
  const asset = transcriptionSource(input.assets, input.source);
  const cues = await transcribe(asset.path, { registry: input.registry, provider, cache: input.cache, ...(input.language !== undefined ? { language: input.language } : {}) });
  return { cues, provider };
}

/** Transkript je Track: Cues oder die Diagnose, warum es keins gibt. */
export type FromAudioTranscript = { readonly cues: readonly SubtitleCue[] } | { readonly error: Diagnostic };

/**
 * Löst alle Untertitel-Tracks mit `fromAudio` ohne eigene `cues` und ohne `asset` auf
 * (vor dem Render). Schlüssel ist `"<compositionId>/<trackId>"`. Fehler (kein ASR-Provider,
 * unbekanntes Asset) stehen als Diagnose im Ergebnis und brechen nicht ab; der
 * `subtitles`-Expander meldet sie erst, wenn der Track gerendert wird.
 *
 * @example
 * ```ts
 * const transcripts = await resolveFromAudioTracks(project, { registry, assets, cache });
 * registerSubtitles(registry, { transcript: (c, t) => transcripts.get(`${c}/${t}`) });
 * ```
 */
export async function resolveFromAudioTracks(
  project: Readonly<Record<string, unknown>>,
  ctx: { readonly registry: Registry; readonly assets: Pick<AssetResolver, 'get' | 'all'>; readonly cache: Cache },
): Promise<Map<string, FromAudioTranscript>> {
  const out = new Map<string, FromAudioTranscript>();
  const compositions = Array.isArray(project['compositions']) ? project['compositions'].filter(isRecord) : [];
  for (const comp of compositions) {
    const tracks = Array.isArray(comp['tracks']) ? comp['tracks'].filter(isRecord) : [];
    for (const track of tracks) {
      const from = track['fromAudio'];
      if (track['kind'] !== 'subtitle' || !isRecord(from) || track['cues'] !== undefined || track['asset'] !== undefined) continue;
      const key = `${String(comp['id'])}/${String(track['id'])}`;
      try {
        const { cues } = await transcribeFromAudio({
          ...ctx,
          source: String(from['source']),
          ...(typeof from['provider'] === 'string' ? { provider: from['provider'] } : {}),
          ...(typeof track['language'] === 'string' ? { language: track['language'] } : {}),
        });
        out.set(key, { cues });
      } catch (error: unknown) {
        if (!isOpenVideoError(error)) throw error;
        out.set(key, { error: { ...error.diagnostic, problem: `Track "${String(track['id'])}" (fromAudio "${String(from['source'])}") could not be transcribed: ${error.diagnostic.problem}` } });
      }
    }
  }
  return out;
}
