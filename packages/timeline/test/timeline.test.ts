import { describe, expect, it } from 'vitest';
import {
  EASINGS,
  animate,
  addTime,
  computeLocalTime,
  cubicBezier,
  easing,
  evaluateAnimated,
  evaluateExpression,
  formatColor,
  framesToSmpte,
  hash32,
  interpolate,
  keyframes,
  linearToRec709,
  linearToSrgb,
  noise1,
  parseColor,
  pathsCompatible,
  rec709ToLinear,
  resolveMarkers,
  sequence,
  smpteToFrames,
  spring,
  springProgress,
  springSettleTime,
  srgbToLinear,
  stagger,
  steps,
  toFrames,
  wiggle,
  type AnimationContext,
} from '@agentic-video/timeline';
import { OpenVideoError } from '@agentic-video/schema';

const ctx = (frame: number, extra: Partial<AnimationContext> = {}): AnimationContext => ({ frame, fps: 30, seed: 1, durationFrames: 300, ...extra });

describe('Zeiteinheiten (FR-10)', () => {
  it('rechnet alle Einheiten bei 24 fps auf Frame 48 um', () => {
    for (const v of ['2s', '2000ms', 48, '48f', '00:00:02:00'] as const) expect(toFrames(v, { fps: 24 })).toBe(48);
  });

  it('löst Marker mit Versatz auf', () => {
    const markers = resolveMarkers([{ id: 'intro', time: '2s' }, { id: 'b', time: 'marker:intro+10f' }], 30);
    expect(markers.get('b')).toBe(70);
    expect(toFrames('marker:intro-0.5s', { fps: 30, markers })).toBe(45);
  });

  it('meldet unbekannte Marker und Formate', () => {
    expect(() => toFrames('marker:nope', { fps: 30 })).toThrow(OpenVideoError);
    expect(() => toFrames('2 seconds', { fps: 30 })).toThrow(/Unknown time format/u);
  });

  it('beherrscht Drop-Frame-Timecode hin und zurück', () => {
    expect(smpteToFrames('00:01:00;02', 30000 / 1001)).toBe(1800);
    expect(framesToSmpte(1800, 30000 / 1001)).toBe('00:01:00;02');
    for (let f = 0; f < 20000; f += 997) expect(smpteToFrames(framesToSmpte(f, 29.97), 29.97)).toBe(f);
    expect(framesToSmpte(48, 24)).toBe('00:00:02:00');
  });
});

describe('Easing (FR-11)', () => {
  it('bildet 0 auf 0 und 1 auf 1 ab', () => {
    for (const [name, fn] of Object.entries(EASINGS)) {
      if (name === 'hold') continue;
      expect(fn(0), name).toBeCloseTo(0, 6);
      expect(fn(1), name).toBeCloseTo(1, 6);
    }
  });

  it('entspricht CSS cubic-bezier', () => {
    expect(cubicBezier(0.25, 0.1, 0.25, 1)(0.5)).toBeCloseTo(0.8024, 3);
    expect(easing('ease')(0.5)).toBeCloseTo(0.8024, 3);
    expect(easing('cubic-bezier(0,0,1,1)')(0.37)).toBeCloseTo(0.37, 5);
  });

  it('kennt steps und spring', () => {
    expect(steps(4)(0.3)).toBe(0.25);
    expect(steps(4, 'start')(0.3)).toBe(0.5);
    expect(easing('spring(170, 26)')(1)).toBe(1);
    expect(() => easing('wobble')).toThrow(OpenVideoError);
  });
});

describe('Spring', () => {
  it('startet bei 0 und erreicht das Ziel', () => {
    expect(springProgress(0)).toBe(0);
    expect(springProgress(5, { stiffness: 170, damping: 26 })).toBeCloseTo(1, 4);
    expect(springProgress(10, { stiffness: 100, damping: 20 })).toBeCloseTo(1, 4);
    expect(springProgress(10, { stiffness: 100, damping: 40 })).toBeCloseTo(1, 3);
  });

  it('schwingt bei geringer Dämpfung über', () => {
    let max = 0;
    for (let t = 0; t < 3; t += 0.01) max = Math.max(max, springProgress(t, { stiffness: 200, damping: 5 }));
    expect(max).toBeGreaterThan(1.2);
    expect(springSettleTime({ stiffness: 200, damping: 5 })).toBeGreaterThan(1);
  });
});

describe('Interpolation', () => {
  it('interpoliert Farben, Vektoren und Objekte', () => {
    expect(interpolate('#000000', '#FFFFFF', 0.5)).toBe('#808080');
    expect(interpolate([0, 0, 0], [10, 20, 30], 0.1)).toEqual([1, 2, 3]);
    expect(interpolate({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5)).toEqual({ x: 5, y: 10 });
    expect(interpolate('a', 'b', 0.99)).toBe('a');
    expect(interpolate('a', 'b', 1)).toBe('b');
  });

  it('morpht Pfade mit gleicher Struktur', () => {
    expect(pathsCompatible('M0 0 L10 10', 'M10 10 L20 20')).toBe(true);
    expect(interpolate('M0 0 L10 10', 'M10 10 L20 20', 0.5)).toBe('M 5 5 L 15 15');
    expect(interpolate('M0 0 L10 10', 'M0 0 C1 1 2 2 3 3', 0.5)).toBe('M0 0 L10 10');
  });
});

describe('Keyframes', () => {
  const kf = keyframes([{ t: 0, v: 0 }, { t: 30, v: 100 }]);

  it('trifft Keyframes und interpoliert linear', () => {
    expect(evaluateAnimated(kf, ctx(0))).toBe(0);
    expect(evaluateAnimated(kf, ctx(15))).toBe(50);
    expect(evaluateAnimated(kf, ctx(30))).toBe(100);
    expect(evaluateAnimated(kf, ctx(-5))).toBe(0);
    expect(evaluateAnimated(kf, ctx(99))).toBe(100);
  });

  it('wendet Easing auf das zulaufende Segment an', () => {
    const eased = animate(0, 100, { from: 0, to: '1s', ease: 'easeOutCubic' });
    expect(evaluateAnimated(eased, ctx(15))).toBeCloseTo(87.5, 6);
  });

  it('beherrscht Loop, Ping-Pong, Repeat und Delay', () => {
    const loop = keyframes([{ t: 0, v: 0 }, { t: 10, v: 10 }], { loop: 'repeat' });
    expect(evaluateAnimated(loop, ctx(13))).toBe(3);
    const pp = keyframes([{ t: 0, v: 0 }, { t: 10, v: 10 }], { loop: 'pingpong' });
    expect(evaluateAnimated(pp, ctx(13))).toBe(7);
    const rep = keyframes([{ t: 0, v: 0 }, { t: 10, v: 10 }], { loop: 'repeat', repeat: 2 });
    expect(evaluateAnimated(rep, ctx(25))).toBe(10);
    const delayed = keyframes([{ t: 0, v: 0 }, { t: 10, v: 10 }], { delay: 5 });
    expect(evaluateAnimated(delayed, ctx(10))).toBe(5);
  });

  it('löst Marker in Keyframes relativ zur Node auf', () => {
    const markers = new Map([['beat', 40]]);
    const v = keyframes([{ t: 0, v: 0 }, { t: 'marker:beat', v: 10 }]);
    // Node startet bei Composition-Frame 20 → Marker liegt lokal bei 20.
    expect(evaluateAnimated(v, ctx(10, { markers, markerOffset: 20 }))).toBe(5);
  });

  it('interpoliert $sampled und hält Randwerte', () => {
    const s = { $sampled: { start: 10, values: [0, 10, 20] } };
    expect(evaluateAnimated(s, ctx(5))).toBe(0);
    expect(evaluateAnimated(s, ctx(11))).toBe(10);
    expect(evaluateAnimated(s, ctx(11.5))).toBe(15);
    expect(evaluateAnimated(s, ctx(50))).toBe(20);
  });

  it('wertet Springs, Refs und verschachtelte Objekte aus', () => {
    expect(evaluateAnimated(spring({ from: 0, to: 1, at: 10 }), ctx(10))).toBe(0);
    expect(evaluateAnimated({ $ref: 'theme.colors.a' }, ctx(0, { resolveRef: () => '#FF0000' }))).toBe('#FF0000');
    expect(evaluateAnimated({ x: kf, y: 2 }, ctx(15))).toEqual({ x: 50, y: 2 });
  });
});

describe('Expressions (FR-12)', () => {
  const scope = { frame: 7, time: 0.25, fps: 30, seed: 3, duration: 5, progress: 0.05 };

  it('rechnet mit Funktionen, Vektoren und Ternary', () => {
    expect(evaluateExpression('sin(time * 2) * 40', scope)).toBeCloseTo(Math.sin(0.5) * 40, 10);
    expect(evaluateExpression('-2 ** 2', scope)).toBe(-4);
    expect(evaluateExpression('2 ** 3 ** 2', scope)).toBe(512);
    expect(evaluateExpression('[1, 2] * 2 + [1, 1]', scope)).toEqual([3, 5]);
    expect(evaluateExpression('frame > 5 ? 1 : 0', scope)).toBe(1);
    expect(evaluateExpression('clamp(lerp(0, 10, 0.5), 0, 4)', scope)).toBe(4);
    expect(evaluateExpression('ease("easeInOutCubic", 0.5)', scope)).toBeCloseTo(0.5);
    expect(evaluateExpression('[1,2,3][1]', scope)).toBe(2);
  });

  it('ist deterministisch für Zufall und Rauschen', () => {
    expect(evaluateExpression('random(1)', scope)).toBe(evaluateExpression('random(1)', scope));
    expect(evaluateExpression('noise(time)', scope)).toBe(noise1(3, 0.25));
    expect(evaluateExpression('wiggle(2, 10)', scope)).toBe(wiggle(3, 0.25, 2, 10));
  });

  it('lehnt unsichere oder unbekannte Konstrukte ab', () => {
    for (const bad of ['constructor', 'this', 'process.exit(1)', 'alert(1)', 'x = 1', 'a.b', 'foo()', '1 +']) {
      expect(() => evaluateExpression(bad, scope), bad).toThrow(OpenVideoError);
    }
  });

  it('liest Marker in Sekunden', () => {
    expect(evaluateAnimated({ $expr: 'marker("m")' }, ctx(0, { markers: new Map([['m', 60]]) }))).toBe(2);
  });
});

describe('Zufall', () => {
  it('ist zustandslos und seed-abhängig', () => {
    expect(hash32(1, 'a', 2)).toBe(hash32(1, 'a', 2));
    expect(hash32(1, 'a', 2)).not.toBe(hash32(2, 'a', 2));
    expect(Math.abs(noise1(1, 3))).toBeLessThan(1e-9);
  });
});

describe('Farbe (A39)', () => {
  it('parst und formatiert Farben', () => {
    expect(parseColor('#F80')).toEqual(parseColor('#FF8800'));
    expect(formatColor(parseColor('#12345678'))).toBe('#12345678');
    expect(formatColor(parseColor('#123456'))).toBe('#123456');
  });

  it('kehrt Transferfunktionen um', () => {
    for (let v = 0; v <= 1; v += 0.05) {
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 9);
      expect(rec709ToLinear(linearToRec709(v))).toBeCloseTo(v, 6);
    }
  });
});

describe('Node-Zeit (FR-13, FR-16)', () => {
  const base = { fps: 30, seed: 0, parentStart: 0, parentDuration: 300 };

  it('berechnet Zeitfenster und Time Stretch', () => {
    const t = computeLocalTime({ from: '1s', duration: '2s', speed: 2 }, 45, base);
    expect(t).toMatchObject({ active: true, relFrame: 15, localFrame: 30, durationFrames: 60, progress: 0.25, startFrame: 30 });
    expect(computeLocalTime({ from: 30, duration: 60 }, 29, base).active).toBe(false);
    expect(computeLocalTime({ from: 30, duration: 60 }, 90, base).active).toBe(false);
  });

  it('unterstützt Loop, Ping-Pong, Reverse, Hold und Remap', () => {
    expect(computeLocalTime({ loop: 'infinite', loopDuration: 10 }, 23, base).localFrame).toBe(3);
    expect(computeLocalTime({ loop: 'infinite', loopDuration: 10, pingPong: true }, 13, base).localFrame).toBe(7);
    expect(computeLocalTime({ loop: 2, loopDuration: 10 }, 25, base).localFrame).toBe(10);
    expect(computeLocalTime({ duration: 10, reverse: true }, 0, base).localFrame).toBe(9);
    expect(computeLocalTime({ duration: 10, reverse: true }, 9, base).localFrame).toBe(0);
    expect(computeLocalTime({ hold: 12 }, 100, base).localFrame).toBe(12);
    const remap = { $keyframes: [{ t: 0, v: 0 }, { t: 30, v: 2 }] };
    expect(computeLocalTime({ remap }, 15, base).localFrame).toBe(30);
  });
});

describe('Builder', () => {
  it('erzeugt Sequenzen, Stagger und Zeitsummen', () => {
    expect(stagger(3, 5, 10)).toEqual([10, 15, 20]);
    expect(sequence([90, 120, 60], { overlap: 15 })).toEqual([0, 75, 180]);
    expect(addTime('1s', '500ms')).toBe('1.5s');
    expect(addTime(10, 5)).toBe(15);
    expect(addTime('marker:a', '1s')).toBe('marker:a+1s');
  });
});
