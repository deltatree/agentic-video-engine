/**
 * Audio (Wellenformen, Clip-Lautstärke), Keyframe-Editor und Kurven-Editor.
 */
import { isRecord } from '@agentic-video/core';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { errorText, fetchFile } from '../api.js';
import { useStudio } from '../context.js';
import { fieldsFor } from '../fields.js';
import { EASINGS, bezierOf, bezierText, findNode, formatFrame, frames, hasKeyframes, timeInfo } from '../ir.js';
import { num, records, str, type Rec } from '../json.js';
import type { Studio } from '../store.js';
import { Field } from './Field.js';

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

function Waveform(props: { projectId: string; src: string; label: string }): ReactNode {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState('Loading waveform…');
  useEffect(() => {
    let cancelled = false;
    const draw = async (): Promise<void> => {
      const bytes = await fetchFile(props.projectId, props.src);
      const ctx = new OfflineAudioContext(1, 1, 44100);
      const audio = await ctx.decodeAudioData(bytes);
      const el = canvas.current;
      if (cancelled || el === null) return;
      const g = el.getContext('2d');
      if (g === null) return;
      const w = el.width;
      const h = el.height;
      const data = audio.getChannelData(0);
      const per = Math.max(1, Math.floor(data.length / w));
      g.clearRect(0, 0, w, h);
      g.fillStyle = '#6FB1FF';
      for (let x = 0; x < w; x++) {
        let peak = 0;
        for (let i = x * per; i < Math.min(data.length, (x + 1) * per); i++) peak = Math.max(peak, Math.abs(data[i] ?? 0));
        const bar = Math.max(1, peak * h);
        g.fillRect(x, (h - bar) / 2, 1, bar);
      }
      setStatus(`${audio.duration.toFixed(2)} s, ${String(audio.numberOfChannels)} channel(s)`);
    };
    draw().catch((error: unknown) => {
      if (!cancelled) setStatus(`No waveform: ${errorText(error)}`);
    });
    return () => {
      cancelled = true;
    };
  }, [props.projectId, props.src]);
  return (
    <figure className="waveform">
      <canvas ref={canvas} width={600} height={60} role="img" aria-label={`Waveform of ${props.label}`} />
      <figcaption className="muted small">{status}</figcaption>
    </figure>
  );
}

/** Der Audio-Tab. */
export function Audio(): ReactNode {
  const [studio, state] = useStudio();
  const tracks = records(state.comp?.['tracks']);
  const audioTracks = tracks.filter((t) => t['kind'] === 'audio');
  if (audioTracks.length === 0) return <p className="empty">This composition has no audio tracks. Add them in the Code panel (compositions[].tracks).</p>;
  const sources = records(state.project?.['audio']);
  const assets = records(state.project?.['assets']);
  const fps = state.timeline?.fps ?? 30;
  const time = timeInfo(state.comp);
  const setClip = (trackId: string, clipId: string, key: string, value: unknown): void => {
    const next = tracks.map((t) =>
      t['id'] !== trackId ? t : { ...t, clips: records(t['clips']).map((c) => (c['id'] === clipId ? (value === null ? Object.fromEntries(Object.entries(c).filter(([k]) => k !== key)) : { ...c, [key]: value }) : c)) },
    );
    void studio.setCompositionProperty('tracks', next);
  };
  return (
    <div className="audio">
      {audioTracks.map((t) => {
        const trackId = str(t['id'], '');
        return (
          <section key={trackId} className="audio-track" aria-label={`Audio track ${trackId}`}>
            <h3>
              {trackId} <span className="muted small">{str(t['role'], 'audio')}</span>
            </h3>
            {records(t['clips']).map((c) => {
              const clipId = str(c['id'], '');
              const source = sources.find((s) => s['id'] === c['source']);
              const asset = assets.find((a) => a['id'] === source?.['asset']);
              const src = str(asset?.['src'], '');
              return (
                <div key={clipId} className="audio-clip">
                  <div className="audio-meta">
                    <strong>{clipId}</strong>
                    <span className="muted small">
                      source {str(c['source'], '?')}, starts at {formatFrame(frames(c['start'], time), fps, 'smpte')}
                    </span>
                    <div className="field">
                      <label className="field-label">volume</label>
                      <Field
                        name="volume"
                        label={`Volume of ${clipId}`}
                        field={isRecord(c['volume']) ? { kind: 'json' } : { kind: 'number', integer: false, min: 0, max: 2 }}
                        value={c['volume'] ?? 1}
                        onCommit={(v) => {
                          setClip(trackId, clipId, 'volume', v);
                        }}
                      />
                      <span className="icon" />
                    </div>
                  </div>
                  {src !== '' ? (
                    <Waveform projectId={state.projectId} src={src} label={clipId} />
                  ) : (
                    <p className="muted small">{isRecord(source?.['voice']) ? 'Generated voice: the audio exists only after rendering, so there is no waveform yet.' : 'The source of this clip has no file.'}</p>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Keyframes
// ---------------------------------------------------------------------------

interface Keyed {
  readonly studio: Studio;
  readonly id: string;
  readonly node: Rec;
  readonly properties: readonly string[];
}

function useKeyed(): Keyed | { readonly message: string } {
  const [studio, state] = useStudio();
  const id = state.selection[0];
  if (id === undefined) return { message: 'Select a node to edit its keyframes.' };
  const node = findNode(state.comp, id)?.node;
  if (node === undefined) return { message: 'Select a node to edit its keyframes.' };
  const properties = Object.entries(node)
    .filter(([, v]) => hasKeyframes(v))
    .map(([k]) => k);
  return { studio, id, node, properties };
}

function PropertyPicker(props: { properties: readonly string[]; value: string; onChange: (p: string) => void }): ReactNode {
  return (
    <label>
      Property{' '}
      <select
        value={props.value}
        onChange={(e) => {
          props.onChange(e.currentTarget.value);
        }}
      >
        {props.properties.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Der Keyframes-Tab: Wert, Zeit und Easing je Keyframe. */
export function Keyframes(): ReactNode {
  const keyed = useKeyed();
  const [, state] = useStudio();
  const [chosen, setChosen] = useState('');
  if ('message' in keyed) return <p className="empty">{keyed.message}</p>;
  if (keyed.properties.length === 0) return <p className="empty">{keyed.id} has no keyframes. Use “Set keyframe” (◆) in the Inspector to add one.</p>;
  const property = keyed.properties.includes(chosen) ? chosen : (keyed.properties[0] ?? '');
  const raw = keyed.node[property];
  if (!hasKeyframes(raw)) return null;
  const list = records(raw['$keyframes']);
  const time = timeInfo(state.comp);
  const spec = fieldsFor(str(keyed.node['type'], '')).find((f) => f.name === property);
  const save = (next: readonly Rec[]): void => {
    void keyed.studio.patch([{ op: 'setProperty', nodeId: keyed.id, property, value: { ...raw, $keyframes: next } }]);
  };
  const item = state.timeline?.nodes.find((n) => n.id === keyed.id);
  const local = Math.max(0, state.frame - (item?.start ?? 0));
  return (
    <div className="keyframes">
      <div className="row-actions">
        <PropertyPicker properties={keyed.properties} value={property} onChange={setChosen} />
        <span className="muted small">Times are frames of the node ({keyed.id} starts at frame {item?.start ?? 0}).</span>
      </div>
      <table className="kf-table">
        <thead>
          <tr>
            <th scope="col">Frame</th>
            <th scope="col">Value</th>
            <th scope="col">Easing (into this key)</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((k, i) => {
            const f = frames(k['t'], time, 0);
            const ease = str(k['ease'], '');
            return (
              <tr key={`${String(f)}-${String(i)}`} className={Math.round(f) === Math.round(local) ? 'current' : ''}>
                <td>
                  <Field
                    name="t"
                    label={`Frame of keyframe ${String(i + 1)}`}
                    field={{ kind: 'number', integer: true, min: 0 }}
                    value={f}
                    onCommit={(v) => {
                      save(list.map((x, j) => (j === i ? { ...x, t: Math.max(0, Math.round(num(v, f))) } : x)).sort((a, b) => frames(a['t'], time) - frames(b['t'], time)));
                    }}
                  />
                </td>
                <td>
                  <Field
                    name="v"
                    label={`Value of keyframe ${String(i + 1)}`}
                    field={spec?.field ?? { kind: 'json' }}
                    value={k['v']}
                    onCommit={(v) => {
                      if (v !== null) save(list.map((x, j) => (j === i ? { ...x, v } : x)));
                    }}
                  />
                </td>
                <td>
                  <select
                    aria-label={`Easing of keyframe ${String(i + 1)}`}
                    value={EASINGS.includes(ease) ? ease : ease === '' ? '' : 'custom'}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      save(list.map((x, j) => (j !== i ? x : v === '' ? Object.fromEntries(Object.entries(x).filter(([key]) => key !== 'ease')) : { ...x, ease: v === 'custom' ? bezierText(bezierOf(ease)) : v })));
                    }}
                  >
                    <option value="">(linear)</option>
                    {EASINGS.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                    <option value="custom">{EASINGS.includes(ease) || ease === '' ? 'custom curve' : ease}</option>
                  </select>
                </td>
                <td>
                  <button
                    type="button"
                    aria-label={`Remove keyframe ${String(i + 1)}`}
                    onClick={() => void keyed.studio.patch([{ op: 'removeKeyframe', nodeId: keyed.id, property, t: k['t'] }])}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

const SIZE = 200;
const PAD = 30;

/** Der Curves-Tab: Bezier-Griffe für das Easing eines Segments. */
export function Curves(): ReactNode {
  const keyed = useKeyed();
  const [, state] = useStudio();
  const [chosen, setChosen] = useState('');
  const [segment, setSegment] = useState(1);
  const [draft, setDraft] = useState<[number, number, number, number] | undefined>(undefined);
  const [dragging, setDragging] = useState<0 | 1 | undefined>(undefined);
  const svg = useRef<SVGSVGElement>(null);
  if ('message' in keyed) return <p className="empty">{keyed.message}</p>;
  const property = keyed.properties.includes(chosen) ? chosen : (keyed.properties[0] ?? '');
  const raw = keyed.node[property];
  const list = hasKeyframes(raw) ? records(raw['$keyframes']) : [];
  if (list.length < 2) return <p className="empty">The curve editor needs a property with at least two keyframes.</p>;
  const time = timeInfo(state.comp);
  const seg = Math.min(Math.max(1, segment), list.length - 1);
  const target = list[seg];
  const from = list[seg - 1];
  const stored = bezierOf(typeof target?.['ease'] === 'string' ? target['ease'] : undefined);
  const b = draft ?? stored;
  const toX = (v: number): number => PAD + v * SIZE;
  const toY = (v: number): number => PAD + (1 - v) * SIZE;
  const apply = (): void => {
    if (!hasKeyframes(raw)) return;
    const next = list.map((k, j) => (j === seg ? { ...k, ease: bezierText(b) } : k));
    setDraft(undefined);
    void keyed.studio.patch([{ op: 'setProperty', nodeId: keyed.id, property, value: { ...raw, $keyframes: next } }]);
  };
  const setHandle = (h: 0 | 1, x: number, y: number): void => {
    const next: [number, number, number, number] = [...b];
    next[h * 2] = Math.round(Math.min(1, Math.max(0, x)) * 1000) / 1000;
    next[h * 2 + 1] = Math.round(Math.min(2, Math.max(-1, y)) * 1000) / 1000;
    setDraft(next);
  };
  const onMove = (e: { readonly clientX: number; readonly clientY: number }): void => {
    if (dragging === undefined || svg.current === null) return;
    const rect = svg.current.getBoundingClientRect();
    const sx = (SIZE + 2 * PAD) / rect.width;
    setHandle(dragging, ((e.clientX - rect.left) * sx - PAD) / SIZE, 1 - ((e.clientY - rect.top) * sx - PAD) / SIZE);
  };
  const onKey = (e: KeyboardEvent, h: 0 | 1): void => {
    const d = e.shiftKey ? 0.1 : 0.01;
    const x = b[h * 2] ?? 0;
    const y = b[h * 2 + 1] ?? 0;
    if (e.key === 'ArrowLeft') setHandle(h, x - d, y);
    else if (e.key === 'ArrowRight') setHandle(h, x + d, y);
    else if (e.key === 'ArrowUp') setHandle(h, x, y + d);
    else if (e.key === 'ArrowDown') setHandle(h, x, y - d);
    else if (e.key === 'Enter') apply();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const path = `M ${String(toX(0))} ${String(toY(0))} C ${String(toX(b[0]))} ${String(toY(b[1]))}, ${String(toX(b[2]))} ${String(toY(b[3]))}, ${String(toX(1))} ${String(toY(1))}`;
  return (
    <div className="curves">
      <div className="row-actions">
        <PropertyPicker
          properties={keyed.properties.filter((p) => records(keyframeList(keyed.node[p])).length >= 2)}
          value={property}
          onChange={(p) => {
            setChosen(p);
            setDraft(undefined);
          }}
        />
        <label>
          Segment{' '}
          <select
            value={seg}
            onChange={(e) => {
              setSegment(Number(e.currentTarget.value));
              setDraft(undefined);
            }}
          >
            {list.slice(1).map((k, i) => (
              <option key={i + 1} value={i + 1}>
                {`${formatFrame(frames(list[i]?.['t'], time), time.fps, 'frames')} → ${formatFrame(frames(k['t'], time), time.fps, 'frames')}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          Preset{' '}
          <select
            value=""
            onChange={(e) => {
              if (e.currentTarget.value !== '') setDraft(bezierOf(e.currentTarget.value));
            }}
          >
            <option value="">choose…</option>
            {['linear', 'ease', 'easeIn', 'easeOut', 'easeInOut', 'easeInCubic', 'easeOutCubic', 'easeInOutCubic'].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="curve-editor">
        <svg
          ref={svg}
          viewBox={`0 0 ${String(SIZE + 2 * PAD)} ${String(SIZE + 2 * PAD)}`}
          className="curve"
          role="group"
          aria-label={`Easing curve from ${String(frames(from?.['t'], time))} to ${String(frames(target?.['t'], time))}`}
          onPointerMove={onMove}
          onPointerUp={() => {
            setDragging(undefined);
          }}
        >
          <rect x={PAD} y={PAD} width={SIZE} height={SIZE} className="curve-box" />
          <line x1={toX(0)} y1={toY(0)} x2={toX(b[0])} y2={toY(b[1])} className="curve-arm" />
          <line x1={toX(1)} y1={toY(1)} x2={toX(b[2])} y2={toY(b[3])} className="curve-arm" />
          <path d={path} className="curve-path" />
          {([0, 1] as const).map((h) => (
            <circle
              key={h}
              cx={toX(b[h * 2] ?? 0)}
              cy={toY(b[h * 2 + 1] ?? 0)}
              r={8}
              className="curve-handle"
              role="slider"
              tabIndex={0}
              aria-label={`Handle ${String(h + 1)} (arrow keys move, Enter applies)`}
              aria-valuetext={`x ${String(b[h * 2])}, y ${String(b[h * 2 + 1])}`}
              aria-valuenow={b[h * 2 + 1]}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                setDragging(h);
              }}
              onPointerMove={(e) => {
                if (dragging === h) onMove(e);
              }}
              onPointerUp={() => {
                setDragging(undefined);
              }}
              onKeyDown={(e) => {
                onKey(e, h);
              }}
            />
          ))}
        </svg>
        <div className="curve-values">
          <code>{bezierText(b)}</code>
          <button type="button" onClick={apply} disabled={draft === undefined}>
            Apply curve
          </button>
          {draft !== undefined && (
            <button
              type="button"
              onClick={() => {
                setDraft(undefined);
              }}
            >
              Reset
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function keyframeList(value: unknown): unknown {
  return isRecord(value) ? value['$keyframes'] : undefined;
}
