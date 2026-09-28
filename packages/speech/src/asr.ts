/**
 * ASR-Provider (FR-57): whisper.cpp und beliebige Kommandos.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OpenVideoError, contentHash, isRecord, type AsrProvider, type Transcript } from '@agentic-video/core';
import { DEFAULT_ASR_TIMEOUT_MS, fileSha256, isReadableFile, locateBinary, missingError, runTool } from './process.js';
import { ASR_SAMPLE_RATE, normalizeWav, withTempDir } from './wav.js';

/** Installationshinweise für whisper.cpp. */
export const WHISPER_HINTS: readonly string[] = [
  'Build whisper.cpp without root: `git clone https://github.com/ggml-org/whisper.cpp ~/.local/opt/whisper.cpp && cd ~/.local/opt/whisper.cpp && cmake -B build && cmake --build build --target whisper-cli` (cmake: `pip install --user cmake`).',
  'Download a model, e.g. `curl -L -o models/ggml-tiny.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin`.',
  'Pass { binary, model } to createWhisperCppProvider() or set OPENVIDEO_WHISPER to the whisper-cli program.',
];

type Cue = Transcript['cues'][number];
type Word = NonNullable<Cue['words']>[number];

function outputError(provider: string, problem: string): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_SPEECH_OUTPUT',
    errorClass: 'SpeechError',
    problem,
    details: { provider },
    suggestions: ['Check that the ASR program writes the expected JSON format.', 'Run the program manually on the same file and inspect its output.'],
  });
}

async function readJson(path: string, provider: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw outputError(provider, `The ASR program did not write ${path} (${error instanceof Error ? error.message : String(error)}).`);
  }
  try {
    const json: unknown = JSON.parse(text);
    return json;
  } catch (error) {
    throw outputError(provider, `The ASR output ${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Liest die JSON-Ausgabe von whisper.cpp (`-ojf`): Segmente werden Cues, Tokens werden
 * zu Wörtern zusammengefasst (ein Token mit führendem Leerzeichen beginnt ein neues Wort,
 * Sondertokens wie `[_BEG_]` entfallen). Zeiten in Sekunden.
 *
 * @example
 * ```ts
 * const transcript = parseWhisperJson(JSON.parse(text));
 * transcript.cues[0].words; // [{ text: 'Hello', start: 0.07, end: 0.37 }, …]
 * ```
 */
export function parseWhisperJson(json: unknown): Transcript {
  if (!isRecord(json) || !Array.isArray(json['transcription'])) throw outputError('whisper-cpp', 'whisper.cpp JSON has no "transcription" array.');
  const result = json['result'];
  const language = isRecord(result) && typeof result['language'] === 'string' ? result['language'] : undefined;
  const cues: Cue[] = [];
  for (const seg of json['transcription']) {
    if (!isRecord(seg) || !isRecord(seg['offsets']) || typeof seg['text'] !== 'string') continue;
    const start = num(seg['offsets']['from']);
    const end = num(seg['offsets']['to']);
    if (start === undefined || end === undefined) continue;
    const words: { text: string; start: number; end: number }[] = [];
    for (const token of Array.isArray(seg['tokens']) ? seg['tokens'] : []) {
      if (!isRecord(token) || typeof token['text'] !== 'string' || !isRecord(token['offsets'])) continue;
      const text = token['text'];
      if (/^\s*\[_.*_?\]\s*$/u.test(text) || text.trim() === '') continue;
      const t0 = num(token['offsets']['from']) ?? start;
      const t1 = num(token['offsets']['to']) ?? t0;
      const last = words[words.length - 1];
      if (last === undefined || /^\s/u.test(text)) words.push({ text: text.trim(), start: t0 / 1000, end: t1 / 1000 });
      else {
        last.text += text.trim();
        last.end = t1 / 1000;
      }
    }
    const text = seg['text'].trim();
    if (text === '') continue;
    cues.push({ start: start / 1000, end: end / 1000, text, ...(words.length > 0 ? { words } : {}) });
  }
  return { ...(language !== undefined ? { language } : {}), cues };
}

/**
 * Prüft und übernimmt ein {@link Transcript} aus JSON (`{ language?, cues: [{ start, end, text, words? }] }`, Sekunden).
 *
 * @example
 * ```ts
 * parseTranscriptJson({ cues: [{ start: 0, end: 1, text: 'Hi' }] });
 * ```
 */
export function parseTranscriptJson(json: unknown, provider = 'command'): Transcript {
  if (!isRecord(json) || !Array.isArray(json['cues'])) throw outputError(provider, 'Transcript JSON has no "cues" array.');
  const cues: Cue[] = json['cues'].map((c: unknown, i: number) => {
    const start = isRecord(c) ? num(c['start']) : undefined;
    const end = isRecord(c) ? num(c['end']) : undefined;
    if (!isRecord(c) || start === undefined || end === undefined || typeof c['text'] !== 'string') {
      throw outputError(provider, `Transcript cue ${i} needs numeric start/end (seconds) and a text.`);
    }
    const words: Word[] = [];
    for (const w of Array.isArray(c['words']) ? c['words'] : []) {
      const ws = isRecord(w) ? num(w['start']) : undefined;
      const we = isRecord(w) ? num(w['end']) : undefined;
      if (isRecord(w) && typeof w['text'] === 'string' && ws !== undefined && we !== undefined) words.push({ text: w['text'], start: ws, end: we });
    }
    return { start, end, text: c['text'], ...(words.length > 0 ? { words } : {}) };
  });
  const language = json['language'];
  return { ...(typeof language === 'string' ? { language } : {}), cues };
}

/** Optionen für {@link createWhisperCppProvider}. */
export interface WhisperCppOptions {
  /** Pfad zu `whisper-cli`. Standard: `OPENVIDEO_WHISPER`, dann `whisper-cli`/`whisper-cpp` in `PATH`. */
  readonly binary?: string;
  /** ggml-Modell, z. B. `ggml-tiny.en.bin`. */
  readonly model: string;
  readonly timeoutMs?: number;
  /** Anzahl Threads (Standard: whisper.cpp-Standard). */
  readonly threads?: number;
}

/**
 * Lokale Spracherkennung mit whisper.cpp und Wortzeiten.
 * Die Eingabe wird vorher mit FFmpeg auf 16 kHz mono gewandelt.
 *
 * @example
 * ```ts
 * const whisper = createWhisperCppProvider({ model: '~/.local/opt/whisper.cpp/models/ggml-tiny.en.bin' });
 * const transcript = await whisper.transcribe('voice.wav', { language: 'en' });
 * ```
 */
export function createWhisperCppProvider(options: WhisperCppOptions): AsrProvider {
  const id = 'whisper-cpp';
  const timeoutMs = options.timeoutMs ?? DEFAULT_ASR_TIMEOUT_MS;
  const binary = () => locateBinary(['whisper-cli', 'whisper-cpp'], { explicit: options.binary, envVar: 'OPENVIDEO_WHISPER' });
  const need = (): string => {
    const b = binary();
    if (b === undefined) throw missingError(id, 'The whisper.cpp program (whisper-cli) was not found.', WHISPER_HINTS);
    if (!isReadableFile(options.model)) throw missingError(id, `whisper.cpp model "${options.model}" was not found.`, WHISPER_HINTS);
    return b;
  };
  let version: Promise<string> | undefined;
  return {
    id,
    available: () => Promise.resolve(binary() !== undefined && isReadableFile(options.model)),
    version() {
      version ??= (async () => {
        const b = need();
        let program = 'whisper.cpp (version unknown)';
        try {
          const { stdout, stderr } = await runTool(b, ['--version'], { provider: id, timeoutMs: 15_000, hints: [] });
          const line = `${stdout}\n${stderr}`.split(/\r?\n/u).find((l) => /version/iu.test(l));
          if (line !== undefined) program = line.trim();
        } catch (error) {
          if (!(error instanceof OpenVideoError)) throw error;
        }
        return `${program}; model sha256:${(await fileSha256(options.model)).slice(0, 16)}`;
      })();
      return version;
    },
    async transcribe(wavPath, request) {
      const b = need();
      return await withTempDir(async (dir) => {
        const input = join(dir, 'input.wav');
        await normalizeWav(wavPath, input, ASR_SAMPLE_RATE, timeoutMs);
        const base = join(dir, 'out');
        const args = ['-m', options.model, '-f', input, '-ojf', '-of', base, '-np'];
        if (request?.language !== undefined) args.push('-l', request.language);
        if (options.threads !== undefined) args.push('-t', String(options.threads));
        await runTool(b, args, { provider: id, timeoutMs, hints: WHISPER_HINTS });
        return parseWhisperJson(await readJson(`${base}.json`, id));
      });
    },
  };
}

/** Optionen für {@link createCommandAsrProvider}. */
export interface CommandAsrOptions {
  readonly id: string;
  /**
   * Programm und Argumente. Platzhalter: `{in}` (WAV-Eingabe, 16 kHz mono),
   * `{out}` (Pfad der JSON-Ausgabe), `{language}` (Sprache oder `auto`).
   */
  readonly command: readonly string[];
  /** Format der Ausgabe: `transcript` ({@link Transcript} als JSON) oder `whisper-json` (whisper.cpp `-ojf`). */
  readonly format?: 'transcript' | 'whisper-json';
  /** Version für den Cache-Schlüssel. Standard: Hash des Kommandos. */
  readonly version?: string;
  readonly timeoutMs?: number;
  readonly hints?: readonly string[];
}

/**
 * ASR-Provider aus einem beliebigen Kommando, das JSON nach `{out}` schreibt.
 *
 * @example
 * ```ts
 * const asr = createCommandAsrProvider({ id: 'my-asr', command: ['my-asr', '{in}', '--json', '{out}'] });
 * ```
 */
export function createCommandAsrProvider(options: CommandAsrOptions): AsrProvider {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ASR_TIMEOUT_MS;
  const hints = options.hints ?? [`Install the program "${options.command[0] ?? ''}" or fix the command of ASR provider "${options.id}".`];
  const binary = () => locateBinary([options.command[0] ?? '']);
  return {
    id: options.id,
    available: () => Promise.resolve(options.command.length > 0 && binary() !== undefined),
    version: () => Promise.resolve(options.version ?? `command ${contentHash(options.command)}`),
    transcribe(wavPath, request) {
      const b = binary();
      if (b === undefined) return Promise.reject(missingError(options.id, `The program "${options.command[0] ?? ''}" was not found.`, hints));
      return withTempDir(async (dir) => {
        const input = join(dir, 'input.wav');
        const out = join(dir, 'out.json');
        await normalizeWav(wavPath, input, ASR_SAMPLE_RATE, timeoutMs);
        const values: Readonly<Record<string, string>> = { in: input, out, language: request?.language ?? 'auto' };
        const args = options.command.slice(1).map((a) => a.replace(/\{(in|out|language)\}/gu, (m, key: string) => values[key] ?? m));
        await runTool(b, args, { provider: options.id, timeoutMs, hints });
        const json = await readJson(out, options.id);
        return options.format === 'whisper-json' ? parseWhisperJson(json) : parseTranscriptJson(json, options.id);
      });
    },
  };
}
