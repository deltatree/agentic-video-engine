/**
 * Virtuelle Uhr für jedes Dokument im Render-Host (ADR 0013).
 *
 * Der Host lädt dieses Skript per `addInitScript`. Chromium führt es in jedem neuen
 * Dokument aus (Hauptseite und `srcdoc`-iframes), bevor ein Seitenskript läuft.
 *
 * - Immer virtualisiert: `Date`, `Date.now`, `performance.now`, `Math.random`.
 *   `Math.random` nutzt `random(seed, key, n)` aus `@agentic-video/core`.
 * - Nur in HTML-Layer-Dokumenten (iframes) zusätzlich: `setTimeout`, `setInterval`,
 *   `requestAnimationFrame`, `requestIdleCallback` und `window.openvideo`.
 *   Die Hauptseite behält echte Timer, damit Three.js und PixiJS nicht auf
 *   Rückrufe warten, die nie kommen.
 * - Ein neues Dokument startet bei lokaler Zeit 0. Die Zeit läuft nur vorwärts;
 *   für einen früheren Frame lädt die Laufzeit das Dokument neu.
 */
import { random } from '@agentic-video/core';
import { DOCUMENT_NAME_PREFIX, type DocumentConfig, type FrameState, type OpenVideoPageApi } from '../protocol.js';

/** Fester Nullpunkt der virtuellen Uhr: 2000-01-01T00:00:00Z. */
const VIRTUAL_EPOCH_MS = 946_684_800_000;
/** Höchstzahl ausgeführter Timer pro Frame (Schutz vor Endlosschleifen). */
const MAX_TIMER_RUNS = 10_000;

interface Timer {
  readonly id: number;
  due: number;
  readonly seq: number;
  readonly run: () => void;
  readonly interval: number | undefined;
}

function readConfig(name: string): DocumentConfig | undefined {
  if (!name.startsWith(DOCUMENT_NAME_PREFIX)) return undefined;
  try {
    const raw: unknown = JSON.parse(name.slice(DOCUMENT_NAME_PREFIX.length));
    if (typeof raw !== 'object' || raw === null) return undefined;
    const seed: unknown = Reflect.get(raw, 'seed');
    const key: unknown = Reflect.get(raw, 'key');
    const fps: unknown = Reflect.get(raw, 'fps');
    if (typeof seed !== 'number' || typeof key !== 'string' || typeof fps !== 'number') return undefined;
    return { seed, key, fps };
  } catch (error) {
    reportError(error);
    return undefined;
  }
}

/** Sammelt alle Web Animations inklusive offener Shadow Roots. */
function allAnimations(doc: Document): Animation[] {
  const out = doc.getAnimations();
  for (const el of doc.querySelectorAll('*')) {
    if (el.shadowRoot !== null) out.push(...el.shadowRoot.getAnimations());
  }
  return out;
}

function install(): void {
  const win = window;
  if (win.__ovClock !== undefined) return;
  const config = readConfig(win.name);
  const full = config !== undefined || win !== win.top;
  let now = 0;
  let seed = config?.seed ?? 0;
  let key = `${config?.key ?? 'page'}:load`;
  let counter = 0;

  // --- Date, performance.now, Math.random -------------------------------------------------
  const RealDate = win.Date;
  RealDate.now = () => VIRTUAL_EPOCH_MS + Math.round(now);
  win.Date = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      const made: unknown = Reflect.construct(target, args.length === 0 ? [VIRTUAL_EPOCH_MS + Math.round(now)] : args, newTarget);
      if (typeof made === 'object' && made !== null) return made;
      throw new TypeError('Date construction failed.');
    },
    apply() {
      return new RealDate(VIRTUAL_EPOCH_MS + Math.round(now)).toString();
    },
  });
  win.performance.now = () => now;
  win.Math.random = () => random(seed, key, counter++);
  const reseed = (s: number, k: string): void => {
    seed = s;
    key = k;
    counter = 0;
  };

  if (!full) {
    win.__ovClock = {
      get now() {
        return now;
      },
      frame(state: FrameState) {
        now = state.timeMs;
        reseed(state.seed, `${state.key}:${String(state.frame)}`);
      },
      reseed,
    };
    return;
  }

  // --- Timer-Warteschlange ---------------------------------------------------------------
  const timers = new Map<number, Timer>();
  let nextId = 1;
  let nextSeq = 0;
  const schedule = (handler: TimerHandler, timeout: number | undefined, args: unknown[], repeat: boolean): number => {
    const id = nextId++;
    const delay = timeout !== undefined && Number.isFinite(timeout) ? Math.max(0, timeout) : 0;
    const run = (): void => {
      if (typeof handler === 'function') Reflect.apply(handler, win, args);
      else win.eval(handler);
    };
    timers.set(id, { id, due: now + delay, seq: nextSeq++, run, interval: repeat ? Math.max(1, delay) : undefined });
    return id;
  };
  const clear = (id?: number): void => {
    if (id !== undefined) timers.delete(id);
  };
  // Object.assign statt Zuweisung: die Node-Typen (@types/node) überladen die Timer-Signaturen.
  Object.assign(win, {
    setTimeout: (handler: TimerHandler, timeout?: number, ...args: unknown[]) => schedule(handler, timeout, args, false),
    setInterval: (handler: TimerHandler, timeout?: number, ...args: unknown[]) => schedule(handler, timeout, args, true),
    clearTimeout: clear,
    clearInterval: clear,
  });

  const rafs = new Map<number, FrameRequestCallback>();
  win.requestAnimationFrame = (cb: FrameRequestCallback) => {
    const id = nextId++;
    rafs.set(id, cb);
    return id;
  };
  win.cancelAnimationFrame = (id: number) => {
    rafs.delete(id);
  };
  win.requestIdleCallback = (cb: IdleRequestCallback) =>
    schedule(
      () => {
        cb({ didTimeout: false, timeRemaining: () => 50 });
      },
      0,
      [],
      false,
    );
  win.cancelIdleCallback = (id: number) => {
    timers.delete(id);
  };

  const runTimers = (target: number): void => {
    for (let i = 0; i < MAX_TIMER_RUNS; i++) {
      let pick: Timer | undefined;
      for (const t of timers.values()) {
        if (t.due <= target && (pick === undefined || t.due < pick.due || (t.due === pick.due && t.seq < pick.seq))) pick = t;
      }
      if (pick === undefined) return;
      now = Math.max(now, pick.due);
      if (pick.interval === undefined) timers.delete(pick.id);
      else pick.due += pick.interval;
      try {
        pick.run();
      } catch (error) {
        reportError(error);
      }
    }
  };

  // --- window.openvideo -------------------------------------------------------------------
  type FrameCallback = Parameters<OpenVideoPageApi['onFrame']>[0];
  const frameCallbacks = new Set<FrameCallback>();
  const api: OpenVideoPageApi = {
    frame: 0,
    time: 0,
    fps: config?.fps ?? 30,
    progress: 0,
    onFrame(cb) {
      frameCallbacks.add(cb);
      return () => frameCallbacks.delete(cb);
    },
  };
  win.openvideo = api;

  const call = (fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      reportError(error);
    }
  };

  win.__ovClock = {
    get now() {
      return now;
    },
    frame(state: FrameState) {
      if (state.timeMs < now) throw new RangeError(`Virtual time cannot go backwards (${String(state.timeMs)} < ${String(now)}).`);
      reseed(state.seed, `${state.key}:${String(state.frame)}`);
      runTimers(state.timeMs);
      now = state.timeMs;
      api.frame = state.frame;
      api.time = state.timeMs / 1000;
      api.fps = state.fps;
      api.progress = state.progress;
      const root = win.document.documentElement;
      root.style.setProperty('--ov-time', String(api.time));
      root.style.setProperty('--ov-frame', String(api.frame));
      root.style.setProperty('--ov-progress', String(api.progress));
      const pending = [...rafs.values()];
      rafs.clear();
      for (const cb of pending) {
        call(() => {
          cb(now);
        });
      }
      const snapshot = { frame: api.frame, time: api.time, fps: api.fps, progress: api.progress };
      for (const cb of frameCallbacks) {
        call(() => {
          cb(snapshot);
        });
      }
      for (const animation of allAnimations(win.document)) {
        animation.pause();
        animation.currentTime = state.timeMs;
      }
    },
    reseed,
  };
}

install();
