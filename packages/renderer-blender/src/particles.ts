/**
 * Zustandslose 3D-Partikel für Blender (Story 17.5): dieselbe Formel wie im Three.js-Renderer
 * (`particles3d` aus `@agentic-video/renderer-three`), damit beide Backends dieselbe Szene zeigen.
 * Dieses Paket darf `renderer-three` nicht importieren (Abhängigkeitsregeln), daher liegt die
 * Berechnung hier noch einmal vor; ein Test vergleicht beide Umsetzungen.
 */
import { interpolate, isRecord, random, type EvaluatedNode } from '@agentic-video/core';

/** Zustand eines lebenden 3D-Partikels. */
export interface BlenderParticle {
  /** Index des Partikels (stabil über die Zeit; Schlüssel für die Objekte in Blender). */
  readonly index: number;
  /** Position in Metern, relativ zur Node. */
  readonly position: readonly [number, number, number];
  /** Durchmesser in Metern. */
  readonly size: number;
  /** Farbe als sRGB-Farbtext. */
  readonly color: string;
}

function range(node: EvaluatedNode, key: string, fallback: { min: number; max: number }): { min: number; max: number } {
  const v = node.props[key];
  if (!isRecord(v)) return fallback;
  return { min: typeof v['min'] === 'number' ? v['min'] : fallback.min, max: typeof v['max'] === 'number' ? v['max'] : fallback.max };
}

function vec3(value: unknown, fallback: readonly [number, number, number]): [number, number, number] {
  if (!Array.isArray(value)) return [...fallback];
  const items: readonly unknown[] = value;
  const [x, y, z] = items;
  return [typeof x === 'number' ? x : fallback[0], typeof y === 'number' ? y : fallback[1], typeof z === 'number' ? z : fallback[2]];
}

/**
 * Berechnet alle lebenden Partikel einer `particles3d`-Node zur lokalen Zeit.
 *
 * Formel (pro Partikel i, Zufall aus Seed und i):
 * - Geburt `b_i = i / count · emitDuration` (emitDuration = Dauer der Node), Alter `a = t − b_i`,
 *   lebendig für `0 ≤ a < life_i`. Standard `lifetime` 1..2 s.
 * - Richtung gleichverteilt auf der Einheitskugel, Tempo aus `speed` (Standard 0.5..1.5 m/s).
 * - Start im Emitter: `point` (Standard), `sphere` (Kugel mit Radius `size`), `box` (Würfel mit Kantenlänge `size`).
 * - Position `start + v_i · a + ½ · gravity · a²` (Meter, Sekunden).
 * - Größe und Farbe linear von `start` nach `end` über das Leben (Standard 0.05 m → 0, `#FFFFFF`).
 *
 * @param seed Seed, falls die Node keinen eigenen `seed` hat.
 *
 * @example
 * ```ts
 * const alive = blenderParticles(node, 1.5, 30, 7);
 * ```
 */
export function blenderParticles(node: EvaluatedNode, timeSeconds: number, fps: number, seed: number): BlenderParticle[] {
  const countRaw = node.props['count'];
  const count = Math.max(0, Math.floor(typeof countRaw === 'number' ? countRaw : 100));
  const s = typeof node.props['seed'] === 'number' ? node.props['seed'] : seed;
  const emitterRaw = node.props['emitter'];
  const emitter = isRecord(emitterRaw) ? emitterRaw : {};
  const shape = typeof emitter['shape'] === 'string' ? emitter['shape'] : 'point';
  const emitterSize = typeof emitter['size'] === 'number' ? emitter['size'] : 0;
  const lifetime = range(node, 'lifetime', { min: 1, max: 2 });
  const speed = range(node, 'speed', { min: 0.5, max: 1.5 });
  const gravity = vec3(node.props['gravity'], [0, 0, 0]);
  const sizeRaw = node.props['size'];
  const sizeStart = isRecord(sizeRaw) && typeof sizeRaw['start'] === 'number' ? sizeRaw['start'] : 0.05;
  const sizeEnd = isRecord(sizeRaw) && typeof sizeRaw['end'] === 'number' ? sizeRaw['end'] : 0;
  const colorRaw = node.props['color'];
  const colorStart = isRecord(colorRaw) && typeof colorRaw['start'] === 'string' ? colorRaw['start'] : '#FFFFFF';
  const colorEnd = isRecord(colorRaw) && typeof colorRaw['end'] === 'string' ? colorRaw['end'] : colorStart;
  const emitDuration = node.time.durationFrames / fps;
  const out: BlenderParticle[] = [];
  for (let i = 0; i < count; i++) {
    const birth = (i / Math.max(1, count)) * emitDuration;
    const life = lifetime.min + (lifetime.max - lifetime.min) * random(s, 'life', i);
    const age = timeSeconds - birth;
    if (age < 0 || age >= life) continue;
    // Gleichverteilte Richtung: z gleichverteilt in [-1, 1], Winkel gleichverteilt.
    const z = random(s, 'dir-z', i) * 2 - 1;
    const phi = random(s, 'dir-phi', i) * Math.PI * 2;
    const rxy = Math.sqrt(Math.max(0, 1 - z * z));
    const dir: [number, number, number] = [rxy * Math.cos(phi), rxy * Math.sin(phi), z];
    const v = speed.min + (speed.max - speed.min) * random(s, 'speed', i);
    let start: [number, number, number] = [0, 0, 0];
    if (shape === 'sphere' && emitterSize > 0) {
      const r = emitterSize * Math.cbrt(random(s, 'r', i));
      const ez = random(s, 'e-z', i) * 2 - 1;
      const ephi = random(s, 'e-phi', i) * Math.PI * 2;
      const er = Math.sqrt(Math.max(0, 1 - ez * ez));
      start = [r * er * Math.cos(ephi), r * er * Math.sin(ephi), r * ez];
    } else if (shape === 'box' && emitterSize > 0) {
      start = [(random(s, 'bx', i) - 0.5) * emitterSize, (random(s, 'by', i) - 0.5) * emitterSize, (random(s, 'bz', i) - 0.5) * emitterSize];
    }
    const k = age / life;
    const c = interpolate(colorStart, colorEnd, k);
    out.push({
      index: i,
      position: [
        start[0] + dir[0] * v * age + 0.5 * gravity[0] * age * age,
        start[1] + dir[1] * v * age + 0.5 * gravity[1] * age * age,
        start[2] + dir[2] * v * age + 0.5 * gravity[2] * age * age,
      ],
      size: Math.max(0, sizeStart + (sizeEnd - sizeStart) * k),
      color: typeof c === 'string' ? c : colorStart,
    });
  }
  return out;
}
