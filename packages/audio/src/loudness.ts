/**
 * Lautheit nach ITU-R BS.1770-4 und Mastering (FR-54).
 */
import type { PcmBuffer } from './decode.js';
import { applyBiquad, applyLimiter, dbToGain, type Biquad, type LimiterSpec } from './dsp.js';

/** K-Filter (Shelf + Hochpass) für beliebige Abtastraten (Herleitung wie libebur128). */
function kWeighting(sampleRate: number): [Biquad, Biquad] {
  let f0 = 1681.974450955533;
  const g = 3.999843853973347;
  let q = 0.7071752369554196;
  let k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = Math.pow(10, g / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  let a0 = 1 + k / q + k * k;
  const shelf: Biquad = {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
  f0 = 38.13547087602444;
  q = 0.5003270373238773;
  k = Math.tan((Math.PI * f0) / sampleRate);
  a0 = 1 + k / q + k * k;
  const highpass: Biquad = { b0: 1, b1: -2, b2: 1, a1: (2 * (k * k - 1)) / a0, a2: (1 - k / q + k * k) / a0 };
  return [shelf, highpass];
}

/** Kanalgewichte: 1.0, bei 5.1 (6 Kanäle, L R C LFE Ls Rs) LFE 0 und Surround 1.41. */
function channelWeight(index: number, count: number): number {
  if (count !== 6) return 1;
  return index === 3 ? 0 : index >= 4 ? 1.41 : 1;
}

/**
 * Misst die integrierte Lautheit in LUFS (ITU-R BS.1770-4: K-Filter, 400-ms-Blöcke mit 75 % Überlappung,
 * absolutes Gate −70 LUFS, relatives Gate −10 LU). Stille oder Signale unter 400 ms → `-Infinity`.
 *
 * @example
 * ```ts
 * measureLoudness(buffer); // z. B. -23.0
 * ```
 */
export function measureLoudness(buffer: PcmBuffer): number {
  const sr = buffer.sampleRate;
  const n = buffer.channels[0]?.length ?? 0;
  const hop = Math.round(0.1 * sr);
  const blockHops = 4;
  const hops = Math.floor(n / hop);
  if (hops < blockHops) return Number.NEGATIVE_INFINITY;
  const [shelf, highpass] = kWeighting(sr);
  const count = buffer.channels.length;
  // Summe der Quadrate je 100-ms-Abschnitt und Kanal.
  const hopSums = buffer.channels.map((ch) => {
    const f = Float64Array.from(ch);
    applyBiquad(f, shelf);
    applyBiquad(f, highpass);
    const sums = new Float64Array(hops);
    for (let h = 0; h < hops; h++) {
      let s = 0;
      for (let i = h * hop; i < (h + 1) * hop; i++) {
        const v = f[i] ?? 0;
        s += v * v;
      }
      sums[h] = s;
    }
    return sums;
  });
  const blocks = hops - blockHops + 1;
  const blockLen = hop * blockHops;
  const z: Float64Array[] = hopSums.map((sums) => {
    const out = new Float64Array(blocks);
    for (let b = 0; b < blocks; b++) {
      let s = 0;
      for (let h = b; h < b + blockHops; h++) s += sums[h] ?? 0;
      out[b] = s / blockLen;
    }
    return out;
  });
  const blockLoudness = (b: number) => {
    let s = 0;
    for (let c = 0; c < count; c++) s += channelWeight(c, count) * (z[c]?.[b] ?? 0);
    return -0.691 + 10 * Math.log10(s);
  };
  const gated = (threshold: number): number[] => {
    const out: number[] = [];
    for (let b = 0; b < blocks; b++) if (blockLoudness(b) > threshold) out.push(b);
    return out;
  };
  const loudnessOf = (set: readonly number[]) => {
    let s = 0;
    for (let c = 0; c < count; c++) {
      let m = 0;
      for (const b of set) m += z[c]?.[b] ?? 0;
      s += channelWeight(c, count) * (m / set.length);
    }
    return -0.691 + 10 * Math.log10(s);
  };
  const absolute = gated(-70);
  if (absolute.length === 0) return Number.NEGATIVE_INFINITY;
  const relative = gated(loudnessOf(absolute) - 10);
  if (relative.length === 0) return Number.NEGATIVE_INFINITY;
  return loudnessOf(relative);
}

/** Optionen für {@link masterAudio}. */
export interface MasterOptions {
  /** Ziel der integrierten Lautheit in LUFS, z. B. −16 (Web) oder −23 (EBU R128). */
  readonly loudness?: number;
  /** Limiter nach der Normalisierung. Standard bei gesetztem `loudness`: Obergrenze −1 dBFS. */
  readonly limiter?: LimiterSpec;
}

/**
 * Mastering: Lautheit messen (BS.1770-4), Gain auf das Ziel, danach Limiter. Liefert einen neuen Puffer.
 * Stille bleibt unverändert (keine Verstärkung von −∞).
 *
 * @example
 * ```ts
 * const master = masterAudio(mix, { loudness: -16, limiter: { ceiling: -1 } });
 * ```
 */
export function masterAudio(buffer: PcmBuffer, options: MasterOptions = {}): PcmBuffer {
  const channels = buffer.channels.map((c) => Float32Array.from(c));
  if (options.loudness !== undefined) {
    const measured = measureLoudness(buffer);
    if (Number.isFinite(measured)) {
      const gain = dbToGain(options.loudness - measured);
      for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] = (ch[i] ?? 0) * gain;
    }
  }
  const limiter = options.limiter ?? (options.loudness !== undefined ? { ceiling: -1 } : undefined);
  if (limiter !== undefined) applyLimiter(channels, limiter, buffer.sampleRate);
  return { sampleRate: buffer.sampleRate, channels };
}
