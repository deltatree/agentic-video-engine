/**
 * Stimmen erzeugen und Audio transkribieren – mit Cache (FR-57, FR-59).
 *
 * Cache-Schlüssel = `contentHash({ provider, providerVersion, request })`. Ein Treffer
 * ruft den Provider nicht auf. Einträge liegen in der Cache-Ebene `audio`.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Cache } from '@agentic-video/cache';
import {
  AudioSource,
  OpenVideoError,
  SubtitleCue,
  conforms,
  contentHash,
  isRecord,
  type AsrProvider,
  type Marker,
  type Registry,
  type Transcript,
  type VoiceProvider,
  type VoiceRequest,
} from '@agentic-video/core';
import { wavInfo } from './wav.js';
import { estimateWords, secondsTime, type TimedWord } from './words.js';

/** Ergebnis der Synthese einer Audio-Quelle. */
export interface VoiceSynthesis {
  /** ID der Audio-Quelle in `project.audio`. */
  readonly id: string;
  readonly provider: string;
  /** Pfad der WAV-Datei (48 kHz, mono, 16 Bit). Der Name enthält den Cache-Schlüssel. */
  readonly path: string;
  /** Dauer in Sekunden. */
  readonly duration: number;
  /** Wortzeiten in Sekunden ab Beginn der Stimme. */
  readonly words: readonly TimedWord[];
  /** `true`, wenn der Provider keine Wortzeiten liefert und sie geschätzt sind. */
  readonly wordsEstimated: boolean;
  readonly cacheKey: string;
  /** `true`, wenn das Ergebnis aus dem Cache kommt (kein Provider-Aufruf). */
  readonly cached: boolean;
  /**
   * Marker-Vorschläge je Wort: `voice-<id>-word-<n>` (n ab 0), Zeit relativ zum Beginn der Stimme.
   * Zur Synchronisation die Startzeit des Audio-Clips addieren.
   */
  readonly markers: readonly Marker[];
}

/** Optionen für {@link synthesizeVoices}. */
export interface SynthesizeOptions {
  readonly registry: Registry;
  readonly cache: Cache;
  /** Zielordner für die WAV-Dateien. */
  readonly outDir: string;
}

interface VoiceMeta {
  readonly duration: number;
  readonly words: TimedWord[];
  readonly estimated: boolean;
}

function providerMissing(kind: string, id: string, registered: Iterable<string>): OpenVideoError {
  const known = [...registered];
  return new OpenVideoError({
    code: 'OV_SPEECH_PROVIDER_MISSING',
    errorClass: 'SpeechError',
    problem: `${kind} provider "${id}" is not registered.`,
    details: { provider: id, registered: known.join(', ') },
    suggestions: [
      'Register the provider with registerSpeechProviders(registry, { voice: [...], asr: [...] }).',
      known.length > 0 ? `Use one of: ${known.join(', ')}.` : 'Run `openvideo doctor` to see which speech engines are installed.',
    ],
  });
}

function hexOf(hash: string): string {
  return hash.replace(/^sha256:/u, '');
}

function words(v: unknown): TimedWord[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: TimedWord[] = [];
  for (const w of v) {
    if (!isRecord(w) || typeof w['text'] !== 'string' || typeof w['start'] !== 'number' || typeof w['end'] !== 'number') return undefined;
    out.push({ text: w['text'], start: w['start'], end: w['end'] });
  }
  return out;
}

/** Liest JSON aus einem Cache-Eintrag; ein beschädigter Eintrag ergibt `undefined` und wird neu erzeugt. */
function parseJson(bytes: Uint8Array | undefined): unknown {
  if (bytes === undefined) return undefined;
  try {
    const json: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return json;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function parseMeta(bytes: Uint8Array | undefined): VoiceMeta | undefined {
  const json = parseJson(bytes);
  if (!isRecord(json) || typeof json['duration'] !== 'number' || typeof json['estimated'] !== 'boolean') return undefined;
  const w = words(json['words']);
  return w === undefined ? undefined : { duration: json['duration'], words: w, estimated: json['estimated'] };
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

async function writeOnce(path: string, bytes: Uint8Array): Promise<void> {
  if (existsSync(path)) return;
  const tmp = `${path}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, path);
}

function voiceRequest(voice: { text: string; voice?: string; language?: string; rate?: number; options?: Record<string, string | number | boolean> }): VoiceRequest {
  return {
    text: voice.text,
    ...(voice.voice !== undefined ? { voice: voice.voice } : {}),
    ...(voice.language !== undefined ? { language: voice.language } : {}),
    ...(voice.rate !== undefined ? { rate: voice.rate } : {}),
    ...(voice.options !== undefined ? { options: voice.options } : {}),
  };
}

/**
 * Erzeugt alle Stimmen eines Projects (`project.audio[]` mit `voice`). Gleiche Anfrage,
 * gleicher Provider und gleiche Provider-Version ergeben einen Cache-Treffer: Der
 * Provider wird dann nicht aufgerufen (FR-59).
 *
 * @example
 * ```ts
 * const voices = await synthesizeVoices(project, { registry, cache, outDir: '.openvideo/voices' });
 * voices[0].path; // '.openvideo/voices/intro-3f2a…wav'
 * ```
 */
export async function synthesizeVoices(project: Readonly<Record<string, unknown>>, options: SynthesizeOptions): Promise<VoiceSynthesis[]> {
  const sources: unknown[] = Array.isArray(project['audio']) ? project['audio'] : [];
  const tier = options.cache.tier('audio');
  const out: VoiceSynthesis[] = [];
  for (const source of sources) {
    if (!conforms(AudioSource, source) || !('voice' in source)) continue;
    const { voice } = source;
    const provider: VoiceProvider | undefined = options.registry.voiceProviders.get(voice.provider);
    if (provider === undefined) throw providerMissing('Voice', voice.provider, options.registry.voiceProviders.keys());
    const request = voiceRequest(voice);
    const cacheKey = contentHash({ provider: provider.id, providerVersion: await provider.version(), request });
    const hex = hexOf(cacheKey);
    const wavKey = `voice-${hex}.wav`;
    const metaKey = `voice-${hex}.json`;

    let audio = await tier.get(wavKey);
    let meta = audio !== undefined ? parseMeta(await tier.get(metaKey)) : undefined;
    const cached = audio !== undefined && meta !== undefined;
    if (audio === undefined || meta === undefined) {
      const result = await provider.synthesize(request);
      audio = result.audio;
      const duration = wavInfo(audio).duration;
      const provided = result.words?.map((w) => ({ text: w.text, start: w.start, end: w.end }));
      meta = { duration, words: provided ?? estimateWords(voice.text, 0, duration), estimated: provided === undefined };
      await tier.put(wavKey, audio);
      await tier.put(metaKey, encode(meta));
    }

    await mkdir(options.outDir, { recursive: true });
    const path = join(options.outDir, `${source.id}-${hex.slice(0, 16)}.wav`);
    await writeOnce(path, audio);
    out.push({
      id: source.id,
      provider: provider.id,
      path,
      duration: meta.duration,
      words: meta.words,
      wordsEstimated: meta.estimated,
      cacheKey,
      cached,
      markers: meta.words.map((w, n) => ({ id: `voice-${source.id}-word-${n}`, time: secondsTime(w.start), label: w.text })),
    });
  }
  return out;
}

/** Optionen für {@link transcribe}. */
export interface TranscribeOptions {
  readonly registry: Registry;
  /** ID des ASR-Providers, z. B. `whisper-cpp`. */
  readonly provider: string;
  readonly cache: Cache;
  readonly language?: string;
}

function toCues(transcript: Transcript): SubtitleCue[] {
  return transcript.cues.map((c) => {
    const w = c.words ?? estimateWords(c.text, c.start, c.end);
    return {
      start: secondsTime(c.start),
      end: secondsTime(c.end),
      text: c.text,
      ...(w.length > 0 ? { words: w.map((x) => ({ text: x.text, start: secondsTime(x.start), end: secondsTime(x.end) })) } : {}),
    };
  });
}

/**
 * Transkribiert eine Audiodatei zu Untertitel-Cues mit Wortzeiten. Der Cache-Schlüssel
 * enthält Provider, Provider-Version, Hash der Audiodaten und Sprache. Fehlen dem Provider
 * Wortzeiten, werden sie proportional zur Zeichenzahl geschätzt.
 *
 * @example
 * ```ts
 * const cues = await transcribe('voice.wav', { registry, provider: 'whisper-cpp', cache });
 * // in composition.tracks: { id: 'subs', kind: 'subtitle', cues }
 * ```
 */
export async function transcribe(audioPath: string, options: TranscribeOptions): Promise<SubtitleCue[]> {
  const provider: AsrProvider | undefined = options.registry.asrProviders.get(options.provider);
  if (provider === undefined) throw providerMissing('ASR', options.provider, options.registry.asrProviders.keys());
  const request = { audio: contentHash(new Uint8Array(await readFile(audioPath))), ...(options.language !== undefined ? { language: options.language } : {}) };
  const cacheKey = contentHash({ provider: provider.id, providerVersion: await provider.version(), request });
  const tier = options.cache.tier('audio');
  const key = `transcript-${hexOf(cacheKey)}.json`;
  const hit = parseCues(await tier.get(key));
  if (hit !== undefined) return hit;
  const cues = toCues(await provider.transcribe(audioPath, options.language !== undefined ? { language: options.language } : undefined));
  await tier.put(key, encode(cues));
  return cues;
}

function parseCues(bytes: Uint8Array | undefined): SubtitleCue[] | undefined {
  const json = parseJson(bytes);
  if (!Array.isArray(json)) return undefined;
  const cues = json.filter((c: unknown): c is SubtitleCue => conforms(SubtitleCue, c));
  return cues.length === json.length ? cues : undefined;
}

/** Erkannte Provider für {@link registerSpeechProviders}. */
export interface DetectedSpeechProviders {
  readonly voice?: readonly VoiceProvider[];
  readonly asr?: readonly AsrProvider[];
}

/**
 * Registriert alle Provider, deren `available()` `true` liefert. Nicht verfügbare
 * Provider werden übersprungen und im Ergebnis genannt.
 *
 * @example
 * ```ts
 * const { registered, skipped } = await registerSpeechProviders(registry, {
 *   voice: [createPiperProvider({ model }), createEspeakProvider()],
 *   asr: [createWhisperCppProvider({ model: whisperModel })],
 * });
 * ```
 */
export async function registerSpeechProviders(registry: Registry, detected: DetectedSpeechProviders): Promise<{ registered: string[]; skipped: string[] }> {
  const registered: string[] = [];
  const skipped: string[] = [];
  for (const p of detected.voice ?? []) {
    if (await p.available()) {
      registry.registerVoiceProvider(p);
      registered.push(p.id);
    } else skipped.push(p.id);
  }
  for (const p of detected.asr ?? []) {
    if (await p.available()) {
      registry.registerAsrProvider(p);
      registered.push(p.id);
    } else skipped.push(p.id);
  }
  return { registered, skipped };
}
