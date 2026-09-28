/**
 * Geometrie der Bühne: Ausrichten, Verteilen und Einrasten.
 * Alle Werte in Pixeln der Composition.
 */

/** Achsenparallele Box. */
export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Verschiebung einer Node. */
export interface Delta {
  readonly dx: number;
  readonly dy: number;
}

/** Ausrichtungen der Toolbar. */
export type AlignMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

/**
 * Richtet Boxen aneinander aus (an der gemeinsamen Hülle).
 *
 * @example
 * ```ts
 * alignDeltas(new Map([['a', { x: 10, y: 0, width: 5, height: 5 }], ['b', { x: 40, y: 0, width: 5, height: 5 }]]), 'left').get('b'); // { dx: -30, dy: 0 }
 * ```
 */
export function alignDeltas(boxes: ReadonlyMap<string, Box>, mode: AlignMode): Map<string, Delta> {
  const list = [...boxes.values()];
  const left = Math.min(...list.map((b) => b.x));
  const right = Math.max(...list.map((b) => b.x + b.width));
  const top = Math.min(...list.map((b) => b.y));
  const bottom = Math.max(...list.map((b) => b.y + b.height));
  const out = new Map<string, Delta>();
  for (const [id, b] of boxes) {
    switch (mode) {
      case 'left':
        out.set(id, { dx: left - b.x, dy: 0 });
        break;
      case 'center':
        out.set(id, { dx: (left + right) / 2 - (b.x + b.width / 2), dy: 0 });
        break;
      case 'right':
        out.set(id, { dx: right - (b.x + b.width), dy: 0 });
        break;
      case 'top':
        out.set(id, { dx: 0, dy: top - b.y });
        break;
      case 'middle':
        out.set(id, { dx: 0, dy: (top + bottom) / 2 - (b.y + b.height / 2) });
        break;
      case 'bottom':
        out.set(id, { dx: 0, dy: bottom - (b.y + b.height) });
        break;
    }
  }
  return out;
}

/**
 * Verteilt Boxen mit gleichen Abständen zwischen der ersten und der letzten.
 *
 * @example
 * ```ts
 * distributeDeltas(boxes, 'horizontal');
 * ```
 */
export function distributeDeltas(boxes: ReadonlyMap<string, Box>, axis: 'horizontal' | 'vertical'): Map<string, Delta> {
  const pos = (b: Box): number => (axis === 'horizontal' ? b.x : b.y);
  const size = (b: Box): number => (axis === 'horizontal' ? b.width : b.height);
  const sorted = [...boxes.entries()].sort((a, b) => pos(a[1]) - pos(b[1]));
  const out = new Map<string, Delta>();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined || sorted.length < 3) return out;
  const span = pos(last[1]) + size(last[1]) - pos(first[1]);
  const used = sorted.reduce((s, [, b]) => s + size(b), 0);
  const gap = (span - used) / (sorted.length - 1);
  let cursor = pos(first[1]);
  for (const [id, b] of sorted) {
    const d = cursor - pos(b);
    out.set(id, axis === 'horizontal' ? { dx: d, dy: 0 } : { dx: 0, dy: d });
    cursor += size(b) + gap;
  }
  return out;
}

/** Ergebnis von {@link snapMove}. */
export interface Snap extends Delta {
  /** Senkrechte Hilfslinie (x), an der eingerastet wurde. */
  readonly lineX?: number;
  /** Waagerechte Hilfslinie (y), an der eingerastet wurde. */
  readonly lineY?: number;
}

function snapAxis(edges: readonly number[], targets: readonly number[], threshold: number): { shift: number; line: number } | undefined {
  let best: { shift: number; line: number } | undefined;
  for (const e of edges) {
    for (const t of targets) {
      const shift = t - e;
      if (Math.abs(shift) <= threshold && (best === undefined || Math.abs(shift) < Math.abs(best.shift))) best = { shift, line: t };
    }
  }
  return best;
}

/**
 * Rastet eine verschobene Box an Zielkanten ein (Kanten und Mitte der Box).
 *
 * @example
 * ```ts
 * snapMove({ x: 0, y: 0, width: 10, height: 10 }, 97, 0, [100], [], 5); // { dx: 100, dy: 0, lineX: 100 }
 * ```
 */
export function snapMove(box: Box, dx: number, dy: number, targetsX: readonly number[], targetsY: readonly number[], threshold: number): Snap {
  const moved = { x: box.x + dx, y: box.y + dy };
  const sx = snapAxis([moved.x, moved.x + box.width / 2, moved.x + box.width], targetsX, threshold);
  const sy = snapAxis([moved.y, moved.y + box.height / 2, moved.y + box.height], targetsY, threshold);
  return {
    dx: dx + (sx?.shift ?? 0),
    dy: dy + (sy?.shift ?? 0),
    ...(sx !== undefined ? { lineX: sx.line } : {}),
    ...(sy !== undefined ? { lineY: sy.line } : {}),
  };
}

/**
 * Hülle mehrerer Boxen.
 *
 * @example
 * ```ts
 * union([{ x: 0, y: 0, width: 1, height: 1 }, { x: 2, y: 2, width: 1, height: 1 }]); // { x: 0, y: 0, width: 3, height: 3 }
 * ```
 */
export function union(boxes: readonly Box[]): Box | undefined {
  if (boxes.length === 0) return undefined;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map((b) => b.x + b.width)) - x, height: Math.max(...boxes.map((b) => b.y + b.height)) - y };
}
