/**
 * Anordnung der Instanzen einer `instances3d`-Node (FR-41). Reine Funktion von Layout, Seed und Zeit.
 */
import { isRecord, random, type EvaluatedNode } from '@agentic-video/core';

/** Transform einer Instanz: Position in Metern, Rotation XYZ in Grad, Skalierung je Achse. */
export interface InstanceTransform {
  readonly position: readonly [number, number, number];
  readonly rotation: readonly [number, number, number];
  readonly scale: readonly [number, number, number];
}

function vec3(value: unknown, fallback: readonly [number, number, number]): [number, number, number] {
  if (!Array.isArray(value)) return [...fallback];
  const items: readonly unknown[] = value;
  const [x, y, z] = items;
  return [typeof x === 'number' ? x : fallback[0], typeof y === 'number' ? y : fallback[1], typeof z === 'number' ? z : fallback[2]];
}

function scaleRange(layout: Readonly<Record<string, unknown>>): { min: number; max: number } {
  const s = layout['scale'];
  if (!isRecord(s)) return { min: 1, max: 1 };
  return { min: typeof s['min'] === 'number' ? s['min'] : 1, max: typeof s['max'] === 'number' ? s['max'] : 1 };
}

/**
 * Berechnet die Transforms aller Instanzen.
 *
 * Layouts:
 * - `grid`: Spalten entlang +X, Zeilen entlang −Y, Abstand `spacing`, das Raster ist um den Ursprung zentriert.
 * - `random-box`: Positionen gleichverteilt im Quader `size` um den Ursprung, zufällige Rotation, Skalierung aus `scale`.
 * - `random-sphere`: Positionen gleichverteilt in der Kugel mit `radius`, zufällige Rotation, Skalierung aus `scale`.
 * - `explicit`: `transforms[i]`; fehlende Einträge wiederholen die Liste zyklisch.
 *
 * `spin` (Grad pro Sekunde) dreht jede Instanz zusätzlich um ihre Y-Achse: Winkel = `spin · t`.
 *
 * @param seed Seed, falls die Node keinen eigenen `seed` hat.
 *
 * @example
 * ```ts
 * const transforms = instanceTransforms(node, 2.0, 1);
 * ```
 */
export function instanceTransforms(node: EvaluatedNode, timeSeconds: number, seed: number): InstanceTransform[] {
  const countRaw = node.props['count'];
  const count = Math.max(0, Math.floor(typeof countRaw === 'number' ? countRaw : 1));
  const s = typeof node.props['seed'] === 'number' ? node.props['seed'] : seed;
  const spinRaw = node.props['spin'];
  const spin = typeof spinRaw === 'number' ? spinRaw * timeSeconds : 0;
  const layoutRaw = node.props['layout'];
  const layout = isRecord(layoutRaw) ? layoutRaw : { type: 'grid', columns: 1, spacing: 1 };
  const out: InstanceTransform[] = [];
  const randomRotation = (i: number): [number, number, number] => [random(s, 'rx', i) * 360, random(s, 'ry', i) * 360 + spin, random(s, 'rz', i) * 360];
  const randomScale = (i: number): [number, number, number] => {
    const r = scaleRange(layout);
    const k = r.min + (r.max - r.min) * random(s, 'scale', i);
    return [k, k, k];
  };
  switch (layout['type']) {
    case 'random-box': {
      const size = vec3(layout['size'], [1, 1, 1]);
      for (let i = 0; i < count; i++) {
        out.push({
          position: [(random(s, 'px', i) - 0.5) * size[0], (random(s, 'py', i) - 0.5) * size[1], (random(s, 'pz', i) - 0.5) * size[2]],
          rotation: randomRotation(i),
          scale: randomScale(i),
        });
      }
      return out;
    }
    case 'random-sphere': {
      const radius = typeof layout['radius'] === 'number' ? layout['radius'] : 1;
      for (let i = 0; i < count; i++) {
        const r = radius * Math.cbrt(random(s, 'r', i));
        const z = random(s, 'z', i) * 2 - 1;
        const phi = random(s, 'phi', i) * Math.PI * 2;
        const rxy = Math.sqrt(Math.max(0, 1 - z * z));
        out.push({ position: [r * rxy * Math.cos(phi), r * rxy * Math.sin(phi), r * z], rotation: randomRotation(i), scale: randomScale(i) });
      }
      return out;
    }
    case 'explicit': {
      const list = Array.isArray(layout['transforms']) ? layout['transforms'].filter(isRecord) : [];
      if (list.length === 0) return out;
      for (let i = 0; i < count; i++) {
        const t = list[i % list.length] ?? {};
        const rot = vec3(t['rotation'], [0, 0, 0]);
        out.push({ position: vec3(t['position'], [0, 0, 0]), rotation: [rot[0], rot[1] + spin, rot[2]], scale: vec3(t['scale'], [1, 1, 1]) });
      }
      return out;
    }
    default: {
      const columns = Math.max(1, Math.floor(typeof layout['columns'] === 'number' ? layout['columns'] : 1));
      const spacing = typeof layout['spacing'] === 'number' ? layout['spacing'] : 1;
      const rows = Math.ceil(count / columns);
      const cols = Math.min(columns, count);
      for (let i = 0; i < count; i++) {
        const c = i % columns;
        const r = Math.floor(i / columns);
        out.push({ position: [(c - (cols - 1) / 2) * spacing, ((rows - 1) / 2 - r) * spacing, 0], rotation: [0, spin, 0], scale: [1, 1, 1] });
      }
      return out;
    }
  }
}
