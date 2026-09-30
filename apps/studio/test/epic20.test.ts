/**
 * Reine Logik aus Epic 20: Verlauf, Warteschlangen, Live-Sync, Audio, Ebenen (mit zIndex),
 * Transform-Griffe, Timeline-Werkzeuge, Layout, Zwischenablage und Mehrfachbearbeitung.
 */
import { describe, expect, it, vi } from 'vitest';
import { toCorePatches } from '@agentic-video/agent';
import { applyPatches, isRecord } from '@agentic-video/core';
import { addAudioClipPatches, clipLength, editClip, peaks, planClips, scheduleClip } from '../src/audio.js';
import { clipboardText, parseClipboard } from '../src/clipboard.js';
import { fieldsFor } from '../src/fields.js';
import { History } from '../src/history.js';
import { timeInfo } from '../src/ir.js';
import { defaultLayout, parseLayout } from '../src/layout.js';
import { layerPatches, orderedChildren, siblingsOf, sortByZ, ungroupPatches } from '../src/layers.js';
import { MIXED, commonFields, multiSetPatches, sharedValue } from '../src/multi.js';
import { matchesQuery } from '../src/panels/Library.js';
import { LatestOnly, SerialQueue } from '../src/queue.js';
import { RevisionTracker, parseSse, subscribeRevisions } from '../src/sync.js';
import { addMarker, advanceFrame, keyframeJump, moveKeyframe, removeMarker, renameMarker, shuttle, snapFrame, snapSpan, timelineSnapTargets } from '../src/timeline-logic.js';
import { angleOf, marqueeHits, normalizeBox, resizeBlocker, resizeBox, resizePatches, rotateBy } from '../src/transform.js';

type Rec = Record<string, unknown>;

/** Wendet Studio-Patches mit dem echten Kern an (wie composition.patch). */
function apply(project: Rec, patches: readonly Rec[]): Rec {
  // Die Studio-Patches haben die Form der Kern-Patches (JSON); der Test prüft genau diese Verträglichkeit.
  const r = applyPatches(project, toCorePatches(patches));
  if (!r.ok) throw new Error(r.diagnostics.map((d) => d.problem).join('; '));
  return r.project;
}

function comp(project: Rec): Rec {
  const c = Array.isArray(project['compositions']) ? project['compositions'].find(isRecord) : undefined;
  if (c === undefined) throw new Error('no composition');
  return c;
}

/** Objekte einer Liste. */
function objects(value: unknown): Rec[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function project(nodes: Rec[], extra: Rec = {}): Rec {
  return { schemaVersion: '1.0.0', compositions: [{ id: 'main', width: 100, height: 100, fps: 10, duration: 50, nodes, ...extra }] };
}

/** Effektive Zeichenreihenfolge der obersten Ebene (wie sortByZIndex im Renderer). */
function drawOrder(p: Rec): string[] {
  return orderedChildren(comp(p)['nodes']).map((n) => String(n['id']));
}

describe('Story 20.3: History', () => {
  it('fasst Einträge mit gleichem Schlüssel im Zeitfenster zusammen (neueste Umkehrung zuerst)', () => {
    const h = new History(1000);
    h.record({ kind: 'patches', patches: [{ n: 1 }] }, 'nudge:a', 0);
    h.record({ kind: 'patches', patches: [{ n: 2 }] }, 'nudge:a', 500);
    h.record({ kind: 'patches', patches: [{ n: 3 }] }, 'nudge:a', 1400);
    expect(h.size).toBe(1);
    expect(h.popUndo()).toEqual({ kind: 'patches', patches: [{ n: 3 }, { n: 2 }, { n: 1 }] });
  });

  it('beginnt nach Ablauf, anderem Schlüssel oder seal() einen neuen Schritt', () => {
    const h = new History(1000);
    h.record({ kind: 'patches', patches: [{ n: 1 }] }, 'a', 0);
    h.record({ kind: 'patches', patches: [{ n: 2 }] }, 'a', 5000);
    h.record({ kind: 'patches', patches: [{ n: 3 }] }, 'b', 5100);
    h.seal();
    h.record({ kind: 'patches', patches: [{ n: 4 }] }, 'b', 5200);
    expect(h.size).toBe(4);
  });

  it('Code-Save ist ein eigener Schritt; neue Änderungen leeren Redo; clear() verwirft alles', () => {
    const h = new History();
    h.record({ kind: 'project', project: { v: 1 } });
    const undo = h.popUndo();
    expect(undo).toEqual({ kind: 'project', project: { v: 1 } });
    h.pushRedo({ kind: 'project', project: { v: 2 } });
    expect(h.canRedo).toBe(true);
    h.record({ kind: 'patches', patches: [] });
    expect(h.canRedo).toBe(false);
    h.clear();
    expect(h.canUndo || h.canRedo).toBe(false);
  });
});

describe('Story 20.3: SerialQueue', () => {
  it('führt Aufgaben streng nacheinander aus, auch wenn eine fehlschlägt', async () => {
    const q = new SerialQueue();
    const log: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a = q.run(async () => {
      log.push('a:start');
      await gate;
      log.push('a:end');
    });
    const b = q.run(() => Promise.reject(new Error('b failed')));
    const c = q.run(() => {
      log.push('c');
      return Promise.resolve(3);
    });
    expect(q.pending).toBe(3);
    release();
    await a;
    await expect(b).rejects.toThrow('b failed');
    expect(await c).toBe(3);
    await q.idle();
    expect(log).toEqual(['a:start', 'a:end', 'c']);
    expect(q.pending).toBe(0);
  });
});

describe('Story 20.5: LatestOnly', () => {
  it('rendert höchstens einen Stand gleichzeitig und danach nur den neuesten', async () => {
    vi.useFakeTimers();
    try {
      const seen: number[] = [];
      let finish: () => void = () => undefined;
      let now = 0;
      const throttle = new LatestOnly<number>(
        (v) => {
          seen.push(v);
          return new Promise((r) => {
            finish = r;
          });
        },
        50,
        () => now,
      );
      throttle.push(1);
      throttle.push(2);
      throttle.push(3);
      expect(seen).toEqual([1]);
      now = 100;
      finish();
      await vi.runAllTimersAsync();
      expect(seen).toEqual([1, 3]);
      throttle.push(4);
      throttle.cancel();
      finish();
      await vi.runAllTimersAsync();
      expect(seen).toEqual([1, 3]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Story 20.1: Live-Sync', () => {
  it('zerlegt SSE in Ereignisse und behält den unvollständigen Rest', () => {
    const r = parseSse('retry: 2000\n\nevent: revision\ndata: {"revision":"a"}\n\n: keep-alive\n\nevent: revision\r\ndata: {"rev');
    expect(r.events).toEqual([{ event: 'revision', data: '{"revision":"a"}' }]);
    expect(r.rest).toBe('event: revision\ndata: {"rev');
  });

  it('erkennt Fremdänderungen und wartet während eigener Schreibvorgänge', () => {
    const t = new RevisionTracker();
    // Vor dem ersten Laden ist nichts fremd.
    expect(t.remote('a', false)).toBe(false);
    t.loaded('a');
    expect(t.remote('a', false)).toBe(false);
    expect(t.remote('b', false)).toBe(true);
    // Eigene Änderung: Ereignis kommt, während die Warteschlange arbeitet.
    t.loaded('b');
    expect(t.remote('c', true)).toBe(false);
    t.loaded('c');
    expect(t.pending()).toBe(false);
    // Fremdänderung während eines eigenen Schreibvorgangs: danach steht sie aus.
    expect(t.remote('d', true)).toBe(false);
    t.loaded('c');
    expect(t.pending()).toBe(true);
  });

  it('acknowledge: eine geprüfte Meldung steht nicht mehr aus, eine neuere schon', () => {
    const t = new RevisionTracker();
    t.loaded('b');
    // Verspätetes Echo einer früheren eigenen Speicherung (oder älterer Anfangsstand des Stroms).
    expect(t.remote('a', true)).toBe(false);
    expect(t.pending()).toBe(true);
    expect(t.reported).toBe('a');
    t.acknowledge('a');
    expect(t.pending()).toBe(false);
    // Während der Prüfung kommt eine neuere Meldung: sie bleibt vorgemerkt.
    t.remote('x', true);
    t.remote('y', true);
    t.acknowledge('x');
    expect(t.pending()).toBe(true);
    expect(t.reported).toBe('y');
  });

  it('subscribeRevisions: wachsende Wartezeit bei sofort endenden Strömen, Rücksetzen erst nach einem Ereignis, Ende mit stop()', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { location: { hash: '', search: '', pathname: '/' }, history: { replaceState: () => undefined } });
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => undefined });
    const starts: number[] = [];
    let withEvent = false;
    vi.stubGlobal('fetch', () => {
      starts.push(Date.now());
      const text = withEvent ? 'event: revision\ndata: {"revision":"r1"}\n\n' : 'retry: 2000\n\n';
      withEvent = false;
      return Promise.resolve(new Response(text, { headers: { 'content-type': 'text/event-stream' } }));
    });
    const revisions: string[] = [];
    const states: string[] = [];
    try {
      const t0 = Date.now();
      const stop = subscribeRevisions('demo', (r) => revisions.push(r), (st) => states.push(st), { minDelayMs: 100, maxDelayMs: 400 });
      await vi.advanceTimersByTimeAsync(100 + 200 + 400 + 400 - 1);
      // Verbindet sofort, dann nach 100, 200, 400, 400 ms (gedeckelt) – kein Sekundentakt-Rücksetzen.
      expect(starts.map((x) => x - t0)).toEqual([0, 100, 300, 700]);
      withEvent = true;
      await vi.advanceTimersByTimeAsync(1);
      expect(revisions).toEqual(['r1']);
      // Diese Verbindung trug ein Ereignis: die nächste Wartezeit beginnt wieder bei 100 ms.
      await vi.advanceTimersByTimeAsync(100);
      expect(starts.map((x) => x - t0)).toEqual([0, 100, 300, 700, 1100, 1200]);
      stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(starts).toHaveLength(6);
      expect(states).toContain('live');
      expect(states.at(-1)).toBe('offline');
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});

describe('Story 20.2/20.7: Audio', () => {
  const proj: Rec = {
    assets: [{ id: 'bed', type: 'audio', src: 'assets/bed.wav' }],
    audio: [{ id: 'bed', asset: 'bed' }, { id: 'voice', voice: { provider: 'piper', text: 'Hi' } }],
  };
  const c: Rec = {
    id: 'main',
    fps: 10,
    tracks: [
      { id: 'music', kind: 'audio', volume: 0.5, clips: [{ id: 'm1', source: 'bed', start: 20, offset: '1s', duration: 30, fadeIn: 5, volume: 0.8, playbackRate: 1 }] },
      { id: 'vo', kind: 'audio', clips: [{ id: 'v1', source: 'voice', start: 0 }] },
      { id: 'muted', kind: 'audio', muted: true, clips: [{ id: 'x', source: 'bed', start: 0 }] },
      { id: 'subs', kind: 'subtitle', cues: [] },
    ],
  };

  it('plant nur Clips mit Datei aus hörbaren Spuren, in Sekunden', () => {
    const plan = planClips(c, proj);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ trackId: 'music', clipId: 'm1', src: 'assets/bed.wav', start: 2, offset: 1, duration: 3, fadeIn: 0.5, loop: false, rate: 1 });
    expect(plan[0]?.volume).toBeCloseTo(0.4);
  });

  it('plant den Start ab einer Position mitten im Clip', () => {
    const clip = { start: 2, offset: 0.5, duration: 3, rate: 1, loop: false };
    expect(scheduleClip(clip, 0, 10)).toEqual({ delay: 2, offset: 0.5, length: 3, elapsed: 0 });
    expect(scheduleClip(clip, 3, 10)).toEqual({ delay: 0, offset: 1.5, length: 2, elapsed: 1 });
    expect(scheduleClip(clip, 5, 10)).toBeUndefined();
    // Ohne Dauer: bis Dateiende; mit Schleife: Offset zyklisch.
    expect(scheduleClip({ start: 0, offset: 0, duration: undefined, rate: 2, loop: false }, 1, 4)).toEqual({ delay: 0, offset: 2, length: 1, elapsed: 1 });
    expect(scheduleClip({ start: 0, offset: 0, duration: 10, rate: 1, loop: true }, 5, 2)?.offset).toBe(1);
    expect(clipLength({ offset: 1, duration: undefined, rate: 1, loop: false }, 5)).toBe(4);
  });

  it('berechnet Spitzen je Spalte', () => {
    expect([...peaks(new Float32Array([0, 0.5, -1, 0.25]), 2)]).toEqual([0.5, 1]);
    expect([...peaks(new Float32Array([0, 0.5, -1, 0.25]), 1, 2, 4)]).toEqual([1]);
  });

  it('legt beim Ziehen eines Audio-Assets Quelle, Spur und Clip über Patches an', () => {
    const p = project([], {});
    const withAsset = { ...p, assets: [{ id: 'voice', type: 'audio', src: 'assets/voice.wav' }] };
    const first = addAudioClipPatches(withAsset, comp(withAsset), 'voice', 12);
    const after = apply(withAsset, first.patches);
    expect(after['audio']).toEqual([{ id: 'voice', asset: 'voice' }]);
    expect(comp(after)['tracks']).toEqual([{ id: 'audio', kind: 'audio', clips: [{ id: 'voice', source: 'voice', start: 12 }] }]);
    // Zweiter Clip auf dieselbe Spur: keine neue Quelle, eindeutige Clip-ID.
    const second = addAudioClipPatches(after, comp(after), 'voice', 30, 'audio');
    expect(second.patches).toHaveLength(1);
    const again = apply(after, second.patches);
    const clips = objects(comp(again)['tracks'])[0]?.['clips'];
    expect(clips).toEqual([
      { id: 'voice', source: 'voice', start: 12 },
      { id: 'voice-2', source: 'voice', start: 30 },
    ]);
  });

  it('verschiebt, trimmt und blendet Clips (Frames)', () => {
    const time = timeInfo({ fps: 10 });
    const clip = { id: 'c', source: 's', start: 10, offset: 5 };
    expect(editClip(clip, { move: 5 }, time, 40)).toMatchObject({ start: 15 });
    // Anfang trimmen: Start und Offset rücken gemeinsam, die Länge schrumpft.
    expect(editClip(clip, { trimStart: 3 }, time, 40)).toMatchObject({ start: 13, offset: 8, duration: 37 });
    // Nicht vor den Dateianfang.
    expect(editClip(clip, { trimStart: -20 }, time, 40)).toMatchObject({ start: 5, offset: 0, duration: 45 });
    expect(editClip(clip, { trimEnd: -10 }, time, 40)).toMatchObject({ duration: 30 });
    expect(editClip(clip, { fadeIn: 4, fadeOut: 6 }, time, 40)).toMatchObject({ fadeIn: 4, fadeOut: 6 });
    expect(editClip({ ...clip, fadeIn: 4 }, { fadeIn: -9 }, time, 40)).not.toHaveProperty('fadeIn');
  });
});

describe('Story 20.6: Ebenen mit zIndex', () => {
  const nodes = (): Rec[] => [
    { id: 'a', type: 'rect', width: 1, height: 1 },
    { id: 'b', type: 'rect', width: 1, height: 1 },
    { id: 'c', type: 'rect', width: 1, height: 1 },
  ];

  const run = (p: Rec, id: string, cmd: 'front' | 'back' | 'forward' | 'backward'): Rec => {
    const r = layerPatches(siblingsOf(comp(p), id), null, id, cmd);
    if (typeof r === 'string') throw new Error(r);
    return apply(p, r);
  };

  it('sortiert stabil nach zIndex wie der Renderer', () => {
    expect(sortByZ([{ id: 'a', z: 1 }, { id: 'b', z: 0 }, { id: 'c', z: 1 }, { id: 'd', z: -1 }]).map((s) => s.id)).toEqual(['d', 'b', 'a', 'c']);
  });

  it('ordnet ohne zIndex nur über die Dokumentreihenfolge', () => {
    const p = project(nodes());
    expect(drawOrder(run(p, 'a', 'front'))).toEqual(['b', 'c', 'a']);
    expect(drawOrder(run(p, 'c', 'back'))).toEqual(['c', 'a', 'b']);
    expect(drawOrder(run(p, 'a', 'forward'))).toEqual(['b', 'a', 'c']);
    expect(drawOrder(run(p, 'c', 'backward'))).toEqual(['a', 'c', 'b']);
    const front = run(p, 'a', 'front');
    expect(JSON.stringify(front)).not.toContain('zIndex');
    // Schon vorn: keine Patches.
    expect(layerPatches(siblingsOf(comp(p), 'c'), null, 'c', 'front')).toEqual([]);
  });

  it('übernimmt den zIndex des Nachbarn, wenn die Reihenfolge allein nicht reicht', () => {
    const list = nodes();
    list[2] = { ...list[2], zIndex: 5 };
    const p = project(list);
    expect(drawOrder(p)).toEqual(['a', 'b', 'c']);
    const front = run(p, 'a', 'front');
    expect(drawOrder(front)).toEqual(['b', 'c', 'a']);
    const forward = run(p, 'b', 'forward');
    expect(drawOrder(forward)).toEqual(['a', 'c', 'b']);
    const back = run(p, 'c', 'back');
    expect(drawOrder(back)).toEqual(['c', 'a', 'b']);
    // zIndex 0 wird entfernt statt gesetzt.
    expect(objects(comp(back)['nodes']).find((n) => n['id'] === 'c')).not.toHaveProperty('zIndex');
    const backward = run(p, 'c', 'backward');
    expect(drawOrder(backward)).toEqual(['a', 'c', 'b']);
  });

  it('überschreibt animiertes zIndex nicht', () => {
    const list = nodes();
    list[0] = { ...list[0], zIndex: { $keyframes: [{ t: 0, v: -1 }, { t: 10, v: -1 }] } };
    list[2] = { ...list[2], zIndex: 3 };
    const p = project(list);
    const r = layerPatches(siblingsOf(comp(p), 'a', () => -1), null, 'a', 'front');
    expect(typeof r).toBe('string');
  });

  it('löst Gruppen auf und überträgt die Verschiebung auf die Kinder', () => {
    const p = project([
      { id: 'x', type: 'rect', width: 1, height: 1 },
      { id: 'g', type: 'group', x: 10, y: 5, children: [{ id: 'k1', type: 'rect', x: 1, width: 1, height: 1 }, { id: 'k2', type: 'rect', width: 1, height: 1 }] },
      { id: 'y', type: 'rect', width: 1, height: 1 },
    ]);
    const r = ungroupPatches(comp(p), 'g');
    if (typeof r === 'string') throw new Error(r);
    expect(r.children).toEqual(['k1', 'k2']);
    const after = apply(p, r.patches);
    const top = objects(comp(after)['nodes']);
    expect(top.map((n) => n['id'])).toEqual(['x', 'k1', 'k2', 'y']);
    expect(top[1]).toMatchObject({ x: 11, y: 5 });
    expect(top[2]).toMatchObject({ x: 10, y: 5 });
    expect(typeof ungroupPatches(comp(project([{ id: 'g', type: 'group', rotation: 5, children: [] }])), 'g')).toBe('string');
    expect(typeof ungroupPatches(comp(p), 'x')).toBe('string');
  });
});

describe('Story 20.4: Transform-Griffe', () => {
  const box = { x: 10, y: 20, width: 100, height: 50 };

  it('ändert die Größe an allen Griffen, mit Seitenverhältnis und um die Mitte', () => {
    expect(resizeBox(box, 'se', 20, 10, false)).toEqual({ x: 10, y: 20, width: 120, height: 60 });
    expect(resizeBox(box, 'nw', 10, 10, false)).toEqual({ x: 20, y: 30, width: 90, height: 40 });
    expect(resizeBox(box, 'e', 50, 99, false)).toEqual({ x: 10, y: 20, width: 150, height: 50 });
    expect(resizeBox(box, 'n', 99, -10, false)).toEqual({ x: 10, y: 10, width: 100, height: 60 });
    expect(resizeBox(box, 'se', 100, 0, true)).toEqual({ x: 10, y: 20, width: 200, height: 100 });
    expect(resizeBox(box, 'e', 100, 0, true)).toEqual({ x: 10, y: -5, width: 200, height: 100 });
    expect(resizeBox(box, 'e', 10, 0, false, true)).toEqual({ x: 0, y: 20, width: 120, height: 50 });
    // Über die Gegenkante hinaus: Mindestgröße 1.
    expect(resizeBox(box, 'w', 500, 0, false).width).toBe(1);
  });

  it('dreht um den Mittelpunkt und rastet mit Shift auf 15° ein', () => {
    expect(angleOf({ x: 0, y: 0 }, { x: 0, y: 10 })).toBe(90);
    expect(rotateBy(10, 0, 50, true)).toBe(60);
    expect(rotateBy(0, 170, -170, false)).toBe(20);
    expect(rotateBy(0, 0, 7.26, false)).toBe(7.3);
  });

  it('wählt per Rahmen alle geschnittenen Bounds', () => {
    const nodes = [
      { id: 'a', bounds: { x: 0, y: 0, width: 10, height: 10 } },
      { id: 'b', bounds: { x: 50, y: 50, width: 10, height: 10 } },
      { id: 'c' },
    ];
    expect(marqueeHits(nodes, { x: 5, y: 5, width: 20, height: 20 })).toEqual(['a']);
    expect(marqueeHits(nodes, { x: 70, y: 70, width: -65, height: -65 })).toEqual(['a', 'b']);
    expect(normalizeBox({ x: 10, y: 10, width: -5, height: -5 })).toEqual({ x: 5, y: 5, width: 5, height: 5 });
  });

  it('setzt Maße und Position von Nodes mit width/height (auch mit Skalierung um origin)', () => {
    const node = { id: 'r', type: 'rect', x: 10, y: 20, width: 100, height: 50 };
    expect(resizePatches(node, box, { x: 10, y: 20, width: 120, height: 60 }, 0)).toEqual([
      { op: 'setProperty', nodeId: 'r', property: 'width', value: 120 },
      { op: 'setProperty', nodeId: 'r', property: 'height', value: 60 },
      { op: 'setProperty', nodeId: 'r', property: 'x', value: 10 },
      { op: 'setProperty', nodeId: 'r', property: 'y', value: 20 },
    ]);
    // scale 2 um die Mitte: Welt-Box x = 10 + 0.5·100·(1 − 2) = −40, Breite 200.
    const scaled = { ...node, scale: { x: 2, y: 2 } };
    const r = resizePatches(scaled, { x: -40, y: -5, width: 200, height: 100 }, { x: -40, y: -5, width: 300, height: 100 }, 0);
    expect(r).toContainEqual({ op: 'setProperty', nodeId: 'r', property: 'width', value: 150 });
    expect(r).toContainEqual({ op: 'setProperty', nodeId: 'r', property: 'x', value: 35 });
  });

  it('skaliert Nodes ohne Maße über scale und lehnt gedrehte Nodes ab', () => {
    const text = { id: 't', type: 'text', text: 'Hi', x: 0, y: 0 };
    const r = resizePatches(text, { x: 0, y: 0, width: 40, height: 20 }, { x: 0, y: 0, width: 80, height: 40 }, 0);
    expect(r).toContainEqual({ op: 'setProperty', nodeId: 't', property: 'scale', value: { x: 2, y: 2 } });
    expect(resizeBlocker({ id: 'q', type: 'rect', rotation: 30 })).toBe('rotated');
    expect(typeof resizePatches({ id: 'q', type: 'rect', rotation: 30, width: 1, height: 1 }, box, box, 0)).toBe('string');
    // Keyframes: am lokalen Frame ein Keyframe statt eines festen Werts.
    const keyed = { id: 'k', type: 'rect', x: 0, y: 0, width: { $keyframes: [{ t: 0, v: 10 }, { t: 10, v: 20 }] }, height: 10 };
    const kp = resizePatches(keyed, { x: 0, y: 0, width: 15, height: 10 }, { x: 0, y: 0, width: 30, height: 10 }, 5, (v) => (isRecord(v) ? 15 : v));
    expect(kp).toContainEqual({ op: 'addKeyframe', nodeId: 'k', property: 'width', keyframe: { t: 5, v: 30 } });
  });
});

describe('Story 20.6: Timeline-Werkzeuge', () => {
  it('rastet Frames und Zeitfenster ein', () => {
    expect(snapFrame(48, [0, 50, 90], 3)).toEqual({ frame: 50, target: 50 });
    expect(snapFrame(40, [0, 50], 3)).toEqual({ frame: 40 });
    expect(snapSpan(10, 20, 7, [30], 3)).toEqual({ delta: 10, target: 30 });
    expect(snapSpan(10, 20, 1, [10], 2)).toEqual({ delta: 0, target: 10 });
    const t = timelineSnapTargets({ duration: 100, playhead: 42, markers: [{ frame: 7 }], spans: [{ id: 'a', start: 3, end: 9, keyframes: [5] }, { id: 'b', start: 60, end: 70 }], exclude: 'b', inPoint: 11, outPoint: undefined });
    expect(t.sort((x, y) => x - y)).toEqual([0, 3, 5, 7, 9, 11, 42, 100]);
  });

  it('verschiebt Keyframes, ohne andere zu überschreiben', () => {
    const time = timeInfo({ fps: 10 });
    const v = { $keyframes: [{ t: 0, v: 0 }, { t: 10, v: 1 }, { t: 20, v: 2 }] };
    expect(moveKeyframe(v, 1, 25, time)).toEqual({ $keyframes: [{ t: 0, v: 0 }, { t: 20, v: 2 }, { t: 25, v: 1 }] });
    expect(moveKeyframe(v, 1, 20, time)).toBeUndefined();
    expect(moveKeyframe(5, 0, 1, time)).toBeUndefined();
  });

  it('legt Marker an, benennt sie um und löscht sie nur, wenn niemand sie nutzt', () => {
    const markers = addMarker([{ id: 'marker', time: 0 }], 12.4);
    expect(markers[1]).toEqual({ id: 'marker-2', time: 12 });
    expect(renameMarker(markers, 'marker-2', ' Outro ')[1]).toEqual({ id: 'marker-2', time: 12, label: 'Outro' });
    expect(renameMarker([{ id: 'm', time: 0, label: 'x' }], 'm', '')[0]).toEqual({ id: 'm', time: 0 });
    expect(removeMarker(markers, 'marker', { nodes: [] })).toEqual([{ id: 'marker-2', time: 12 }]);
    expect(typeof removeMarker(markers, 'marker', { nodes: [{ id: 'a', timing: { from: 'marker:marker' } }] })).toBe('string');
  });

  it('J/K/L-Shuttle, Schleife im In/Out-Bereich und Keyframe-Sprung', () => {
    expect([shuttle(0, 'l'), shuttle(1, 'l'), shuttle(8, 'l'), shuttle(2, 'j'), shuttle(-1, 'j'), shuttle(-4, 'k')]).toEqual([1, 2, 8, -1, -2, 0]);
    expect(advanceFrame(99, 1, 100, undefined, undefined)).toBe(0);
    expect(advanceFrame(20, 1, 100, 10, 20)).toBe(10);
    expect(advanceFrame(10, -1, 100, 10, 20)).toBe(20);
    expect(advanceFrame(0, -2, 100, undefined, undefined)).toBe(99);
    expect(keyframeJump([[0, 10], [25]], 10, 1)).toBe(25);
    expect(keyframeJump([[0, 10], [25]], 10, -1)).toBe(0);
    expect(keyframeJump([[0]], 0, -1)).toBeUndefined();
  });
});

describe('Story 20.8: Layout, Zwischenablage, Mehrfachbearbeitung, Suche', () => {
  it('liest gespeicherte Panelgrößen mit Grenzen und klappt schmale Fenster ein', () => {
    expect(defaultLayout(800).collapsed).toEqual({ left: true, right: true, timeline: false, bottom: false });
    expect(defaultLayout(1600).collapsed.left).toBe(false);
    const l = parseLayout('{"sizes":{"left":9999,"right":"x"},"collapsed":{"bottom":true}}', defaultLayout(1600));
    expect(l.sizes.left).toBe(600);
    expect(l.sizes.right).toBe(320);
    expect(l.collapsed.bottom).toBe(true);
    expect(parseLayout('not json', defaultLayout(1600))).toEqual(defaultLayout(1600));
  });

  it('überträgt Nodes als JSON und liest auch einzelne Nodes und Listen', () => {
    const text = clipboardText([{ id: 'box', type: 'rect' }]);
    expect(parseClipboard(text)).toEqual([{ id: 'box', type: 'rect' }]);
    expect(parseClipboard('{"id":"t","type":"text"}')).toEqual([{ id: 't', type: 'text' }]);
    expect(parseClipboard('[{"type":"rect"},{"type":"ellipse"}]')).toHaveLength(2);
    expect(parseClipboard('hello')).toBeUndefined();
    expect(parseClipboard('{"a":1}')).toBeUndefined();
  });

  it('zeigt gemeinsame Felder, gemischte Werte und setzt alle in einem Patch-Satz', () => {
    const fields = commonFields([fieldsFor('rect'), fieldsFor('text')]).map((f) => f.name);
    expect(fields).toContain('x');
    expect(fields).toContain('zIndex');
    expect(fields).not.toContain('text');
    expect(sharedValue([1, 1])).toBe(1);
    expect(sharedValue([1, 2])).toBe(MIXED);
    const r = multiSetPatches(
      [
        { id: 'a', node: { id: 'a', opacity: 1 }, local: 0 },
        { id: 'b', node: { id: 'b', opacity: { $keyframes: [{ t: 0, v: 1 }] } }, local: 4 },
        { id: 'c', node: { id: 'c', opacity: { $expr: 'sin(t)' } }, local: 0 },
      ],
      'opacity',
      0.5,
    );
    expect(r.patches).toEqual([
      { op: 'setProperty', nodeId: 'a', property: 'opacity', value: 0.5 },
      { op: 'addKeyframe', nodeId: 'b', property: 'opacity', keyframe: { t: 4, v: 0.5 } },
    ]);
    expect(r.skipped).toEqual(['c']);
  });

  it('findet Komponenten nach Name und Beschreibung', () => {
    expect(matchesQuery({ name: 'LowerThird', description: 'Name and title bar' }, 'lower title')).toBe(true);
    expect(matchesQuery({ name: 'LowerThird', description: 'Name and title bar' }, 'chart')).toBe(false);
    expect(matchesQuery({ name: 'Sequence', description: 'plays children' }, '')).toBe(true);
  });

  it('der Inspector kennt den Node-Typ sequence', () => {
    expect(fieldsFor('sequence').map((f) => f.name)).toEqual(expect.arrayContaining(['x', 'y', 'between', 'transitions', 'zIndex']));
  });
});
