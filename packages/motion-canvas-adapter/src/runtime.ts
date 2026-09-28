/**
 * Symbolische Ausführung von Motion-Canvas-artigen Generatoren (A8: OpenVideo besitzt die Zeit).
 *
 * Kein Task liest eine Uhr. Jeder Thread hat eine eigene symbolische Zeit in Sekunden;
 * der Scheduler setzt immer den Thread mit der kleinsten Zeit fort. So sehen Tweens beim
 * Start den Wert, den andere Threads bis dahin geschrieben haben.
 */
import { easing, interpolate, OpenVideoError, type Diagnostic } from '@agentic-video/core';

/** Anweisung eines Threads an den Scheduler. `undefined` (bloßes `yield`) wartet einen Frame. */
export type Instruction =
  | { readonly kind: 'wait'; readonly seconds: number }
  | { readonly kind: 'fork'; readonly tasks: readonly ThreadGenerator[]; readonly join: 'all' | 'any' }
  | { readonly kind: 'event'; readonly name: string }
  | undefined;

/** Ein Task: Generator, der mit `yield*` ausgeführt wird. */
export type ThreadGenerator = Generator<Instruction, void, void>;

/** Ein aufgezeichnetes Segment einer Property. Setzen: `start === end` und `set: true`. */
export interface Segment {
  readonly start: number;
  readonly end: number;
  readonly from: unknown;
  readonly to: unknown;
  readonly ease: string;
  readonly set: boolean;
}

/** Ein Zeit-Event aus `waitUntil`. */
export interface TimeEvent {
  readonly name: string;
  readonly time: number;
}

/** Laufzeit einer Szene. */
export class Runtime {
  /** Zeit des gerade laufenden Threads (Sekunden ab Szenenstart). */
  time = 0;
  readonly segments = new Map<string, Segment[]>();
  readonly events: TimeEvent[] = [];
  readonly diagnostics: Diagnostic[] = [];
  private readonly counters = new Map<string, number>();
  private readonly usedIds = new Set<string>();

  constructor(
    readonly sceneId: string,
    readonly fps: number,
    readonly eventDurations: Readonly<Record<string, number>>,
  ) {}

  /** Vergibt eine eindeutige Node-ID innerhalb der Szene. */
  nodeId(kind: string, key: string | undefined): string {
    if (key !== undefined) {
      const clean = `${this.sceneId}-${key.replace(/[^A-Za-z0-9_-]/gu, '_')}`;
      if (!this.usedIds.has(clean)) {
        this.usedIds.add(clean);
        return clean;
      }
    }
    let n = this.counters.get(kind) ?? 0;
    let id: string;
    do {
      n += 1;
      id = `${this.sceneId}-${kind}-${String(n)}`;
    } while (this.usedIds.has(id));
    this.counters.set(kind, n);
    this.usedIds.add(id);
    return id;
  }

  record(nodeId: string, prop: string, segment: Segment): void {
    const key = `${nodeId}\u0000${prop}`;
    const list = this.segments.get(key) ?? [];
    list.push(segment);
    this.segments.set(key, list);
  }

  /** Wert einer Property zur Zeit `t` aus Anfangswert und aufgezeichneten Segmenten. */
  valueAt(nodeId: string, prop: string, initial: unknown, t: number): unknown {
    let value = initial;
    for (const s of this.segments.get(`${nodeId}\u0000${prop}`) ?? []) {
      if (s.start > t + 1e-9) continue;
      if (t >= s.end - 1e-9) value = s.to;
      else value = interpolate(s.from, s.to, easing(s.ease)((t - s.start) / (s.end - s.start)));
    }
    return value;
  }
}

let active: Runtime | undefined;

/** Die gerade laufende Szene. Wirft, wenn keine Szene läuft. */
export function runtime(): Runtime {
  if (active === undefined) {
    throw new OpenVideoError({
      code: 'OV_MC_NO_SCENE',
      errorClass: 'MotionCanvasAdapterError',
      problem: 'Motion Canvas nodes and signals can only be used while a scene runs.',
      suggestions: ['Create nodes inside makeScene(name, function* (view) { ... }) and convert with toProject().'],
    });
  }
  return active;
}

interface Thread {
  readonly gen: ThreadGenerator;
  time: number;
  readonly seq: number;
  readonly parent: Thread | undefined;
  blocked: boolean;
  finished: boolean;
  join?: { mode: 'all' | 'any'; pending: number; maxEnd: number; resolved: boolean };
}

/** Obergrenze für Scheduler-Schritte (Schutz vor Endlosschleifen). */
const MAX_STEPS = 1_000_000;

/**
 * Führt einen Szenen-Generator symbolisch aus und liefert seine Dauer in Sekunden.
 * Detached Threads (aus `any`) enden mit der Szene, wie in Motion Canvas.
 */
export function execute(rt: Runtime, main: ThreadGenerator): number {
  const previous = active;
  active = rt;
  let seq = 0;
  const threads: Thread[] = [];
  const spawn = (gen: ThreadGenerator, time: number, parent: Thread | undefined): Thread => {
    const t: Thread = { gen, time, seq: seq++, parent, blocked: false, finished: false };
    threads.push(t);
    return t;
  };
  const root = spawn(main, 0, undefined);
  const finish = (t: Thread): void => {
    t.finished = true;
    const parent = t.parent;
    const join = parent?.join;
    if (parent === undefined || join === undefined || join.resolved) return;
    join.pending -= 1;
    join.maxEnd = Math.max(join.maxEnd, t.time);
    if (join.mode === 'any' || join.pending === 0) {
      join.resolved = true;
      parent.time = join.mode === 'any' ? t.time : join.maxEnd;
      parent.blocked = false;
    }
  };
  try {
    for (let steps = 0; !root.finished; steps++) {
      if (steps > MAX_STEPS) {
        throw new OpenVideoError({
          code: 'OV_MC_TOO_LONG',
          errorClass: 'MotionCanvasAdapterError',
          problem: `Scene "${rt.sceneId}" did not finish within ${String(MAX_STEPS)} scheduler steps.`,
          suggestions: ['Check for endless loops; use loop(n, factory) with a finite n.'],
        });
      }
      let next: Thread | undefined;
      for (const t of threads) {
        if (t.finished || t.blocked) continue;
        if (next === undefined || t.time < next.time - 1e-12 || (Math.abs(t.time - next.time) <= 1e-12 && t.seq < next.seq)) next = t;
      }
      if (next === undefined) break;
      rt.time = next.time;
      const r = next.gen.next();
      if (r.done === true) {
        finish(next);
        continue;
      }
      const instr = r.value;
      if (instr === undefined) {
        next.time += 1 / rt.fps;
      } else if (instr.kind === 'wait') {
        next.time += Math.max(0, instr.seconds);
      } else if (instr.kind === 'event') {
        // Das Event markiert den Zeitpunkt, bis zu dem gewartet wird.
        next.time += Math.max(0, rt.eventDurations[instr.name] ?? 0);
        rt.events.push({ name: instr.name, time: next.time });
      } else if (instr.tasks.length > 0) {
        next.blocked = true;
        next.join = { mode: instr.join, pending: instr.tasks.length, maxEnd: next.time, resolved: false };
        for (const task of instr.tasks) spawn(task, next.time, next);
      }
    }
    return root.time;
  } finally {
    active = previous;
  }
}
