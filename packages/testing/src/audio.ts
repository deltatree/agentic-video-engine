/**
 * Audio-Analyse für Tests: reine Funktionen auf `Float32Array` je Kanal (Werte −1..1).
 */
import { OpenVideoError } from '@agentic-video/core';

function audioError(problem: string, suggestion: string): OpenVideoError {
  return new OpenVideoError({ code: 'OV_TEST_AUDIO_INPUT', errorClass: 'AudioAnalysisError', problem, suggestions: [suggestion] });
}

function assertRate(sampleRate: number): void {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw audioError(`Sample rate ${String(sampleRate)} is invalid.`, 'Pass the sample rate in Hz, e.g. 48000.');
}

/**
 * Effektivwert (Root Mean Square) eines Kanals, linear. Leerer Kanal: 0.
 *
 * @example
 * ```ts
 * rms(sine); // Sinus mit Amplitude 1 → ≈ 0.7071
 * ```
 */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

/**
 * Größter Betrag eines Kanals (Sample Peak, linear). Leerer Kanal: 0.
 *
 * @example
 * ```ts
 * peak(new Float32Array([0.2, -0.9, 0.5])); // 0.9 (gerundet auf Float32)
 * ```
 */
export function peak(samples: Float32Array): number {
  let max = 0;
  for (const s of samples) max = Math.max(max, Math.abs(s));
  return max;
}

/** Biquad-Koeffizienten `b0 b1 b2 a1 a2` (a0 = 1). */
type Biquad = readonly [number, number, number, number, number];

/**
 * K-Filter nach ITU-R BS.1770-4 für beliebige Abtastraten. Die Koeffizienten folgen aus den
 * analogen Prototypen (High-Shelf ≈ +4 dB bei 1682 Hz, Hochpass 38 Hz); bei 48 kHz ergeben
 * sie die Tabellenwerte der Norm.
 */
function kFilter(sampleRate: number): readonly [Biquad, Biquad] {
  const f0 = 1681.974450955533;
  const gain = 3.999843853973347;
  const q = 0.7071752369554196;
  const k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = Math.pow(10, gain / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const a0 = 1 + k / q + k * k;
  const shelf: Biquad = [(vh + (vb * k) / q + k * k) / a0, (2 * (k * k - vh)) / a0, (vh - (vb * k) / q + k * k) / a0, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0];
  const f1 = 38.13547087602444;
  const q1 = 0.5003270373238773;
  const k1 = Math.tan((Math.PI * f1) / sampleRate);
  const d = 1 + k1 / q1 + k1 * k1;
  const highPass: Biquad = [1, -2, 1, (2 * (k1 * k1 - 1)) / d, (1 - k1 / q1 + k1 * k1) / d];
  return [shelf, highPass];
}

function filter(samples: ArrayLike<number>, c: Biquad): Float64Array {
  const out = new Float64Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  const [b0, b1, b2, a1, a2] = c;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i] ?? 0;
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    out[i] = y;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
  }
  return out;
}

/** Optionen für {@link integratedLoudness}. */
export interface LoudnessOptions {
  /**
   * Kanalgewichte `G_i`. Standard 1 für jeden Kanal. Für 5.1 (L, R, C, LFE, Ls, Rs) nach
   * BS.1770: `[1, 1, 1, 0, 1.41, 1.41]`.
   */
  readonly weights?: readonly number[];
}

/**
 * Integrierte Lautheit in LUFS nach ITU-R BS.1770-4:
 *
 * 1. K-Filter je Kanal.
 * 2. Blöcke von 400 ms mit 75 % Überlappung; Blocklautheit `l = −0.691 + 10·log10(Σ G_i·z_i)`.
 * 3. Absolutes Gate −70 LUFS, danach relatives Gate 10 LU unter der Lautheit der verbleibenden Blöcke.
 * 4. Ergebnis aus den Mittelwerten `z_i` der Blöcke, die beide Gates passieren.
 *
 * Zu kurze oder stille Signale ergeben `-Infinity`.
 *
 * @example
 * ```ts
 * integratedLoudness([left, right], 48000); // 1-kHz-Sinus mit −20 dBFS stereo → ≈ −20
 * ```
 */
export function integratedLoudness(channels: readonly Float32Array[], sampleRate: number, options: LoudnessOptions = {}): number {
  assertRate(sampleRate);
  const first = channels[0];
  if (first === undefined) throw audioError('No channels given.', 'Pass one Float32Array per channel.');
  if (channels.some((c) => c.length !== first.length)) throw audioError('Channels have different lengths.', 'Pass channels with the same number of samples.');
  const weights = options.weights ?? channels.map(() => 1);
  if (weights.length !== channels.length) throw audioError(`Got ${String(weights.length)} weights for ${String(channels.length)} channels.`, 'Pass one weight per channel.');
  const blockLen = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  const n = first.length;
  if (n < blockLen) return -Infinity;
  const blockCount = Math.floor((n - blockLen) / hop) + 1;
  const [shelf, highPass] = kFilter(sampleRate);
  // z[c][j]: mittleres Quadrat von Kanal c in Block j (über Präfixsummen).
  const z = channels.map((ch) => {
    const y = filter(filter(ch, shelf), highPass);
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = (prefix[i] ?? 0) + (y[i] ?? 0) * (y[i] ?? 0);
    const blocks = new Float64Array(blockCount);
    for (let j = 0; j < blockCount; j++) blocks[j] = ((prefix[j * hop + blockLen] ?? 0) - (prefix[j * hop] ?? 0)) / blockLen;
    return blocks;
  });
  const blockPower = (j: number): number => z.reduce((sum, blocks, c) => sum + (weights[c] ?? 1) * (blocks[j] ?? 0), 0);
  const loudness = (power: number): number => -0.691 + 10 * Math.log10(power);
  const gatedLoudness = (keep: readonly number[]): number => {
    if (keep.length === 0) return -Infinity;
    let sum = 0;
    z.forEach((blocks, c) => {
      let mean = 0;
      for (const j of keep) mean += blocks[j] ?? 0;
      sum += (weights[c] ?? 1) * (mean / keep.length);
    });
    return loudness(sum);
  };
  const all = Array.from({ length: blockCount }, (_, j) => j);
  const absolute = all.filter((j) => loudness(blockPower(j)) > -70);
  const relativeGate = gatedLoudness(absolute) - 10;
  return gatedLoudness(absolute.filter((j) => loudness(blockPower(j)) > relativeGate));
}

/** Optionen für {@link findOnsets}. */
export interface OnsetOptions {
  /** Zeit in Sekunden, die das Signal unter der Schwelle bleiben muss, bevor ein neuer Einsatz zählt. Standard 0.05. */
  readonly holdOff?: number;
}

/**
 * Findet Einsätze (Onsets): Zeitpunkte in Sekunden, an denen `|x| ≥ threshold` (linear) wird,
 * nachdem das Signal mindestens `holdOff` Sekunden unter der Schwelle lag.
 * Für Sync-Tests, z. B. Klick-Spuren gegen Bild-Frames.
 *
 * @example
 * ```ts
 * findOnsets(clickTrack, 48000, 0.5); // [0.5, 1.25]
 * ```
 */
export function findOnsets(samples: Float32Array, sampleRate: number, threshold: number, options: OnsetOptions = {}): number[] {
  assertRate(sampleRate);
  if (!(threshold > 0)) throw audioError(`Threshold ${String(threshold)} must be greater than 0.`, 'Use a linear amplitude, e.g. 0.1 (−20 dBFS).');
  const hold = Math.max(1, Math.round((options.holdOff ?? 0.05) * sampleRate));
  const out: number[] = [];
  let quiet = hold;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i] ?? 0) >= threshold) {
      if (quiet >= hold) out.push(i / sampleRate);
      quiet = 0;
    } else {
      quiet++;
    }
  }
  return out;
}
