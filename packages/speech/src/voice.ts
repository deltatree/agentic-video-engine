/**
 * Voice-Provider (FR-58): Piper, espeak-ng und beliebige Kommandos.
 *
 * Jeder Provider startet ein externes Programm, liest dessen WAV-Ausgabe und
 * normalisiert sie mit FFmpeg auf 16-Bit-PCM, mono, 48 kHz.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { OpenVideoError, contentHash, type VoiceProvider, type VoiceRequest, type VoiceResult } from '@agentic-video/core';
import { DEFAULT_VOICE_TIMEOUT_MS, fileSha256, isReadableFile, locateBinary, missingError, runTool } from './process.js';
import { VOICE_SAMPLE_RATE, normalizeWav, withTempDir } from './wav.js';

/** Installationshinweise für Piper. */
export const PIPER_HINTS: readonly string[] = [
  'Install Piper without root: `uv venv ~/.local/opt/piper-venv && uv pip install --python ~/.local/opt/piper-venv/bin/python piper-tts` (or `pip install --user piper-tts`).',
  'Download a voice (.onnx and .onnx.json) from https://huggingface.co/rhasspy/piper-voices.',
  'Pass { binary, model } to createPiperProvider() or set OPENVIDEO_PIPER to the piper program.',
];

/** Installationshinweise für espeak-ng. */
export const ESPEAK_HINTS: readonly string[] = [
  'Install espeak-ng: `sudo apt install espeak-ng`, `brew install espeak-ng` or `winget install espeak-ng`.',
  'Pass { binary } to createEspeakProvider() or set OPENVIDEO_ESPEAK to the espeak-ng program.',
];

/** Synthese über ein Programm, das eine WAV-Datei nach `rawPath` schreibt; Ergebnis normalisiert. */
async function synthesizeVia(run: (rawPath: string, dir: string) => Promise<void>, timeoutMs: number): Promise<VoiceResult> {
  return withTempDir(async (dir) => {
    const raw = join(dir, 'raw.wav');
    const out = join(dir, 'voice.wav');
    await run(raw, dir);
    if (!isReadableFile(raw)) {
      throw new OpenVideoError({
        code: 'OV_SPEECH_OUTPUT',
        errorClass: 'SpeechError',
        problem: 'The voice program finished without writing a WAV file.',
        suggestions: ['Check that the command writes its audio to the {out} path.', 'Run the program manually with the same text to see its output.'],
      });
    }
    await normalizeWav(raw, out, VOICE_SAMPLE_RATE, timeoutMs);
    return { audio: new Uint8Array(await readFile(out)) };
  });
}

/** Erste Zeile der Versionsausgabe eines Programms, sonst `undefined`. */
async function toolVersion(binary: string, args: readonly string[], provider: string): Promise<string | undefined> {
  try {
    const { stdout, stderr } = await runTool(binary, args, { provider, timeoutMs: 15_000, hints: [] });
    const line = `${stdout}\n${stderr}`.split(/\r?\n/u).find((l) => l.trim() !== '');
    return line?.trim();
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
}

/** Optionen für {@link createPiperProvider}. */
export interface PiperOptions {
  /** Pfad zum Programm `piper`. Standard: `OPENVIDEO_PIPER`, dann `PATH`. */
  readonly binary?: string;
  /** Stimme als `.onnx`-Datei; die Konfiguration `<model>.json` liegt daneben. */
  readonly model: string;
  /** Konfigurationsdatei, falls sie nicht `<model>.json` heißt. */
  readonly config?: string;
  readonly timeoutMs?: number;
}

/**
 * Lokale Sprachsynthese mit Piper (https://github.com/rhasspy/piper).
 * `request.voice` wählt bei Mehrsprecher-Modellen die Sprecher-ID; `rate` > 1 spricht schneller.
 * Die Version enthält Programmversion und Hash von Modell und Konfiguration.
 *
 * @example
 * ```ts
 * const piper = createPiperProvider({ model: '~/.local/opt/piper-voices/en_US-lessac-low.onnx' });
 * const { audio } = await piper.synthesize({ text: 'Hello world' });
 * ```
 */
export function createPiperProvider(options: PiperOptions): VoiceProvider {
  const id = 'piper';
  const timeoutMs = options.timeoutMs ?? DEFAULT_VOICE_TIMEOUT_MS;
  const config = options.config ?? `${options.model}.json`;
  const binary = () => locateBinary(['piper'], { explicit: options.binary, envVar: 'OPENVIDEO_PIPER' });
  const need = (): string => {
    const b = binary();
    if (b === undefined) throw missingError(id, 'The piper program was not found.', PIPER_HINTS);
    if (!isReadableFile(options.model)) throw missingError(id, `Piper voice model "${options.model}" was not found.`, PIPER_HINTS);
    return b;
  };
  let version: Promise<string> | undefined;
  return {
    id,
    available: () => Promise.resolve(binary() !== undefined && isReadableFile(options.model)),
    version() {
      version ??= (async () => {
        const b = need();
        // Das Python-Paket piper-tts kennt kein --version; dann fragt die Python-Umgebung daneben.
        const program =
          (await toolVersion(b, ['--version'], id)) ??
          (await toolVersion(join(dirname(b), 'python'), ['-c', "import importlib.metadata as m; print('piper-tts ' + m.version('piper-tts'))"], id)) ??
          'piper (version unknown)';
        const cfg = isReadableFile(config) ? (await fileSha256(config)).slice(0, 16) : 'none';
        return `${program}; model sha256:${(await fileSha256(options.model)).slice(0, 16)}; config sha256:${cfg}`;
      })();
      return version;
    },
    async synthesize(request: VoiceRequest) {
      const b = need();
      return await synthesizeVia(async (raw) => {
        const args = ['-m', options.model, '-f', raw];
        if (isReadableFile(config)) args.push('-c', config);
        if (request.voice !== undefined && /^\d+$/u.test(request.voice)) args.push('-s', request.voice);
        if (request.rate !== undefined) args.push('--length-scale', String(1 / request.rate));
        await runTool(b, args, { provider: id, timeoutMs, input: request.text.replace(/\s+/gu, ' ').trim(), hints: PIPER_HINTS });
      }, timeoutMs);
    },
  };
}

/** Optionen für {@link createEspeakProvider}. */
export interface EspeakOptions {
  /** Pfad zum Programm `espeak-ng`. Standard: `OPENVIDEO_ESPEAK`, dann `PATH`. */
  readonly binary?: string;
  readonly timeoutMs?: number;
}

/**
 * Lokale Sprachsynthese mit espeak-ng. `request.voice` (oder `language`) wählt die Stimme,
 * z. B. `de` oder `en-us`; `rate` skaliert die Standardgeschwindigkeit von 175 Wörtern/Minute.
 *
 * @example
 * ```ts
 * const espeak = createEspeakProvider();
 * const { audio } = await espeak.synthesize({ text: 'Hallo Welt', voice: 'de' });
 * ```
 */
export function createEspeakProvider(options: EspeakOptions = {}): VoiceProvider {
  const id = 'espeak-ng';
  const timeoutMs = options.timeoutMs ?? DEFAULT_VOICE_TIMEOUT_MS;
  const binary = () => locateBinary(['espeak-ng'], { explicit: options.binary, envVar: 'OPENVIDEO_ESPEAK' });
  const need = (): string => {
    const b = binary();
    if (b === undefined) throw missingError(id, 'The espeak-ng program was not found.', ESPEAK_HINTS);
    return b;
  };
  let version: Promise<string> | undefined;
  return {
    id,
    available: () => Promise.resolve(binary() !== undefined),
    version() {
      version ??= (async () => {
        const line = (await toolVersion(need(), ['--version'], id)) ?? 'espeak-ng (version unknown)';
        // "eSpeak NG text-to-speech: 1.51  Data at: /usr/…" → ohne lokalen Pfad
        return line.replace(/\s+Data at:.*$/u, '');
      })();
      return version;
    },
    async synthesize(request: VoiceRequest) {
      const b = need();
      return await synthesizeVia(async (raw) => {
        const voice = request.voice ?? request.language;
        const args = ['-w', raw, '--stdin'];
        if (voice !== undefined) args.push('-v', voice);
        if (request.rate !== undefined) args.push('-s', String(Math.round(175 * request.rate)));
        await runTool(b, args, { provider: id, timeoutMs, input: request.text, hints: ESPEAK_HINTS });
      }, timeoutMs);
    },
  };
}

/** Optionen für {@link createCommandVoiceProvider}. */
export interface CommandVoiceOptions {
  readonly id: string;
  /**
   * Programm und Argumente. Platzhalter: `{text}` (Text), `{out}` (Pfad der WAV-Ausgabe),
   * `{voice}` (Stimme oder leerer Text).
   */
  readonly command: readonly string[];
  /** Version für den Cache-Schlüssel. Standard: Hash des Kommandos. Erhöhe sie, wenn sich das Programm ändert. */
  readonly version?: string;
  readonly timeoutMs?: number;
  /** Installationshinweise für Fehlermeldungen. */
  readonly hints?: readonly string[];
}

/**
 * Voice-Provider aus einem beliebigen Kommando, das eine WAV-Datei nach `{out}` schreibt.
 *
 * @example
 * ```ts
 * const say = createCommandVoiceProvider({ id: 'my-tts', command: ['my-tts', '--out', '{out}', '--voice', '{voice}', '{text}'] });
 * ```
 */
export function createCommandVoiceProvider(options: CommandVoiceOptions): VoiceProvider {
  const timeoutMs = options.timeoutMs ?? DEFAULT_VOICE_TIMEOUT_MS;
  const hints = options.hints ?? [`Install the program "${options.command[0] ?? ''}" or fix the command of voice provider "${options.id}".`];
  const binary = () => locateBinary([options.command[0] ?? '']);
  return {
    id: options.id,
    available: () => Promise.resolve(options.command.length > 0 && binary() !== undefined),
    version: () => Promise.resolve(options.version ?? `command ${contentHash(options.command)}`),
    synthesize(request: VoiceRequest) {
      const b = binary();
      if (b === undefined) return Promise.reject(missingError(options.id, `The program "${options.command[0] ?? ''}" was not found.`, hints));
      return synthesizeVia(async (raw) => {
        const values: Readonly<Record<string, string>> = { text: request.text, out: raw, voice: request.voice ?? '' };
        const args = options.command.slice(1).map((a) => a.replace(/\{(text|out|voice)\}/gu, (m, key: string) => values[key] ?? m));
        await runTool(b, args, { provider: options.id, timeoutMs, hints });
      }, timeoutMs);
    },
  };
}
