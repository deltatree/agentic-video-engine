/**
 * Zeiteinheiten (FR-10): Frames, Sekunden, Millisekunden, SMPTE-Timecode und Marker.
 */
import { OpenVideoError, type TimeValue } from '@agentic-video/schema';

/** Kontext für die Umrechnung von Zeitwerten. */
export interface TimeContext {
  /** Bilder pro Sekunde der Composition. */
  readonly fps: number;
  /** Marker-Zeiten in Frames, nach Marker-ID. */
  readonly markers?: ReadonlyMap<string, number>;
}

const UNIT = /^(-?[0-9]+(?:\.[0-9]+)?)(s|ms|f)$/u;
const SMPTE = /^([0-9]{2}):([0-9]{2}):([0-9]{2})([:;])([0-9]{2})$/u;
const MARKER = /^marker:([A-Za-z][A-Za-z0-9_.-]*?)(?:([+-])([0-9]+(?:\.[0-9]+)?)(s|ms|f))?$/u;

function unitToFrames(amount: number, unit: string, fps: number): number {
  switch (unit) {
    case 's':
      return amount * fps;
    case 'ms':
      return (amount / 1000) * fps;
    default:
      return amount;
  }
}

/** Nominale Bildrate für Timecode (29.97 → 30). */
export function nominalFps(fps: number): number {
  return Math.round(fps);
}

/** Prüft, ob eine Bildrate Drop-Frame-Timecode nutzt (29.97, 59.94). */
export function isDropFrameRate(fps: number): boolean {
  return Math.abs(fps - 30000 / 1001) < 0.01 || Math.abs(fps - 60000 / 1001) < 0.01;
}

/**
 * Rechnet SMPTE-Timecode in Frames um. `;` vor den Frames bedeutet Drop-Frame.
 *
 * @example
 * ```ts
 * smpteToFrames('00:00:02:00', 24); // 48
 * smpteToFrames('00:01:00;02', 29.97); // 1800
 * ```
 */
export function smpteToFrames(code: string, fps: number): number {
  const m = SMPTE.exec(code);
  if (m === null) throw timeError(code, 'Invalid SMPTE timecode.');
  const [hh, mm, ss, sep, ff] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4], Number(m[5])];
  const base = nominalFps(fps);
  if (ff >= base) throw timeError(code, `Frame field ${String(ff)} is not below the nominal rate ${String(base)}.`);
  const totalMinutes = hh * 60 + mm;
  let frames = ((totalMinutes * 60 + ss) * base) + ff;
  if (sep === ';') {
    const drop = base === 60 ? 4 : 2;
    frames -= drop * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return frames;
}

/**
 * Formatiert einen Frame als SMPTE-Timecode.
 *
 * @example
 * ```ts
 * framesToSmpte(48, 24); // '00:00:02:00'
 * ```
 */
export function framesToSmpte(frame: number, fps: number, dropFrame: boolean = isDropFrameRate(fps)): string {
  const base = nominalFps(fps);
  let f = Math.max(0, Math.floor(frame));
  if (dropFrame) {
    const drop = base === 60 ? 4 : 2;
    const framesPer10Min = base * 600 - drop * 9;
    const framesPerMin = base * 60 - drop;
    const d = Math.floor(f / framesPer10Min);
    const m = f % framesPer10Min;
    f += drop * 9 * d + (m > drop ? drop * Math.floor((m - drop) / framesPerMin) : 0);
  }
  const ff = f % base;
  const totalSeconds = Math.floor(f / base);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}${dropFrame ? ';' : ':'}${pad(ff)}`;
}

function timeError(value: string, problem: string): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_TIME_INVALID',
    errorClass: 'TimeError',
    problem,
    received: JSON.stringify(value),
    suggestions: ['Use frames (48), seconds ("2s"), milliseconds ("500ms"), timecode ("00:00:02:00") or a marker ("marker:intro+10f").'],
  });
}

/**
 * Rechnet einen Zeitwert in Frames um. Das Ergebnis kann gebrochen sein.
 *
 * @example
 * ```ts
 * toFrames('2s', { fps: 24 }); // 48
 * toFrames('marker:intro+10f', { fps: 30, markers: new Map([['intro', 60]]) }); // 70
 * ```
 */
export function toFrames(value: TimeValue, ctx: TimeContext): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw timeError(String(value), 'Time must be a finite number of frames.');
    return value;
  }
  const unit = UNIT.exec(value);
  if (unit !== null) return unitToFrames(Number(unit[1]), unit[2] ?? 'f', ctx.fps);
  if (SMPTE.test(value)) return smpteToFrames(value, ctx.fps);
  const marker = MARKER.exec(value);
  if (marker !== null) {
    const id = marker[1] ?? '';
    const base = ctx.markers?.get(id);
    if (base === undefined) {
      throw new OpenVideoError({
        code: 'OV_TIME_MARKER',
        errorClass: 'TimeError',
        problem: `Marker "${id}" does not exist.`,
        received: JSON.stringify(value),
        suggestions: [`Add { id: "${id}", time: … } to composition.markers.`],
      });
    }
    if (marker[2] === undefined) return base;
    const offset = unitToFrames(Number(marker[3]), marker[4] ?? 'f', ctx.fps);
    return marker[2] === '-' ? base - offset : base + offset;
  }
  throw timeError(value, 'Unknown time format.');
}

/** Rechnet einen Zeitwert in Sekunden um. */
export function toSeconds(value: TimeValue, ctx: TimeContext): number {
  return toFrames(value, ctx) / ctx.fps;
}

/** Anzahl ganzer Frames einer Dauer (aufgerundet, mindestens 1). */
export function durationInFrames(value: TimeValue, ctx: TimeContext): number {
  return Math.max(1, Math.ceil(toFrames(value, ctx) - 1e-9));
}

/**
 * Löst Marker einer Composition auf. Marker dürfen auf frühere Marker verweisen.
 *
 * @example
 * ```ts
 * resolveMarkers([{ id: 'a', time: '1s' }, { id: 'b', time: 'marker:a+10f' }], 30); // a → 30, b → 40
 * ```
 */
export function resolveMarkers(markers: readonly { readonly id: string; readonly time: TimeValue }[] | undefined, fps: number): Map<string, number> {
  const out = new Map<string, number>();
  const pending = [...(markers ?? [])];
  for (let guard = 0; pending.length > 0 && guard <= pending.length + 1; guard++) {
    for (let i = 0; i < pending.length; i++) {
      const m = pending[i];
      if (m === undefined) continue;
      try {
        out.set(m.id, toFrames(m.time, { fps, markers: out }));
        pending.splice(i, 1);
        i--;
      } catch (error) {
        if (!(error instanceof OpenVideoError) || error.diagnostic.code !== 'OV_TIME_MARKER') throw error;
      }
    }
  }
  const first = pending[0];
  if (first !== undefined) {
    throw new OpenVideoError({
      code: 'OV_TIME_MARKER',
      errorClass: 'TimeError',
      problem: `Marker "${first.id}" cannot be resolved (unknown or circular reference).`,
      suggestions: ['Check the marker references in composition.markers.'],
    });
  }
  return out;
}
