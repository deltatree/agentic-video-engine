// Integrationstests mit echten lokalen Engines. Pfade: Umgebungsvariablen oder die
// Installation ohne root unter ~/.local/opt (siehe Installationshinweise im Paket).
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, createCache } from '@agentic-video/cache';
import { Registry, SubtitleCue, validateValue } from '@agentic-video/core';
import { createEspeakProvider, createPiperProvider, createWhisperCppProvider, registerSpeechProviders, synthesizeVoices, transcribe, wavInfo } from '@agentic-video/speech';

const opt = join(homedir(), '.local', 'opt');
const env = (name: string, fallback: string) => process.env[name] ?? fallback;

const piper = createPiperProvider({ binary: env('OPENVIDEO_PIPER', join(opt, 'piper-venv', 'bin', 'piper')), model: env('OPENVIDEO_PIPER_MODEL', join(opt, 'piper-voices', 'en_US-lessac-low.onnx')) });
const espeak = createEspeakProvider({ binary: env('OPENVIDEO_ESPEAK', join(opt, 'espeak-ng', 'espeak-ng')) });
const whisper = createWhisperCppProvider({
  binary: env('OPENVIDEO_WHISPER', join(opt, 'whisper.cpp', 'build', 'bin', 'whisper-cli')),
  model: env('OPENVIDEO_WHISPER_MODEL', join(opt, 'whisper.cpp', 'models', 'ggml-tiny.en.bin')),
});

const piperOk = await piper.available();
const espeakOk = await espeak.available();
const whisperOk = await whisper.available();

async function voice(provider: 'piper' | 'espeak-ng', text: string) {
  const registry = new Registry();
  await registerSpeechProviders(registry, { voice: [piper, espeak] });
  const project = { schemaVersion: '1.0.0', compositions: [], audio: [{ id: 'vo', voice: { provider, text } }] };
  const [result] = await synthesizeVoices(project, { registry, cache: createCache(new MemoryStore()), outDir: mkdtempSync(join(tmpdir(), 'ov-engine-')) });
  if (result === undefined) throw new Error('no voice result');
  return result;
}

describe('Echte Engines', () => {
  it.skipIf(!piperOk)('Piper erzeugt 48-kHz-WAV (wird übersprungen, wenn Piper oder die Stimme en_US-lessac-low fehlt)', async () => {
    expect(await piper.version()).toMatch(/piper-tts .*model sha256:[0-9a-f]{16}/u);
    const v = await voice('piper', 'Hello world, this is Piper.');
    const info = wavInfo(new Uint8Array(readFileSync(v.path)));
    expect(info.sampleRate).toBe(48_000);
    expect(info.duration).toBeGreaterThan(0.5);
    expect(v.words.map((w) => w.text)).toEqual(['Hello', 'world,', 'this', 'is', 'Piper.']);
  });

  it.skipIf(!espeakOk)('espeak-ng erzeugt 48-kHz-WAV (wird übersprungen, wenn espeak-ng fehlt)', async () => {
    expect(await espeak.version()).toMatch(/^eSpeak NG text-to-speech: \d/u);
    const v = await voice('espeak-ng', 'Hello from espeak.');
    const info = wavInfo(new Uint8Array(readFileSync(v.path)));
    expect(info.sampleRate).toBe(48_000);
    expect(info.duration).toBeGreaterThan(0.5);
  });

  it.skipIf(!whisperOk || (!piperOk && !espeakOk))('whisper.cpp transkribiert mit Wortzeiten (wird übersprungen, wenn whisper.cpp, das Modell ggml-tiny.en.bin oder eine TTS-Engine fehlt)', async () => {
    expect(await whisper.version()).toMatch(/whisper\.cpp version: .*model sha256:[0-9a-f]{16}/u);
    const v = await voice(piperOk ? 'piper' : 'espeak-ng', 'Hello world.');
    const registry = new Registry();
    await registerSpeechProviders(registry, { asr: [whisper] });
    const cues = await transcribe(v.path, { registry, provider: 'whisper-cpp', cache: createCache(new MemoryStore()), language: 'en' });
    expect(cues.length).toBeGreaterThan(0);
    for (const c of cues) expect(validateValue(SubtitleCue, c)).toEqual([]);
    const words = cues.flatMap((c) => c.words ?? []).map((w) => w.text.toLowerCase().replace(/[^a-z]/gu, ''));
    expect(words).toContain('hello');
    expect(words).toContain('world');
  });
});
