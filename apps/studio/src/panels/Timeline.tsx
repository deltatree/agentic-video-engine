/**
 * Timeline: Zeitlineal (Frames oder SMPTE), Playhead, Zeitfenster als Balken (verschieben, trimmen),
 * Keyframe-Rauten, Marker und Zoom.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useStudio } from '../context.js';
import { formatFrame } from '../ir.js';
import type { TimelineNode } from '../store.js';

const LABEL = 150;

type BarDrag = { readonly id: string; readonly mode: 'move' | 'trimStart' | 'trimEnd'; readonly startX: number; readonly delta: number };
type MarkerDrag = { readonly id: string; readonly startX: number; readonly frame: number; readonly delta: number };

function frameStep(ppf: number, fps: number): number {
  const candidates = [1, 2, 5, 10, Math.round(fps / 2), Math.round(fps), Math.round(fps * 2), Math.round(fps * 5), Math.round(fps * 10), Math.round(fps * 30), Math.round(fps * 60)];
  for (const c of candidates) if (c > 0 && c * ppf >= 64) return c;
  return Math.round(fps * 120);
}

/** Der Timeline-Tab. */
export function Timeline(): ReactNode {
  const [studio, state] = useStudio();
  const body = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [scale, setScale] = useState(1);
  const [mode, setMode] = useState<'frames' | 'smpte'>('frames');
  const [bar, setBar] = useState<BarDrag | undefined>(undefined);
  const [marker, setMarker] = useState<MarkerDrag | undefined>(undefined);

  useLayoutEffect(() => {
    const el = body.current;
    if (el === null) return;
    const observer = new ResizeObserver(() => {
      setWidth(el.clientWidth);
    });
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => {
      observer.disconnect();
    };
  }, []);

  const tl = state.timeline;
  if (tl === undefined) return <p className="empty">Loading…</p>;
  const duration = Math.max(1, tl.durationFrames);
  const ppf = (Math.max(200, width - LABEL - 24) / duration) * scale;
  const trackWidth = duration * ppf;
  const step = frameStep(ppf, tl.fps);
  const ticks: number[] = [];
  for (let f = 0; f <= duration; f += step) ticks.push(f);
  const selected = new Set(state.selection);

  const scrub = (e: PointerEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    studio.seek((e.clientX - rect.left) / ppf);
  };

  const barDown = (e: PointerEvent<HTMLElement>, n: TimelineNode, m: BarDrag['mode']): void => {
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    studio.select([n.id]);
    setBar({ id: n.id, mode: m, startX: e.clientX, delta: 0 });
  };
  const barMove = (e: PointerEvent<HTMLElement>): void => {
    if (bar !== undefined) setBar({ ...bar, delta: Math.round((e.clientX - bar.startX) / ppf) });
  };
  const barUp = (): void => {
    const b = bar;
    setBar(undefined);
    if (b === undefined || b.delta === 0) return;
    void studio.retime(b.id, b.mode === 'move' ? { move: b.delta } : b.mode === 'trimStart' ? { trimStart: b.delta } : { trimEnd: b.delta });
  };
  const barKey = (e: KeyboardEvent, n: TimelineNode): void => {
    const d = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (d === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const amount = d * (e.shiftKey ? 10 : 1);
    void studio.retime(n.id, e.altKey ? { trimEnd: amount } : { move: amount });
  };

  const markerUp = (): void => {
    const m = marker;
    setMarker(undefined);
    if (m === undefined) return;
    if (m.delta === 0) studio.seek(m.frame);
    else void studio.moveMarker(m.id, m.frame + m.delta);
  };

  const shown = (n: TimelineNode): { start: number; end: number } => {
    if (bar?.id !== n.id) return { start: n.start, end: n.end };
    if (bar.mode === 'move') return { start: n.start + bar.delta, end: n.end + bar.delta };
    if (bar.mode === 'trimStart') return { start: Math.min(n.end - 1, n.start + bar.delta), end: n.end };
    return { start: n.start, end: Math.max(n.start + 1, n.end + bar.delta) };
  };

  return (
    <div className="timeline">
      <div className="tl-controls" role="toolbar" aria-label="Timeline controls">
        <button type="button" onClick={() => { studio.togglePlay(); }} aria-label={state.playing ? 'Pause' : 'Play'}>
          {state.playing ? '❚❚' : '▶'}
        </button>
        <span className="timecode" aria-live="off">
          {formatFrame(state.frame, tl.fps, mode)} / {formatFrame(duration, tl.fps, mode)}
        </span>
        <label>
          Time{' '}
          <select value={mode} onChange={(e) => { setMode(e.currentTarget.value === 'smpte' ? 'smpte' : 'frames'); }}>
            <option value="frames">Frames</option>
            <option value="smpte">Timecode</option>
          </select>
        </label>
        <button type="button" onClick={() => void studio.addMarker()}>
          Add marker
        </button>
        <button type="button" aria-label="Zoom timeline out" onClick={() => { setScale(Math.max(0.25, scale / 1.5)); }}>
          −
        </button>
        <button type="button" aria-label="Zoom timeline in" onClick={() => { setScale(Math.min(64, scale * 1.5)); }}>
          +
        </button>
        <span className="muted small">{tl.fps} fps</span>
      </div>
      <div
        className="tl-body"
        ref={body}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) setScale(Math.max(0.25, Math.min(64, scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2))));
        }}
      >
        <div className="tl-row tl-ruler-row">
          <div className="tl-label muted small">{tl.markers.length > 0 ? 'Markers' : ''}</div>
          <div
            className="tl-ruler"
            style={{ width: `${String(trackWidth)}px` }}
            role="slider"
            aria-label="Playhead"
            aria-valuemin={0}
            aria-valuemax={duration - 1}
            aria-valuenow={state.frame}
            aria-valuetext={formatFrame(state.frame, tl.fps, 'smpte')}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Home') studio.seek(0);
              else if (e.key === 'End') studio.seek(duration - 1);
              else return;
              e.preventDefault();
            }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              scrub(e);
            }}
            onPointerMove={(e) => {
              if (e.buttons === 1) scrub(e);
            }}
          >
            {ticks.map((f) => (
              <span key={f} className="tl-tick" style={{ left: `${String(f * ppf)}px` }}>
                {formatFrame(f, tl.fps, mode)}
              </span>
            ))}
            {tl.markers.map((m) => {
              const f = marker?.id === m.id ? m.frame + marker.delta : m.frame;
              return (
                <button
                  key={m.id}
                  type="button"
                  className="tl-marker"
                  style={{ left: `${String(f * ppf)}px` }}
                  aria-label={`Marker ${m.id} at ${formatFrame(m.frame, tl.fps, mode)}`}
                  title="Click to jump, drag to move, arrow keys to nudge"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setMarker({ id: m.id, startX: e.clientX, frame: m.frame, delta: 0 });
                  }}
                  onPointerMove={(e) => {
                    if (marker?.id === m.id) setMarker({ ...marker, delta: Math.round((e.clientX - marker.startX) / ppf) });
                  }}
                  onPointerUp={markerUp}
                  onKeyDown={(e) => {
                    const d = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
                    if (d === 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    void studio.moveMarker(m.id, m.frame + d * (e.shiftKey ? 10 : 1));
                  }}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>
        {tl.nodes.map((n) => {
          const s = shown(n);
          const isSel = selected.has(n.id);
          return (
            <div key={n.id}>
              <div className={`tl-row${isSel ? ' selected' : ''}`}>
                <button
                  type="button"
                  className="tl-label"
                  style={{ paddingLeft: `${String(6 + n.depth * 12)}px` }}
                  onClick={(e) => {
                    studio.select([n.id], e.ctrlKey || e.metaKey || e.shiftKey ? 'toggle' : 'replace');
                  }}
                >
                  {n.id}
                </button>
                <div className="tl-track" style={{ width: `${String(trackWidth)}px` }}>
                  <div
                    className={`tl-bar${isSel ? ' selected' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`Timing of ${n.id}: frames ${String(n.start)} to ${String(n.end)}`}
                    aria-describedby="tl-help"
                    style={{ left: `${String(s.start * ppf)}px`, width: `${String(Math.max(4, (s.end - s.start) * ppf))}px` }}
                    onPointerDown={(e) => {
                      barDown(e, n, 'move');
                    }}
                    onPointerMove={barMove}
                    onPointerUp={barUp}
                    onKeyDown={(e) => {
                      barKey(e, n);
                    }}
                  >
                    <span
                      className="tl-handle start"
                      aria-hidden="true"
                      onPointerDown={(e) => {
                        barDown(e, n, 'trimStart');
                      }}
                    />
                    <span className="tl-bar-label">{n.type}</span>
                    <span
                      className="tl-handle end"
                      aria-hidden="true"
                      onPointerDown={(e) => {
                        barDown(e, n, 'trimEnd');
                      }}
                    />
                  </div>
                </div>
              </div>
              {isSel &&
                n.animated.map((a) => (
                  <div className="tl-row tl-kf-row" key={a.property}>
                    <div className="tl-label muted small" style={{ paddingLeft: `${String(18 + n.depth * 12)}px` }}>
                      {a.property}
                      {a.kind !== 'keyframes' ? ` (${a.kind})` : ''}
                    </div>
                    <div className="tl-track" style={{ width: `${String(trackWidth)}px` }}>
                      {a.keyframes.map((f, i) => (
                        <button
                          key={`${String(f)}-${String(i)}`}
                          type="button"
                          className={`tl-diamond${Math.round(f) === state.frame ? ' on' : ''}`}
                          style={{ left: `${String(f * ppf)}px` }}
                          aria-label={`Keyframe of ${n.id}.${a.property} at frame ${String(Math.round(f))}`}
                          onClick={() => {
                            studio.seek(f);
                          }}
                        >
                          ◆
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          );
        })}
        <div className="tl-playhead" style={{ left: `${String(LABEL + state.frame * ppf)}px` }} aria-hidden="true" />
      </div>
      <p id="tl-help" className="sr-only">
        Drag a bar to move the node in time, drag its edges to trim. Arrow keys move by one frame, Shift by ten, Alt changes the end.
      </p>
    </div>
  );
}
