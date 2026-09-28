/**
 * Signalverarbeitung in reinem TypeScript: Pan, EQ (RBJ-Biquads), Kompressor, Limiter, Ducking.
 * Alle Funktionen sind deterministisch: gleiche Eingabe → bitgleiche Ausgabe.
 * Interne Rechnung in Float64, Speicherung in Float32.
 */
import { OpenVideoError } from '@agentic-video/core';

/**
 * Pan-Gesetz mit konstanter Leistung: `θ = (pan + 1) · π/4`, links `cos θ`, rechts `sin θ`.
 * Mitte (pan 0) → beide Kanäle −3 dB (0.7071). Hart links (−1) → links 1, rechts 0.
 *
 * @example
 * ```ts
 * panGains(0); // [0.7071…, 0.7071…]
 * panGains(-1); // [1, 0]
 * ```
 */
export function panGains(pan: number): [number, number] {
  const p = Math.min(1, Math.max(-1, pan));
  const theta = ((p + 1) * Math.PI) / 4;
  return [p === 1 ? 0 : Math.cos(theta), Math.sin(theta)];
}

/** Koeffizient eines Glättungsfilters erster Ordnung für eine Zeitkonstante in Millisekunden. */
export function smoothing(ms: number, sampleRate: number): number {
  if (!(ms > 0)) return 1;
  return 1 - Math.exp(-1 / ((ms / 1000) * sampleRate));
}

/** Dezibel → linearer Faktor. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Linearer Faktor → Dezibel. */
export function gainToDb(gain: number): number {
  return 20 * Math.log10(Math.max(gain, 1e-12));
}

// ---------------------------------------------------------------------------
// EQ
// ---------------------------------------------------------------------------

/** Ein EQ-Band (wie `EqBand` in der IR). */
export interface EqBandSpec {
  readonly type: 'peak' | 'lowshelf' | 'highshelf' | 'lowpass' | 'highpass';
  readonly frequency: number;
  /** dB (peak, Shelves). */
  readonly gain?: number;
  /** Güte (Standard 0.7071). */
  readonly q?: number;
}

/** Normierte Biquad-Koeffizienten (a0 = 1). */
export interface Biquad {
  readonly b0: number;
  readonly b1: number;
  readonly b2: number;
  readonly a1: number;
  readonly a2: number;
}

/**
 * Berechnet Biquad-Koeffizienten nach dem Audio EQ Cookbook (Robert Bristow-Johnson).
 *
 * @example
 * ```ts
 * const hp = biquadCoefficients({ type: 'highpass', frequency: 80 }, 48000);
 * ```
 */
export function biquadCoefficients(band: EqBandSpec, sampleRate: number): Biquad {
  if (!(band.frequency > 0) || band.frequency >= sampleRate / 2) {
    throw new OpenVideoError({
      code: 'OV_AUDIO_EQ_FREQUENCY',
      errorClass: 'AudioError',
      problem: `EQ frequency ${String(band.frequency)} Hz must lie between 0 and the Nyquist frequency ${String(sampleRate / 2)} Hz.`,
      suggestions: [`Use a frequency below the Nyquist frequency ${String(sampleRate / 2)} Hz.`],
    });
  }
  const a = Math.pow(10, (band.gain ?? 0) / 40);
  const w0 = (2 * Math.PI * band.frequency) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * (band.q ?? Math.SQRT1_2));
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  switch (band.type) {
    case 'peak':
      b0 = 1 + alpha * a;
      b1 = -2 * cos;
      b2 = 1 - alpha * a;
      a0 = 1 + alpha / a;
      a1 = -2 * cos;
      a2 = 1 - alpha / a;
      break;
    case 'lowshelf': {
      const s = 2 * Math.sqrt(a) * alpha;
      b0 = a * (a + 1 - (a - 1) * cos + s);
      b1 = 2 * a * (a - 1 - (a + 1) * cos);
      b2 = a * (a + 1 - (a - 1) * cos - s);
      a0 = a + 1 + (a - 1) * cos + s;
      a1 = -2 * (a - 1 + (a + 1) * cos);
      a2 = a + 1 + (a - 1) * cos - s;
      break;
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(a) * alpha;
      b0 = a * (a + 1 + (a - 1) * cos + s);
      b1 = -2 * a * (a - 1 + (a + 1) * cos);
      b2 = a * (a + 1 + (a - 1) * cos - s);
      a0 = a + 1 - (a - 1) * cos + s;
      a1 = 2 * (a - 1 - (a + 1) * cos);
      a2 = a + 1 - (a - 1) * cos - s;
      break;
    }
    case 'lowpass':
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'highpass':
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/**
 * Filtert einen Kanal mit einem Biquad (Direktform I, in place).
 *
 * @example
 * ```ts
 * applyBiquad(channel, biquadCoefficients({ type: 'lowpass', frequency: 1000 }, 48000));
 * ```
 */
export function applyBiquad(data: Float32Array | Float64Array, c: Biquad): void {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < data.length; i++) {
    const x = data[i] ?? 0;
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    data[i] = y;
  }
}

/**
 * Wendet alle EQ-Bänder nacheinander auf alle Kanäle an (in place).
 *
 * @example
 * ```ts
 * applyEq(channels, [{ type: 'highpass', frequency: 80 }, { type: 'peak', frequency: 3000, gain: 3, q: 1 }], 48000);
 * ```
 */
export function applyEq(channels: readonly Float32Array[], bands: readonly EqBandSpec[], sampleRate: number): void {
  for (const band of bands) {
    const c = biquadCoefficients(band, sampleRate);
    for (const ch of channels) applyBiquad(ch, c);
  }
}

// ---------------------------------------------------------------------------
// Dynamik
// ---------------------------------------------------------------------------

/** Kompressor-Parameter (wie `Compressor` in der IR). */
export interface CompressorSpec {
  /** dBFS. */
  readonly threshold: number;
  readonly ratio: number;
  /** ms (Standard 10). */
  readonly attack?: number;
  /** ms (Standard 100). */
  readonly release?: number;
  /** dB (Standard 0). */
  readonly makeup?: number;
}

/**
 * Feed-forward-Kompressor mit harter Kennlinie. Der Pegel ist der Spitzenwert über alle Kanäle
 * (gekoppelte Kanäle); die Gain-Reduktion wird mit Attack/Release geglättet. In place.
 *
 * @example
 * ```ts
 * applyCompressor(channels, { threshold: -18, ratio: 4, attack: 5, release: 120, makeup: 3 }, 48000);
 * ```
 */
export function applyCompressor(channels: readonly Float32Array[], spec: CompressorSpec, sampleRate: number): void {
  const length = channels[0]?.length ?? 0;
  const att = smoothing(spec.attack ?? 10, sampleRate);
  const rel = smoothing(spec.release ?? 100, sampleRate);
  const slope = 1 - 1 / Math.max(1, spec.ratio);
  const makeup = spec.makeup ?? 0;
  let reduction = 0;
  for (let i = 0; i < length; i++) {
    let peak = 0;
    for (const ch of channels) peak = Math.max(peak, Math.abs(ch[i] ?? 0));
    const over = gainToDb(peak) - spec.threshold;
    const target = over > 0 ? over * slope : 0;
    reduction += (target - reduction) * (target > reduction ? att : rel);
    const g = dbToGain(makeup - reduction);
    for (const ch of channels) ch[i] = (ch[i] ?? 0) * g;
  }
}

/** Limiter-Parameter (wie `Limiter` in der IR). */
export interface LimiterSpec {
  /** Obergrenze in dBFS. */
  readonly ceiling: number;
  /** ms (Standard 50). */
  readonly release?: number;
}

/** Lookahead des Limiters in Sekunden (5 ms). */
export const LIMITER_LOOKAHEAD = 0.005;

/**
 * Brickwall-Limiter mit 5 ms Lookahead (Offline, ohne Latenz). In place.
 *
 * Ablauf: benötigte Verstärkung je Sample → Minimum über die nächsten 5 ms →
 * Release-Glättung (nur steigend) → gleitender Mittelwert über 5 ms.
 * Jeder Wert des Mittels liegt unter der benötigten Verstärkung am Spitzenwert,
 * darum überschreitet kein Sample die Obergrenze (Sample-Peak, kein True-Peak).
 *
 * @example
 * ```ts
 * applyLimiter(channels, { ceiling: -1 }, 48000);
 * ```
 */
export function applyLimiter(channels: readonly Float32Array[], spec: LimiterSpec, sampleRate: number): void {
  const n = channels[0]?.length ?? 0;
  if (n === 0) return;
  const ceiling = dbToGain(spec.ceiling);
  const look = Math.max(1, Math.round(LIMITER_LOOKAHEAD * sampleRate));
  const req = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let peak = 0;
    for (const ch of channels) peak = Math.max(peak, Math.abs(ch[i] ?? 0));
    req[i] = peak > ceiling ? ceiling / peak : 1;
  }
  // Minimum über [i, i + look − 1] (monotone Deque).
  const hold = new Float64Array(n);
  const deque = new Int32Array(n + look);
  let head = 0, tail = 0;
  for (let j = 0; j < n + look - 1; j++) {
    const v = j < n ? (req[j] ?? 1) : 1;
    if (j < n) {
      while (tail > head && (req[deque[tail - 1] ?? 0] ?? 1) >= v) tail--;
      deque[tail++] = j;
    }
    const start = j - look + 1;
    if (start < 0) continue;
    while (tail > head && (deque[head] ?? 0) < start) head++;
    hold[start] = tail > head ? (req[deque[head] ?? 0] ?? 1) : 1;
  }
  // Release-Glättung: sinken sofort, steigen langsam.
  const rel = smoothing(spec.release ?? 50, sampleRate);
  let g = hold[0] ?? 1;
  for (let i = 0; i < n; i++) {
    const h = hold[i] ?? 1;
    g = h < g ? h : g + (h - g) * rel;
    hold[i] = g;
  }
  // Gleitender Mittelwert über `look` Samples, links mit dem ersten Wert aufgefüllt.
  const first = hold[0] ?? 1;
  let sum = first * look;
  for (let i = 0; i < n; i++) {
    sum += (hold[i] ?? 1) - (i - look >= 0 ? (hold[i - look] ?? 1) : first);
    const gain = Math.min(1, sum / look);
    for (const ch of channels) ch[i] = (ch[i] ?? 0) * gain;
  }
  // Rundungsreste der Mittelung dürfen die Obergrenze nicht überschreiten.
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      const v = ch[i] ?? 0;
      if (v > ceiling) ch[i] = ceiling;
      else if (v < -ceiling) ch[i] = -ceiling;
    }
  }
}

// ---------------------------------------------------------------------------
// Ducking
// ---------------------------------------------------------------------------

/** Schwelle, ab der die Führungsspur als aktiv gilt (−40 dBFS). */
export const DUCKING_THRESHOLD_DB = -40;

/** Ducking-Parameter (wie `ducking` einer Spur in der IR). */
export interface DuckingSpec {
  /** Absenkung in dB (negativ, z. B. −12). */
  readonly amount: number;
  /** ms bis zur vollen Absenkung (Standard 10). */
  readonly attack?: number;
  /** ms bis zur Rückkehr (Standard 300). */
  readonly release?: number;
}

/**
 * Sidechain-Ducking: Die Hüllkurve der Führungsspur (Spitzenwert, sofortiger Anstieg, 50 ms Abfall)
 * schaltet die Absenkung ein, sobald sie über {@link DUCKING_THRESHOLD_DB} liegt. Die Verstärkung
 * gleitet mit `attack` zur Absenkung `amount` und mit `release` zurück. Wirkt in place auf `target`.
 *
 * @example
 * ```ts
 * applyDucking(music.channels, voice.channels, { amount: -12, attack: 20, release: 400 }, 48000);
 * ```
 */
export function applyDucking(target: readonly Float32Array[], key: readonly Float32Array[], spec: DuckingSpec, sampleRate: number): void {
  const n = target[0]?.length ?? 0;
  const threshold = dbToGain(DUCKING_THRESHOLD_DB);
  const detectorRelease = Math.exp(-1 / (0.05 * sampleRate));
  const att = smoothing(spec.attack ?? 10, sampleRate);
  const rel = smoothing(spec.release ?? 300, sampleRate);
  const ducked = dbToGain(Math.min(0, spec.amount));
  let env = 0;
  let g = 1;
  for (let i = 0; i < n; i++) {
    let level = 0;
    for (const ch of key) level = Math.max(level, Math.abs(ch[i] ?? 0));
    env = level > env ? level : env * detectorRelease;
    const goal = env > threshold ? ducked : 1;
    g += (goal - g) * (goal < g ? att : rel);
    for (const ch of target) ch[i] = (ch[i] ?? 0) * g;
  }
}
