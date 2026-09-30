/**
 * Timeline: Zeitlineal (Frames oder SMPTE), Playhead, In/Out-Bereich, Zeitfenster als Balken
 * (verschieben, trimmen, einrasten), ziehbare Keyframe-Rauten, Marker (verschieben, umbenennen, löschen),
 * Audiospuren mit Wellenform (Clips ziehen, trimmen, Fades) und Zoom.
 */
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { audioAssetOf, clipLength, decodeAudio, peaks, planClips, type ClipPlan } from '../audio.js';
import { useStudio } from '../context.js';
import { formatFrame } from '../ir.js';
import { records, str } from '../json.js';
import type { Studio, TimelineNode } from '../store.js';
import { snapFrame, snapSpan, timelineSnapTargets } from '../timeline-logic.js';
import { ASSET_DRAG_TYPE } from './Library.js';

const LABEL = 150;
/** Einrast-Abstand in Bildschirmpixeln. */
const SNAP_PX = 8;

type BarDrag = { readonly id: string; readonly mode: 'move' | 'trimStart' | 'trimEnd'; readonly startX: number; readonly delta: number; readonly snap?: number };
type MarkerDrag = { readonly id: string; readonly startX: number; readonly frame: number; readonly delta: number; readonly snap?: number };
type KeyDrag = { readonly id: string; readonly property: string; readonly index: number; readonly frame: number; readonly startX: number; readonly delta: number; readonly snap?: number };
type ClipDrag = { readonly key: string; readonly mode: 'move' | 'trimStart' | 'trimEnd' | 'fadeIn' | 'fadeOut'; readonly startX: number; readonly delta: number; readonly snap?: number };

function frameStep(ppf: number, fps: number): number {
  const candidates = [1, 2, 5, 10, Math.round(fps / 2), Math.round(fps), Math.round(fps * 2), Math.round(fps * 5), Math.round(fps * 10), Math.round(fps * 30), Math.round(fps * 60)];
  for (const c of candidates) if (c > 0 && c * ppf >= 64) return c;
  return Math.round(fps * 120);
}

/** Dauer (Sekunden) dekodierter Audiodateien je Pfad; `undefined`, solange sie laden. */
function useAudioBuffers(projectId: string, clips: readonly ClipPlan[]): ReadonlyMap<string, AudioBuffer> {
  const [buffers, setBuffers] = useState<ReadonlyMap<string, AudioBuffer>>(new Map());
  const key = [...new Set(clips.map((c) => c.src))].sort().join('\n');
  useEffect(() => {
    let alive = true;
    const srcs = key === '' ? [] : key.split('\n');
    for (const src of srcs) {
      decodeAudio(projectId, src).then(
        (buffer) => {
          if (alive) setBuffers((m) => new Map([...m, [src, buffer]]));
        },
        (error: unknown) => {
          console.warn('OpenVideo Studio: audio not decoded', src, error);
        },
      );
    }
    return () => {
      alive = false;
    };
  }, [projectId, key]);
  return buffers;
}

/** Wellenform eines Clips über seine sichtbare Breite. */
function ClipWave(props: { buffer: AudioBuffer | undefined; offset: number; seconds: number; rate: number; width: number }): ReactNode {
  const canvas = useRef<HTMLCanvasElement>(null);
  const width = Math.max(1, Math.min(4096, Math.round(props.width)));
  useEffect(() => {
    const el = canvas.current;
    const buffer = props.buffer;
    const g = el?.getContext('2d');
    if (el === null || g === null || g === undefined || buffer === undefined) return;
    const data = buffer.getChannelData(0);
    const sr = buffer.sampleRate;
    const from = props.offset * sr;
    const to = from + props.seconds * props.rate * sr;
    const p = peaks(data, width, from, to);
    const h = el.height;
    g.clearRect(0, 0, width, h);
    g.fillStyle = getComputedStyle(el).color;
    for (let x = 0; x < width; x++) {
      const bar = Math.max(1, (p[x] ?? 0) * h);
      g.fillRect(x, (h - bar) / 2, 1, bar);
    }
  }, [props.buffer, props.offset, props.seconds, props.rate, width]);
  return <canvas ref={canvas} className="tl-wave" width={width} height={32} aria-hidden="true" />;
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
  const [keyDrag, setKeyDrag] = useState<KeyDrag | undefined>(undefined);
  const [clipDrag, setClipDrag] = useState<ClipDrag | undefined>(undefined);
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const [dropOver, setDropOver] = useState<string | undefined>(undefined);
  const clips = planClips(state.comp, state.project);
  const buffers = useAudioBuffers(state.projectId, clips);

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
  }, [state.timeline === undefined]);

  // Ctrl/⌘ + Mausrad zoomt die Timeline. React-Wheel-Listener sind passiv; dann zoomt der Browser (Audit §11).
  useEffect(() => {
    const el = body.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setScale((s) => Math.max(0.25, Math.min(64, s * (e.deltaY < 0 ? 1.2 : 1 / 1.2))));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
    };
  }, [state.timeline === undefined]);

  const tl = state.timeline;
  if (tl === undefined) return <p className="empty">{state.status === 'error' ? 'The project could not be loaded.' : 'Loading…'}</p>;
  const duration = Math.max(1, tl.durationFrames);
  const ppf = (Math.max(200, width - LABEL - 24) / duration) * scale;
  const trackWidth = duration * ppf;
  const step = frameStep(ppf, tl.fps);
  const ticks: number[] = [];
  for (let f = 0; f <= duration; f += step) ticks.push(f);
  const selected = new Set(state.selection);
  const threshold = SNAP_PX / ppf;
  const fps = tl.fps;

  const clipSpans = clips.map((c) => {
    const buffer = buffers.get(c.src);
    const len = clipLength(c, buffer?.duration);
    return { id: `clip:${c.trackId}/${c.clipId}`, start: Math.round(c.start * fps), end: Math.round((c.start + (len > 0 ? len : 1)) * fps) };
  });
  const targets = (exclude?: string): number[] =>
    timelineSnapTargets({
      duration,
      playhead: state.frame,
      markers: tl.markers,
      spans: [...tl.nodes.map((n) => ({ id: n.id, start: n.start, end: n.end, keyframes: n.animated.flatMap((a) => a.keyframes) })), ...clipSpans],
      ...(exclude !== undefined ? { exclude } : {}),
      inPoint: state.inPoint,
      outPoint: state.outPoint,
    });

  const scrub = (e: PointerEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    studio.seek((e.clientX - rect.left) / ppf);
  };

  // --- Balken der Nodes -----------------------------------------------------
  const barDown = (e: PointerEvent<HTMLElement>, n: TimelineNode, m: BarDrag['mode']): void => {
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    studio.select([n.id]);
    setBar({ id: n.id, mode: m, startX: e.clientX, delta: 0 });
  };
  const barMove = (e: PointerEvent<HTMLElement>, n: TimelineNode): void => {
    if (bar === undefined) return;
    const raw = Math.round((e.clientX - bar.startX) / ppf);
    if (e.altKey) {
      setBar({ id: bar.id, mode: bar.mode, startX: bar.startX, delta: raw });
      return;
    }
    const t = targets(n.id);
    const s = bar.mode === 'move' ? snapSpan(n.start, n.end, raw, t, threshold) : (() => {
      const edge = bar.mode === 'trimStart' ? n.start : n.end;
      const r = snapFrame(edge + raw, t, threshold);
      return { delta: r.frame - edge, ...(r.target !== undefined ? { target: r.target } : {}) };
    })();
    setBar({ id: bar.id, mode: bar.mode, startX: bar.startX, delta: s.delta, ...(s.target !== undefined ? { snap: s.target } : {}) });
  };
  const barUp = (): void => {
    const b = bar;
    setBar(undefined);
    if (b === undefined || b.delta === 0) return;
    void studio.retime(b.id, b.mode === 'move' ? { move: b.delta } : b.mode === 'trimStart' ? { trimStart: b.delta } : { trimEnd: b.delta });
  };
  const barKey = (e: KeyboardEvent, n: TimelineNode): void => {
    const amount = e.shiftKey ? 10 : 1;
    // [ und ] trimmen den Anfang, Alt + Pfeil das Ende, Pfeile verschieben.
    if (e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}') void studio.retime(n.id, { trimStart: (e.key === '[' || e.key === '{' ? -1 : 1) * amount });
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const d = (e.key === 'ArrowLeft' ? -1 : 1) * amount;
      void studio.retime(n.id, e.altKey ? { trimEnd: d } : { move: d });
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const shown = (n: TimelineNode): { start: number; end: number } => {
    if (bar?.id !== n.id) return { start: n.start, end: n.end };
    if (bar.mode === 'move') return { start: n.start + bar.delta, end: n.end + bar.delta };
    if (bar.mode === 'trimStart') return { start: Math.min(n.end - 1, n.start + bar.delta), end: n.end };
    return { start: n.start, end: Math.max(n.start + 1, n.end + bar.delta) };
  };

  // --- Marker ---------------------------------------------------------------
  const markerUp = (): void => {
    const m = marker;
    setMarker(undefined);
    if (m === undefined) return;
    if (m.delta === 0) studio.seek(m.frame);
    else void studio.moveMarker(m.id, m.frame + m.delta);
  };

  // --- Keyframes ------------------------------------------------------------
  const keyUp = (): void => {
    const k = keyDrag;
    setKeyDrag(undefined);
    if (k === undefined) return;
    if (k.delta === 0) studio.seek(k.frame);
    else void studio.moveKeyframe(k.id, k.property, k.index, k.frame + k.delta);
  };

  // --- Audio ----------------------------------------------------------------
  const tracks = records(state.comp?.['tracks']).filter((t) => t['kind'] === 'audio');
  const onAudioDrop = (e: DragEvent<HTMLElement>, trackId?: string): void => {
    const assetId = audioAssetOf(e.dataTransfer.getData(ASSET_DRAG_TYPE));
    setDropOver(undefined);
    if (assetId === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    const track = e.currentTarget.querySelector('.tl-track') ?? e.currentTarget;
    const rect = track.getBoundingClientRect();
    const raw = Math.max(0, Math.round((e.clientX - rect.left) / ppf));
    const frame = e.altKey ? raw : snapFrame(raw, targets(), threshold).frame;
    void studio.addAudioClip(assetId, frame, trackId);
  };
  const acceptAudio = (e: DragEvent<HTMLElement>, key: string): void => {
    if (!e.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (dropOver !== key) setDropOver(key);
  };

  const snapLine = bar?.snap ?? marker?.snap ?? keyDrag?.snap ?? clipDrag?.snap;
  const inPx = state.inPoint !== undefined ? state.inPoint * ppf : undefined;
  const outPx = state.outPoint !== undefined ? (state.outPoint + 1) * ppf : undefined;

  return (
    <div className="timeline">
      <div className="tl-controls" role="toolbar" aria-label="Timeline controls">
        <button type="button" onClick={() => { studio.togglePlay(); }} aria-label={state.playing ? 'Pause' : 'Play'} aria-pressed={state.playing}>
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
        <button type="button" onClick={() => void studio.addMarker()} title="Add marker at the playhead (M)">
          Add marker
        </button>
        <button type="button" onClick={() => { studio.setRange('in'); }} title="Set in point (I)">
          In
        </button>
        <button type="button" onClick={() => { studio.setRange('out'); }} title="Set out point (O)">
          Out
        </button>
        {(state.inPoint !== undefined || state.outPoint !== undefined) && (
          <button type="button" onClick={() => { studio.setRange('clear'); }} title="Clear in/out (Alt+X)">
            Clear in/out
          </button>
        )}
        <button type="button" aria-label="Zoom timeline out" onClick={() => { setScale(Math.max(0.25, scale / 1.5)); }}>
          −
        </button>
        <button type="button" aria-label="Zoom timeline in" onClick={() => { setScale(Math.min(64, scale * 1.5)); }}>
          +
        </button>
        <span className="muted small">{tl.fps} fps</span>
      </div>
      <div
        className={`tl-body${dropOver === 'new' ? ' drop-over' : ''}`}
        ref={body}
        onDragOver={(e) => {
          acceptAudio(e, 'new');
        }}
        onDragLeave={() => {
          setDropOver(undefined);
        }}
        onDrop={(e) => {
          onAudioDrop(e);
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
            {inPx !== undefined || outPx !== undefined ? <div className="tl-range" style={{ left: `${String(inPx ?? 0)}px`, width: `${String((outPx ?? trackWidth) - (inPx ?? 0))}px` }} aria-hidden="true" /> : null}
            {ticks.map((f) => (
              <span key={f} className="tl-tick" style={{ left: `${String(f * ppf)}px` }}>
                {formatFrame(f, tl.fps, mode)}
              </span>
            ))}
            {tl.markers.map((m) => {
              const f = marker?.id === m.id ? m.frame + marker.delta : m.frame;
              if (renaming === m.id) {
                return (
                  <input
                    key={m.id}
                    className="tl-marker-rename"
                    style={{ left: `${String(f * ppf)}px` }}
                    aria-label={`Label of marker ${m.id}`}
                    defaultValue={m.label === m.id ? '' : m.label}
                    placeholder={m.id}
                    autoFocus
                    onPointerDown={(e) => {
                      e.stopPropagation();
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') setRenaming(undefined);
                    }}
                    onBlur={(e) => {
                      const label = e.currentTarget.value;
                      setRenaming(undefined);
                      if (label !== (m.label === m.id ? '' : m.label)) void studio.renameMarker(m.id, label);
                    }}
                  />
                );
              }
              return (
                <button
                  key={m.id}
                  type="button"
                  className="tl-marker"
                  style={{ left: `${String(f * ppf)}px` }}
                  aria-label={`Marker ${m.label} at ${formatFrame(m.frame, tl.fps, mode)}`}
                  aria-describedby="tl-marker-help"
                  title="Click to jump, drag to move, double-click or F2 to rename, Delete to remove"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setMarker({ id: m.id, startX: e.clientX, frame: m.frame, delta: 0 });
                  }}
                  onPointerMove={(e) => {
                    if (marker?.id !== m.id) return;
                    const raw = Math.round((e.clientX - marker.startX) / ppf);
                    const s: { frame: number; target?: number } = e.altKey ? { frame: m.frame + raw } : snapFrame(m.frame + raw, targets().filter((t) => t !== m.frame), threshold);
                    setMarker({ ...marker, delta: s.frame - m.frame, ...(s.target !== undefined ? { snap: s.target } : {}) });
                  }}
                  onPointerUp={markerUp}
                  onDoubleClick={() => {
                    setRenaming(m.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'F2' || e.key === 'Enter') setRenaming(m.id);
                    else if (e.key === 'Delete' || e.key === 'Backspace') void studio.deleteMarker(m.id);
                    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') void studio.moveMarker(m.id, m.frame + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1));
                    else return;
                    e.preventDefault();
                    e.stopPropagation();
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
                    onPointerMove={(e) => {
                      barMove(e, n);
                    }}
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
                      {a.keyframes.map((f, i) => {
                        const dragging = keyDrag !== undefined && keyDrag.id === n.id && keyDrag.property === a.property && keyDrag.index === i;
                        const at = dragging ? f + keyDrag.delta : f;
                        return (
                          <button
                            key={`${String(f)}-${String(i)}`}
                            type="button"
                            className={`tl-diamond${Math.round(f) === state.frame ? ' on' : ''}${dragging ? ' dragging' : ''}`}
                            style={{ left: `${String(at * ppf)}px` }}
                            aria-label={`Keyframe of ${n.id}.${a.property} at frame ${String(Math.round(f))}`}
                            title="Click to jump, drag or use arrow keys to move"
                            onPointerDown={(e) => {
                              if (a.kind !== 'keyframes') return;
                              e.stopPropagation();
                              e.currentTarget.setPointerCapture(e.pointerId);
                              setKeyDrag({ id: n.id, property: a.property, index: i, frame: Math.round(f), startX: e.clientX, delta: 0 });
                            }}
                            onPointerMove={(e) => {
                              if (!dragging) return;
                              const raw = Math.round((e.clientX - keyDrag.startX) / ppf);
                              const snapTo = targets().filter((t) => t !== keyDrag.frame);
                              const r: { frame: number; target?: number } = e.altKey ? { frame: keyDrag.frame + raw } : snapFrame(keyDrag.frame + raw, snapTo, threshold);
                              const frame = Math.max(n.start, r.frame);
                              setKeyDrag({ ...keyDrag, delta: frame - keyDrag.frame, ...(r.target !== undefined ? { snap: r.target } : {}) });
                            }}
                            onPointerUp={keyUp}
                            onClick={(e) => {
                              // Tastatur-Klick (Enter/Leertaste) springt; Zeiger-Klicks behandelt pointerup.
                              if (e.detail === 0 || a.kind !== 'keyframes') studio.seek(f);
                            }}
                            onKeyDown={(e) => {
                              const d = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
                              if (d === 0 || a.kind !== 'keyframes') return;
                              e.preventDefault();
                              e.stopPropagation();
                              void studio.moveKeyframe(n.id, a.property, i, Math.round(f) + d * (e.shiftKey ? 10 : 1));
                            }}
                          >
                            ◆
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
            </div>
          );
        })}
        {tracks.map((t) => {
          const trackId = str(t['id'], '');
          return (
            <div
              key={trackId}
              className={`tl-row tl-audio-row${dropOver === trackId ? ' drop-over' : ''}`}
              onDragOver={(e) => {
                acceptAudio(e, trackId);
              }}
              onDrop={(e) => {
                onAudioDrop(e, trackId);
              }}
            >
              <div className="tl-label small" title={`Audio track ${trackId}`}>
                ♪ {trackId}
                {t['muted'] === true ? <span className="muted"> (muted)</span> : null}
              </div>
              <div className="tl-track tl-audio-track" style={{ width: `${String(trackWidth)}px` }}>
                {records(t['clips']).map((c) => {
                  const clipId = str(c['id'], '');
                  const plan = clips.find((p) => p.trackId === trackId && p.clipId === clipId);
                  return <AudioClipBar key={clipId} studio={studio} trackId={trackId} clipId={clipId} plan={plan} buffer={plan !== undefined ? buffers.get(plan.src) : undefined} fps={fps} ppf={ppf} drag={clipDrag} setDrag={setClipDrag} snapTargets={targets} threshold={threshold} />;
                })}
              </div>
            </div>
          );
        })}
        <div className="tl-row tl-drop-row">
          <div className="tl-label muted small">{tracks.length === 0 ? 'Audio' : ''}</div>
          <div className="muted small tl-drop-hint">Drop an audio asset here to add a track.</div>
        </div>
        {snapLine !== undefined && <div className="tl-snap" style={{ left: `${String(LABEL + snapLine * ppf)}px` }} aria-hidden="true" />}
        <div className="tl-playhead" style={{ left: `${String(LABEL + state.frame * ppf)}px` }} aria-hidden="true" />
      </div>
      <p id="tl-help" className="sr-only">
        Drag a bar to move the node in time, drag its edges to trim; bars snap to the playhead, markers, keyframes and other bars (hold Alt to turn snapping off). Arrow keys move by one frame, Shift by ten; Alt+arrow changes the end; [ and ] change the start.
      </p>
      <p id="tl-marker-help" className="sr-only">
        Enter or F2 renames the marker, Delete removes it, arrow keys move it.
      </p>
    </div>
  );
}

/** Ein Audio-Clip in der Timeline: ziehen (Start), Kanten trimmen, Fade-Griffe oben in den Ecken. */
function AudioClipBar(props: {
  studio: Studio;
  trackId: string;
  clipId: string;
  plan: ClipPlan | undefined;
  buffer: AudioBuffer | undefined;
  fps: number;
  ppf: number;
  drag: ClipDrag | undefined;
  setDrag: (d: ClipDrag | undefined) => void;
  snapTargets: (exclude?: string) => number[];
  threshold: number;
}): ReactNode {
  const { plan, fps, ppf, drag } = props;
  const key = `clip:${props.trackId}/${props.clipId}`;
  if (plan === undefined) {
    return (
      <div className="tl-clip missing" style={{ left: 0 }} title="This clip has no audio file yet (generated voices exist only after rendering).">
        {props.clipId}
      </div>
    );
  }
  const seconds = clipLength(plan, props.buffer?.duration);
  const lengthFrames = Math.max(1, Math.round((seconds > 0 ? seconds : 1) * fps));
  const start = Math.round(plan.start * fps);
  const fadeIn = Math.round(plan.fadeIn * fps);
  const fadeOut = Math.round(plan.fadeOut * fps);
  const mine = drag?.key === key ? drag : undefined;
  let shownStart = start;
  let shownLength = lengthFrames;
  let shownFadeIn = fadeIn;
  let shownFadeOut = fadeOut;
  if (mine !== undefined) {
    if (mine.mode === 'move') shownStart = start + mine.delta;
    else if (mine.mode === 'trimStart') {
      shownStart = start + mine.delta;
      shownLength = lengthFrames - mine.delta;
    } else if (mine.mode === 'trimEnd') shownLength = lengthFrames + mine.delta;
    else if (mine.mode === 'fadeIn') shownFadeIn = Math.max(0, fadeIn + mine.delta);
    else shownFadeOut = Math.max(0, fadeOut - mine.delta);
  }
  shownLength = Math.max(1, shownLength);
  const down = (e: PointerEvent<HTMLElement>, mode: ClipDrag['mode']): void => {
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    props.setDrag({ key, mode, startX: e.clientX, delta: 0 });
  };
  const move = (e: PointerEvent<HTMLElement>): void => {
    if (mine === undefined) return;
    const raw = Math.round((e.clientX - mine.startX) / ppf);
    if (e.altKey || mine.mode === 'fadeIn' || mine.mode === 'fadeOut') {
      props.setDrag({ key, mode: mine.mode, startX: mine.startX, delta: raw });
      return;
    }
    const t = props.snapTargets(key);
    const s = mine.mode === 'move' ? snapSpan(start, start + lengthFrames, raw, t, props.threshold) : (() => {
      const edge = mine.mode === 'trimStart' ? start : start + lengthFrames;
      const r = snapFrame(edge + raw, t, props.threshold);
      return { delta: r.frame - edge, ...(r.target !== undefined ? { target: r.target } : {}) };
    })();
    props.setDrag({ key, mode: mine.mode, startX: mine.startX, delta: s.delta, ...(s.target !== undefined ? { snap: s.target } : {}) });
  };
  const up = (): void => {
    const d = mine;
    props.setDrag(undefined);
    if (d === undefined || d.delta === 0) return;
    const edit = d.mode === 'move' ? { move: d.delta } : d.mode === 'trimStart' ? { trimStart: d.delta } : d.mode === 'trimEnd' ? { trimEnd: d.delta } : d.mode === 'fadeIn' ? { fadeIn: d.delta } : { fadeOut: -d.delta };
    void props.studio.editAudioClip(props.trackId, props.clipId, edit, lengthFrames);
  };
  const onKey = (e: KeyboardEvent): void => {
    const amount = e.shiftKey ? 10 : 1;
    if (e.key === '[' || e.key === ']' || e.key === '{' || e.key === '}') void props.studio.editAudioClip(props.trackId, props.clipId, { trimStart: (e.key === '[' || e.key === '{' ? -1 : 1) * amount }, lengthFrames);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const d = (e.key === 'ArrowLeft' ? -1 : 1) * amount;
      void props.studio.editAudioClip(props.trackId, props.clipId, e.altKey ? { trimEnd: d } : { move: d }, lengthFrames);
    } else if (e.key === 'Delete' || e.key === 'Backspace') void props.studio.removeAudioClip(props.trackId, props.clipId);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const widthPx = Math.max(6, shownLength * ppf);
  const offsetSeconds = plan.offset + (mine?.mode === 'trimStart' ? (mine.delta / fps) * plan.rate : 0);
  return (
    <div
      className="tl-clip"
      role="button"
      tabIndex={0}
      aria-label={`Audio clip ${props.clipId}: frames ${String(start)} to ${String(start + lengthFrames)}, fade in ${String(fadeIn)}, fade out ${String(fadeOut)}`}
      aria-describedby="tl-help"
      title="Drag to move; drag the edges to trim; drag the top corners to fade. Delete removes the clip."
      style={{ left: `${String(shownStart * ppf)}px`, width: `${String(widthPx)}px` }}
      onPointerDown={(e) => {
        down(e, 'move');
      }}
      onPointerMove={move}
      onPointerUp={up}
      onKeyDown={onKey}
    >
      <ClipWave buffer={props.buffer} offset={offsetSeconds} seconds={shownLength / fps} rate={plan.rate} width={widthPx} />
      <svg className="tl-fades" width={widthPx} height={32} aria-hidden="true">
        {shownFadeIn > 0 && <polygon points={`0,0 ${String(shownFadeIn * ppf)},0 0,32`} />}
        {shownFadeOut > 0 && <polygon points={`${String(widthPx)},0 ${String(widthPx - shownFadeOut * ppf)},0 ${String(widthPx)},32`} />}
      </svg>
      <span className="tl-clip-label">{props.clipId}</span>
      <span
        className="tl-handle start"
        aria-hidden="true"
        onPointerDown={(e) => {
          down(e, 'trimStart');
        }}
      />
      <span
        className="tl-fade-handle in"
        aria-hidden="true"
        style={{ left: `${String(shownFadeIn * ppf)}px` }}
        title="Fade in"
        onPointerDown={(e) => {
          down(e, 'fadeIn');
        }}
      />
      <span
        className="tl-fade-handle out"
        aria-hidden="true"
        style={{ left: `${String(widthPx - shownFadeOut * ppf)}px` }}
        title="Fade out"
        onPointerDown={(e) => {
          down(e, 'fadeOut');
        }}
      />
      <span
        className="tl-handle end"
        aria-hidden="true"
        onPointerDown={(e) => {
          down(e, 'trimEnd');
        }}
      />
    </div>
  );
}
