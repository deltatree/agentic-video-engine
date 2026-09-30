import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { Marker, OpenVideoError, Registry, SubtitleCue, validateValue, type AsrProvider, type VoiceProvider } from '@agentic-video/core';
import { locateFfmpeg } from '@agentic-video/ffmpeg';
import {
  createCommandAsrProvider,
  createCommandVoiceProvider,
  createEspeakProvider,
  createPiperProvider,
  createWhisperCppProvider,
  estimateWords,
  locateBinary,
  normalizeWav,
  normalizeWavArgs,
  parseTranscriptJson,
  parseWhisperJson,
  registerSpeechProviders,
  runTool,
  secondsTime,
  SPEECH_INPUT_FORMATS,
  synthesizeVoices,
  toolEnv,
  transcribe,
  wavInfo,
} from '@agentic-video/speech';

const fixture = (name: string) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
const node = process.execPath;

function hasFfmpeg(): boolean {
  try {
    locateFfmpeg();
    return true;
  } catch (error) {
    if (error instanceof OpenVideoError) return false;
    throw error;
  }
}
const ffmpegOk = hasFfmpeg();

function counterFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'ov-speech-test-')), 'calls.txt');
  writeFileSync(path, '');
  return path;
}
const calls = (path: string) => readFileSync(path, 'utf8').split('\n').filter((l) => l !== '').length;

function sineProvider(counter: string, version = '1'): VoiceProvider {
  return createCommandVoiceProvider({ id: 'sine', command: [node, fixture('sine-voice.mjs'), '{out}', '{text}', counter], version });
}

function voiceProject(text = 'Hello from the sine voice') {
  return {
    schemaVersion: '1.0.0',
    compositions: [{ id: 'main', width: 640, height: 360, fps: 30, duration: '5s', nodes: [] }],
    audio: [{ id: 'intro', voice: { provider: 'sine', text } }, { id: 'music', asset: 'song' }],
  };
}

describe('Hilfsfunktionen', () => {
  it('secondsTime und estimateWords', () => {
    expect(secondsTime(1.25)).toBe('1.25s');
    expect(estimateWords('ab  cdef', 1, 2)).toEqual([
      { text: 'ab', start: 1, end: 1 + 1 / 3 },
      { text: 'cdef', start: 1 + 1 / 3, end: 2 },
    ]);
    expect(estimateWords('   ', 0, 1)).toEqual([]);
  });

  it('wavInfo liest den Kopf und lehnt Nicht-WAV ab', () => {
    const header = Buffer.alloc(44 + 800);
    header.write('RIFF', 0);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(8000, 24);
    header.writeUInt32LE(16000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(800, 40);
    expect(wavInfo(new Uint8Array(header))).toEqual({ sampleRate: 8000, channels: 1, bitsPerSample: 16, duration: 0.05 });
    expect(() => wavInfo(new TextEncoder().encode('not a wav file'))).toThrow(/RIFF\/WAVE/u);
  });

  it('locateBinary findet Programme im PATH und über Pfade', () => {
    expect(locateBinary(['node'], { explicit: node })).toBe(node);
    expect(locateBinary(['definitely-not-installed-ov'])).toBeUndefined();
    expect(locateBinary(['node'], { explicit: '/nope/node' })).toBeUndefined();
  });

  it('runTool meldet Fehler mit stderr-Auszug und Timeouts', async () => {
    const failed = await runTool(node, ['-e', 'process.stderr.write("boom happened"); process.exit(4)'], { provider: 'x', timeoutMs: 10_000, hints: ['install x'] }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(OpenVideoError);
    const d = (failed as OpenVideoError).diagnostic;
    expect(d.code).toBe('OV_SPEECH_FAILED');
    expect(d.problem).toContain('exit code 4');
    expect(d.details?.['stderr']).toBe('boom happened');
    expect(d.suggestions).toContain('install x');
    const slow = await runTool(node, ['-e', 'setTimeout(() => {}, 5000)'], { provider: 'x', timeoutMs: 100, hints: [] }).catch((e: unknown) => e);
    expect((slow as OpenVideoError).diagnostic.code).toBe('OV_SPEECH_TIMEOUT');
    const missing = await runTool('/nope/tool', [], { provider: 'x', timeoutMs: 1000, hints: [] }).catch((e: unknown) => e);
    expect((missing as OpenVideoError).diagnostic.code).toBe('OV_SPEECH_MISSING');
  });

  it('runTool startet Programme mit minimaler Umgebung ohne Geheimnisse (Story 16.5, N1)', async () => {
    process.env['OPENVIDEO_TEST_SECRET'] = 'must-not-leak';
    process.env['ESPEAK_DATA_PATH'] = '/opt/espeak-data';
    try {
      const { stdout } = await runTool(node, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { provider: 'x', timeoutMs: 10_000, hints: [] });
      const seen: unknown = JSON.parse(stdout);
      expect(seen).toMatchObject({ PATH: process.env['PATH'], ESPEAK_DATA_PATH: '/opt/espeak-data' });
      expect(Object.keys(seen as Record<string, unknown>)).not.toContain('OPENVIDEO_TEST_SECRET');
    } finally {
      delete process.env['OPENVIDEO_TEST_SECRET'];
      delete process.env['ESPEAK_DATA_PATH'];
    }
    expect(toolEnv({ PATH: '/bin', AWS_SECRET_ACCESS_KEY: 'k', OPENVIDEO_S3_SECRET_ACCESS_KEY: 'k', OMP_NUM_THREADS: '2' })).toEqual({ PATH: '/bin', OMP_NUM_THREADS: '2' });
  });

  it('normalizeWav liest nur lokale Dateien in erlaubten Formaten (Story 16.5, M3)', async () => {
    const args = normalizeWavArgs('in.wav', 'out.wav', 48000);
    expect(args.slice(args.indexOf('-protocol_whitelist'), args.indexOf('-i'))).toEqual(['-protocol_whitelist', 'file,pipe', '-format_whitelist', SPEECH_INPUT_FORMATS.join(',')]);
    expect(SPEECH_INPUT_FORMATS).not.toContain('concat');
  });

  it.skipIf(!ffmpegOk)('normalizeWav lehnt eine concat-Liste ab (braucht FFmpeg)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ov-speech-wl-'));
    execFileSync(locateFfmpeg().ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', join(dir, 'real.wav')]);
    writeFileSync(join(dir, 'list.wav'), "ffconcat version 1.0\nfile 'real.wav'\n");
    await expect(normalizeWav(join(dir, 'list.wav'), join(dir, 'out.wav'), 16000)).rejects.toBeInstanceOf(OpenVideoError);
    await normalizeWav(join(dir, 'real.wav'), join(dir, 'ok.wav'), 16000);
    expect(existsSync(join(dir, 'ok.wav'))).toBe(true);
  });
});

describe('JSON-Ausgaben', () => {
  it('parseWhisperJson fasst Tokens zu Wörtern zusammen', () => {
    const t = parseWhisperJson(JSON.parse(readFileSync(fixture('whisper-sample.json'), 'utf8')));
    expect(t.language).toBe('en');
    expect(t.cues).toEqual([
      {
        start: 0,
        end: 1,
        text: 'Hello world.',
        words: [
          { text: 'Hello', start: 0.07, end: 0.37 },
          { text: 'world.', start: 0.37, end: 0.81 },
        ],
      },
    ]);
    expect(() => parseWhisperJson({})).toThrow(/transcription/u);
  });

  it('parseTranscriptJson prüft die Struktur', () => {
    expect(parseTranscriptJson({ cues: [{ start: 0, end: 1, text: 'a', words: [{ text: 'a', start: 0, end: 1 }] }] }).cues[0]?.words).toHaveLength(1);
    expect(() => parseTranscriptJson({ cues: [{ start: '0', end: 1, text: 'a' }] })).toThrow(/numeric start\/end/u);
  });
});

describe.skipIf(!ffmpegOk)('synthesizeVoices mit Cache (wird übersprungen, wenn FFmpeg fehlt)', () => {
  it('ruft den Provider beim zweiten Aufruf nicht auf (FR-59)', async () => {
    const counter = counterFile();
    const registry = new Registry();
    registry.registerVoiceProvider(sineProvider(counter));
    const cache = createCache(new MemoryStore());
    const outDir = mkdtempSync(join(tmpdir(), 'ov-voices-'));

    const [first] = await synthesizeVoices(voiceProject(), { registry, cache, outDir });
    expect(calls(counter)).toBe(1);
    expect(first?.cached).toBe(false);
    const [second] = await synthesizeVoices(voiceProject(), { registry, cache, outDir });
    expect(calls(counter)).toBe(1);
    expect(second?.cached).toBe(true);
    expect(second?.cacheKey).toBe(first?.cacheKey);
    expect(second?.path).toBe(first?.path);

    const bytes = new Uint8Array(readFileSync(first?.path ?? ''));
    const info = wavInfo(bytes);
    expect(info.sampleRate).toBe(48_000);
    expect(info.channels).toBe(1);
    expect(info.duration).toBeCloseTo(1, 2);
    expect(first?.duration).toBeCloseTo(1, 2);
  });

  it('liefert geschätzte Wortzeiten und gültige Marker-Vorschläge', async () => {
    const registry = new Registry();
    registry.registerVoiceProvider(sineProvider(counterFile()));
    const [v] = await synthesizeVoices(voiceProject('Hello big world'), { registry, cache: createCache(new MemoryStore()), outDir: mkdtempSync(join(tmpdir(), 'ov-voices-')) });
    expect(v?.wordsEstimated).toBe(true);
    expect(v?.words.map((w) => w.text)).toEqual(['Hello', 'big', 'world']);
    expect(v?.words[2]?.end).toBeCloseTo(v?.duration ?? 0, 6);
    expect(v?.markers.map((m) => m.id)).toEqual(['voice-intro-word-0', 'voice-intro-word-1', 'voice-intro-word-2']);
    for (const m of v?.markers ?? []) expect(validateValue(Marker, m)).toEqual([]);
  });

  it('erzeugt neu, wenn sich Text oder Provider-Version ändern', async () => {
    const counter = counterFile();
    const cache = createCache(new MemoryStore());
    const outDir = mkdtempSync(join(tmpdir(), 'ov-voices-'));
    const r1 = new Registry();
    r1.registerVoiceProvider(sineProvider(counter, '1'));
    await synthesizeVoices(voiceProject('one'), { registry: r1, cache, outDir });
    await synthesizeVoices(voiceProject('two'), { registry: r1, cache, outDir });
    expect(calls(counter)).toBe(2);
    const r2 = new Registry();
    r2.registerVoiceProvider(sineProvider(counter, '2'));
    await synthesizeVoices(voiceProject('one'), { registry: r2, cache, outDir });
    expect(calls(counter)).toBe(3);
  });

  it('meldet fehlende Provider und Programmfehler strukturiert', async () => {
    const cache = createCache(new MemoryStore());
    const outDir = mkdtempSync(join(tmpdir(), 'ov-voices-'));
    const empty = await synthesizeVoices(voiceProject(), { registry: new Registry(), cache, outDir }).catch((e: unknown) => e);
    expect((empty as OpenVideoError).diagnostic.code).toBe('OV_SPEECH_PROVIDER_MISSING');
    const registry = new Registry();
    registry.registerVoiceProvider(sineProvider(counterFile()));
    const failed = await synthesizeVoices(voiceProject('please FAIL now'), { registry, cache, outDir }).catch((e: unknown) => e);
    expect((failed as OpenVideoError).diagnostic).toMatchObject({ code: 'OV_SPEECH_FAILED', details: { stderr: 'synthetic failure requested' } });
    const silent = createCommandVoiceProvider({ id: 'silent', command: [node, '-e', ''] });
    await expect(silent.synthesize({ text: 'x' })).rejects.toThrow(/without writing a WAV file/u);
  });
});

describe.skipIf(!ffmpegOk)('transcribe mit Cache (wird übersprungen, wenn FFmpeg fehlt)', () => {
  it('liefert Cues mit Wortzeiten und nutzt den Cache', async () => {
    const counter = counterFile();
    const registry = new Registry();
    const asr: AsrProvider = createCommandAsrProvider({ id: 'fake-asr', command: [node, fixture('fake-asr.mjs'), '{in}', '{out}', counter, '{language}'], version: '1' });
    registry.registerAsrProvider(asr);
    registry.registerVoiceProvider(sineProvider(counterFile()));
    const cache = createCache(new MemoryStore());
    const [voice] = await synthesizeVoices(voiceProject(), { registry, cache, outDir: mkdtempSync(join(tmpdir(), 'ov-voices-')) });
    const audio = voice?.path ?? '';

    const cues = await transcribe(audio, { registry, provider: 'fake-asr', cache, language: 'en' });
    expect(cues).toEqual([
      { start: '0s', end: '1.2s', text: 'Hello there', words: [{ text: 'Hello', start: '0s', end: '0.5s' }, { text: 'there', start: '0.5s', end: '1.2s' }] },
      { start: '1.5s', end: '2.5s', text: 'no word times', words: [{ text: 'no', start: '1.5s', end: '1.682s' }, { text: 'word', start: '1.682s', end: '2.045s' }, { text: 'times', start: '2.045s', end: '2.5s' }] },
    ]);
    for (const c of cues) expect(validateValue(SubtitleCue, c)).toEqual([]);
    await transcribe(audio, { registry, provider: 'fake-asr', cache, language: 'en' });
    expect(calls(counter)).toBe(1);
    await transcribe(audio, { registry, provider: 'fake-asr', cache, language: 'de' });
    expect(calls(counter)).toBe(2);
    await expect(transcribe(audio, { registry, provider: 'nope', cache })).rejects.toThrow(/ASR provider "nope" is not registered/u);
  });
});

describe('registerSpeechProviders', () => {
  it('registriert nur verfügbare Provider', async () => {
    const registry = new Registry();
    const result = await registerSpeechProviders(registry, {
      voice: [sineProvider(counterFile()), createEspeakProvider({ binary: '/nope/espeak-ng' }), createPiperProvider({ binary: '/nope/piper', model: '/nope/model.onnx' })],
      asr: [createWhisperCppProvider({ binary: '/nope/whisper-cli', model: '/nope/model.bin' })],
    });
    expect(result).toEqual({ registered: ['sine'], skipped: ['espeak-ng', 'piper', 'whisper-cpp'] });
    expect([...registry.voiceProviders.keys()]).toEqual(['sine']);
    expect(registry.asrProviders.size).toBe(0);
  });

  it('fehlende Engines melden Installationshinweise', async () => {
    const piper = createPiperProvider({ binary: '/nope/piper', model: '/nope/model.onnx' });
    const error = await piper.synthesize({ text: 'x' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpenVideoError);
    expect((error as OpenVideoError).diagnostic.code).toBe('OV_SPEECH_MISSING');
    expect((error as OpenVideoError).diagnostic.suggestions.join(' ')).toContain('piper-tts');
    expect(existsSync('/nope')).toBe(false);
  });
});
