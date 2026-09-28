/**
 * Gedämpfte Feder in geschlossener Form (FR-11).
 *
 * Die Position ergibt sich analytisch aus der Zeit. Es gibt keine Integration
 * in Schritten, daher ist das Ergebnis unabhängig von Framerate und Reihenfolge.
 */

/** Physikalische Parameter einer Feder. */
export interface SpringParams {
  /** Federkonstante k (> 0). Standard 100. */
  readonly stiffness?: number;
  /** Dämpfung c (>= 0). Standard 10. */
  readonly damping?: number;
  /** Masse m (> 0). Standard 1. */
  readonly mass?: number;
  /** Anfangsgeschwindigkeit in Einheiten des Weges pro Sekunde, normiert auf die Strecke 0 → 1. */
  readonly velocity?: number;
}

/**
 * Fortschritt einer Feder von 0 nach 1 zur Zeit `t` (Sekunden). Kann überschwingen.
 *
 * @example
 * ```ts
 * springProgress(0); // 0
 * springProgress(2, { stiffness: 170, damping: 26 }); // ≈ 1
 * ```
 */
export function springProgress(t: number, params: SpringParams = {}): number {
  if (t <= 0) return 0;
  const k = params.stiffness ?? 100;
  const c = params.damping ?? 10;
  const m = params.mass ?? 1;
  const v0 = params.velocity ?? 0;
  // Auslenkung x(t) = Ziel - Position, x(0) = 1, x'(0) = -v0
  const w0 = Math.sqrt(k / m);
  const zeta = c / (2 * Math.sqrt(k * m));
  let x: number;
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const b = (zeta * w0 - v0) / wd;
    x = Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + b * Math.sin(wd * t));
  } else if (zeta === 1) {
    x = Math.exp(-w0 * t) * (1 + (w0 - v0) * t);
  } else {
    const s = Math.sqrt(zeta * zeta - 1);
    const r1 = -w0 * (zeta - s);
    const r2 = -w0 * (zeta + s);
    const a = (-v0 - r2) / (r1 - r2);
    const b2 = 1 - a;
    x = a * Math.exp(r1 * t) + b2 * Math.exp(r2 * t);
  }
  return 1 - x;
}

/**
 * Zeit in Sekunden, nach der die Feder dauerhaft innerhalb von `tolerance` am Ziel bleibt.
 * Berechnet über die Hüllkurve, daher deterministisch.
 */
export function springSettleTime(params: SpringParams = {}, tolerance = 0.001): number {
  const k = params.stiffness ?? 100;
  const c = params.damping ?? 10;
  const m = params.mass ?? 1;
  const w0 = Math.sqrt(k / m);
  const zeta = c / (2 * Math.sqrt(k * m));
  if (zeta <= 0) return Number.POSITIVE_INFINITY;
  // Hüllkurve e^(-decay t) * amplitude ≤ tolerance
  const decay = zeta < 1 ? zeta * w0 : w0 * (zeta - Math.sqrt(zeta * zeta - 1));
  const amplitude = zeta < 1 ? Math.sqrt(1 + ((zeta * w0 - (params.velocity ?? 0)) / (w0 * Math.sqrt(1 - zeta * zeta))) ** 2) : 2;
  return Math.max(0, Math.log(amplitude / tolerance) / decay);
}
