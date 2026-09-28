/**
 * Look-up Tables im Format Adobe/Resolve `.cube` (1D und 3D).
 */
import { OpenVideoError } from '@agentic-video/core';

/**
 * Eine geparste LUT. `data` enthält `size` (1D) oder `size³` (3D) RGB-Tripel.
 * Bei 3D läuft Rot am schnellsten, dann Grün, dann Blau (wie in der `.cube`-Datei).
 */
export interface Lut {
  readonly kind: '1d' | '3d';
  readonly size: number;
  readonly title?: string;
  readonly domainMin: readonly [number, number, number];
  readonly domainMax: readonly [number, number, number];
  readonly data: Float32Array;
}

function lutError(problem: string, line?: number): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_LUT_INVALID',
    errorClass: 'LutError',
    problem: line === undefined ? problem : `${problem} (line ${String(line)})`,
    suggestions: ['Export the LUT as Adobe .cube with LUT_1D_SIZE or LUT_3D_SIZE and one "r g b" triple per line.'],
  });
}

function parseTriple(parts: readonly string[], line: number): [number, number, number] {
  const nums = parts.map(Number);
  const [r, g, b] = nums;
  if (nums.length !== 3 || r === undefined || g === undefined || b === undefined || !nums.every(Number.isFinite)) {
    throw lutError(`Expected three numbers, got "${parts.join(' ')}"`, line);
  }
  return [r, g, b];
}

/**
 * Parst eine `.cube`-Datei (1D oder 3D). Unterstützt `TITLE`, `DOMAIN_MIN`, `DOMAIN_MAX`,
 * `LUT_1D_INPUT_RANGE` und `LUT_3D_INPUT_RANGE`; Kommentare beginnen mit `#`.
 *
 * @example
 * ```ts
 * const lut = parseCubeLut('LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n');
 * lut.kind; // '3d'
 * ```
 */
export function parseCubeLut(text: string): Lut {
  let kind: '1d' | '3d' | undefined;
  let size = 0;
  let title: string | undefined;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];
  const lines = text.split(/\r?\n/u);
  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const line = raw.replace(/#.*$/u, '').trim();
    if (line === '') return;
    const parts = line.split(/\s+/u);
    const key = parts[0] ?? '';
    const rest = parts.slice(1);
    if (key === 'TITLE') {
      title = line.slice(5).trim().replace(/^"(.*)"$/u, '$1');
    } else if (key === 'LUT_1D_SIZE' || key === 'LUT_3D_SIZE') {
      if (kind !== undefined) throw lutError('LUT size is declared twice', lineNo);
      kind = key === 'LUT_1D_SIZE' ? '1d' : '3d';
      size = Number(rest[0]);
      const max = kind === '1d' ? 65536 : 256;
      if (!Number.isInteger(size) || size < 2 || size > max) throw lutError(`Invalid LUT size "${rest.join(' ')}", expected an integer 2..${String(max)}`, lineNo);
    } else if (key === 'DOMAIN_MIN') {
      domainMin = parseTriple(rest, lineNo);
    } else if (key === 'DOMAIN_MAX') {
      domainMax = parseTriple(rest, lineNo);
    } else if (key === 'LUT_1D_INPUT_RANGE' || key === 'LUT_3D_INPUT_RANGE') {
      const lo = Number(rest[0]);
      const hi = Number(rest[1]);
      if (rest.length !== 2 || !Number.isFinite(lo) || !Number.isFinite(hi)) throw lutError(`Invalid input range "${rest.join(' ')}"`, lineNo);
      domainMin = [lo, lo, lo];
      domainMax = [hi, hi, hi];
    } else if (/^[-+.0-9]/u.test(key)) {
      if (kind === undefined) throw lutError('Data appears before LUT_1D_SIZE or LUT_3D_SIZE', lineNo);
      values.push(...parseTriple(parts, lineNo));
    } else {
      throw lutError(`Unknown keyword "${key}"`, lineNo);
    }
  });
  if (kind === undefined) throw lutError('Missing LUT_1D_SIZE or LUT_3D_SIZE');
  const expected = (kind === '1d' ? size : size * size * size) * 3;
  if (values.length !== expected) throw lutError(`Expected ${String(expected / 3)} entries, got ${String(values.length / 3)}`);
  for (let c = 0; c < 3; c++) {
    if (!((domainMax[c] ?? 1) > (domainMin[c] ?? 0))) throw lutError('DOMAIN_MAX must be greater than DOMAIN_MIN');
  }
  return { kind, size, ...(title !== undefined ? { title } : {}), domainMin, domainMax, data: Float32Array.from(values) };
}

/**
 * Wendet eine LUT auf eine gerade Farbe an (1D: linear je Kanal, 3D: trilinear).
 * Eingaben außerhalb der Domäne werden an den Rand geklemmt.
 *
 * @example
 * ```ts
 * sampleLut(parseCubeLut(text), 0.5, 0.2, 0.1); // [r, g, b]
 * ```
 */
export function sampleLut(lut: Lut, r: number, g: number, b: number): [number, number, number] {
  const n = lut.size - 1;
  const pos = (v: number, c: number): number => {
    const lo = lut.domainMin[c] ?? 0;
    const hi = lut.domainMax[c] ?? 1;
    const t = (v - lo) / (hi - lo);
    return (t < 0 ? 0 : t > 1 ? 1 : t) * n;
  };
  const d = lut.data;
  if (lut.kind === '1d') {
    const out: [number, number, number] = [0, 0, 0];
    const input = [r, g, b];
    for (let c = 0; c < 3; c++) {
      const p = pos(input[c] ?? 0, c);
      const i0 = Math.min(Math.floor(p), n - 1);
      const f = p - i0;
      out[c] = (d[i0 * 3 + c] ?? 0) * (1 - f) + (d[(i0 + 1) * 3 + c] ?? 0) * f;
    }
    return out;
  }
  const pr = pos(r, 0);
  const pg = pos(g, 1);
  const pb = pos(b, 2);
  const r0 = Math.min(Math.floor(pr), n - 1);
  const g0 = Math.min(Math.floor(pg), n - 1);
  const b0 = Math.min(Math.floor(pb), n - 1);
  const fr = pr - r0;
  const fg = pg - g0;
  const fb = pb - b0;
  const s = lut.size;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const at = (ri: number, gi: number, bi: number): number => d[((bi * s + gi) * s + ri) * 3 + c] ?? 0;
    const c00 = at(r0, g0, b0) * (1 - fr) + at(r0 + 1, g0, b0) * fr;
    const c10 = at(r0, g0 + 1, b0) * (1 - fr) + at(r0 + 1, g0 + 1, b0) * fr;
    const c01 = at(r0, g0, b0 + 1) * (1 - fr) + at(r0 + 1, g0, b0 + 1) * fr;
    const c11 = at(r0, g0 + 1, b0 + 1) * (1 - fr) + at(r0 + 1, g0 + 1, b0 + 1) * fr;
    const c0 = c00 * (1 - fg) + c10 * fg;
    const c1 = c01 * (1 - fg) + c11 * fg;
    out[c] = c0 * (1 - fb) + c1 * fb;
  }
  return out;
}
