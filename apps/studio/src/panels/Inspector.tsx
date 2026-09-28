/**
 * Inspector, Properties und Effects: Felder aus dem JSON Schema des Node-Typs.
 * Animierte Werte zeigen ein Keyframe-Symbol; „Set keyframe“ legt am aktuellen Frame einen Keyframe an.
 */
import { isAnimated, isRecord } from '@agentic-video/core';
import type { ReactNode } from 'react';
import { useStudio } from '../context.js';
import { describeSchema, fieldsFor, objectFields, propertySchema, unionBranches, type FieldSpec } from '../fields.js';
import { findNode, frames, hasKeyframes, timeInfo, valueAt } from '../ir.js';
import { num, rec, records, str, type Rec } from '../json.js';
import type { Studio, StudioState } from '../store.js';
import { Field } from './Field.js';

/** Standardwert, wenn eine Property noch nicht gesetzt ist (für den ersten Keyframe). */
function defaultValue(spec: FieldSpec): unknown {
  if (spec.name === 'opacity') return 1;
  if (spec.name === 'scale') return { x: 1, y: 1 };
  if (spec.name === 'origin') return { x: 0.5, y: 0.5 };
  switch (spec.field.kind) {
    case 'number':
      return spec.field.min !== undefined && spec.field.min > 0 ? spec.field.min : 0;
    case 'color':
      return '#FFFFFF';
    case 'vec2':
      return { x: 0, y: 0 };
    case 'boolean':
      return true;
    default:
      return '';
  }
}

interface NodeContext {
  readonly id: string;
  readonly node: Rec;
  readonly local: number;
  readonly duration: number;
  readonly fps: number;
}

function nodeContext(studio: Studio, state: StudioState): NodeContext | undefined {
  const id = state.selection[0];
  if (id === undefined) return undefined;
  const node = findNode(state.comp, id)?.node;
  if (node === undefined) return undefined;
  const item = state.timeline?.nodes.find((n) => n.id === id);
  return { id, node, local: studio.localFrame(id), duration: item !== undefined ? item.end - item.start : studio.durationFrames, fps: state.timeline?.fps ?? 30 };
}

function PropertyRow(props: { spec: FieldSpec; ctx: NodeContext; studio: Studio; comp: Rec | undefined }): ReactNode {
  const { spec, ctx, studio } = props;
  const raw = ctx.node[spec.name];
  const animated = isAnimated(raw);
  const keyed = hasKeyframes(raw);
  const time = timeInfo(props.comp);
  const atFrame = keyed && records(raw['$keyframes']).some((k) => Math.round(frames(k['t'], time, -1)) === ctx.local);
  // Nicht gesetzte Sichtbarkeit bedeutet sichtbar.
  const current = valueAt(raw, ctx.local, ctx.fps, ctx.duration) ?? (spec.name === 'visible' ? true : undefined);
  const editable = !animated || keyed;
  const commit = (value: unknown): void => {
    if (keyed) {
      if (value !== null) void studio.patch([{ op: 'addKeyframe', nodeId: ctx.id, property: spec.name, keyframe: { t: ctx.local, v: value } }]);
      return;
    }
    void studio.patch([{ op: 'setProperty', nodeId: ctx.id, property: spec.name, value }]);
  };
  const setKeyframe = (): void => {
    void studio.patch([{ op: 'addKeyframe', nodeId: ctx.id, property: spec.name, keyframe: { t: ctx.local, v: current ?? defaultValue(spec) } }]);
  };
  return (
    <div className="field" title={spec.description}>
      <label className="field-label">
        {spec.name}
        {animated && (
          <span className={`kf-indicator${atFrame ? ' on' : ''}`} aria-label={atFrame ? 'keyframe at this frame' : keyed ? 'animated with keyframes' : `animated (${Object.keys(rec(raw)).join(', ')})`}>
            {atFrame ? '◆' : '◇'}
          </span>
        )}
      </label>
      <Field name={spec.name} field={spec.field} value={current} onCommit={commit} disabled={!editable} />
      {spec.animatable && (!animated || keyed) ? (
        <button type="button" className="icon kf-button" aria-label={`Set keyframe: ${spec.name}`} title={`Set keyframe at frame ${String(ctx.local)}`} onClick={setKeyframe}>
          ◆
        </button>
      ) : (
        <span className="icon" />
      )}
    </div>
  );
}

const COMPOSITION_FIELDS: readonly FieldSpec[] = [
  { name: 'name', description: '', animatable: false, field: { kind: 'text' } },
  { name: 'width', description: '', animatable: false, field: { kind: 'number', integer: true, min: 1, max: 7680 } },
  { name: 'height', description: '', animatable: false, field: { kind: 'number', integer: true, min: 1, max: 4320 } },
  { name: 'fps', description: '', animatable: false, field: { kind: 'number', integer: false, min: 1, max: 120 } },
  { name: 'duration', description: 'Frames, or a time like "10s".', animatable: false, field: { kind: 'json' } },
  { name: 'background', description: '', animatable: false, field: { kind: 'color' } },
];

/** Der Inspector-Tab (Übersicht der Auswahl) und der Properties-Tab (alle Felder). */
export function Inspector(props: { mode: 'inspector' | 'properties' }): ReactNode {
  const [studio, state] = useStudio();
  const ctx = nodeContext(studio, state);
  if (ctx === undefined) {
    const comp = state.comp;
    if (comp === undefined) return <p className="empty">Loading…</p>;
    return (
      <div className="inspector">
        <h3>Composition {str(comp['id'], '')}</h3>
        {COMPOSITION_FIELDS.map((spec) => (
          <div className="field" key={spec.name}>
            <label className="field-label">{spec.name}</label>
            <Field name={spec.name} field={spec.field} value={comp[spec.name]} onCommit={(v) => void studio.setCompositionProperty(spec.name, v)} />
            <span className="icon" />
          </div>
        ))}
        <p className="hint small">Select a node on the stage or in the Scene Tree to edit it.</p>
      </div>
    );
  }
  const type = str(ctx.node['type'], '');
  const all = fieldsFor(type);
  // Inspector: gesetzte und häufige Felder; Properties: alle Felder des Schemas.
  const common = new Set(['name', 'x', 'y', 'width', 'height', 'rotation', 'scale', 'opacity', 'fill', 'text', 'fontSize', 'fontFamily', 'fontWeight', 'textAlign', 'visible', 'component', 'props', 'asset']);
  const shown = props.mode === 'properties' ? all : all.filter((f) => common.has(f.name) || ctx.node[f.name] !== undefined);
  return (
    <div className="inspector">
      <h3>
        {ctx.id} <span className="muted small">{type}</span>
      </h3>
      {state.selection.length > 1 && <p className="hint small">{state.selection.length} nodes selected; editing {ctx.id}.</p>}
      <p className="muted small">Frame {state.frame} (local {ctx.local})</p>
      {shown.map((spec) => (
        <PropertyRow key={spec.name} spec={spec} ctx={ctx} studio={studio} comp={state.comp} />
      ))}
    </div>
  );
}

function ListEditor(props: { title: string; property: string; ctx: NodeContext; studio: Studio }): ReactNode {
  const { ctx, studio, property } = props;
  const type = str(ctx.node['type'], '');
  const branches = unionBranches(propertySchema(type, property));
  const list = records(ctx.node[property]);
  const save = (next: readonly Rec[]): void => {
    void studio.patch([{ op: 'setProperty', nodeId: ctx.id, property, value: next.length === 0 ? null : next }]);
  };
  const names = [...branches.keys()];
  const create = (name: string): Rec => {
    const out: Rec = { type: name };
    for (const f of objectFields(branches.get(name))) {
      if (f.field.kind === 'number') out[f.name] = f.field.max !== undefined && f.field.max <= 1 ? 0.5 : f.name === 'radius' ? 4 : 1;
    }
    if (name === 'color-matrix') out['matrix'] = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
    if (name === 'lut') out['asset'] = '';
    return out;
  };
  return (
    <fieldset className="effect-list">
      <legend>{props.title}</legend>
      {list.length === 0 && <p className="muted small">None.</p>}
      {list.map((item, i) => {
        const name = str(item['type'], '');
        return (
          <div className="effect" key={`${name}-${String(i)}`}>
            <div className="effect-head">
              <strong>{name}</strong>
              <button type="button" aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => { save(list.map((x, j) => (j === i - 1 ? item : j === i ? (list[i - 1] ?? x) : x))); }}>
                ↑
              </button>
              <button type="button" aria-label={`Move ${name} down`} disabled={i === list.length - 1} onClick={() => { save(list.map((x, j) => (j === i + 1 ? item : j === i ? (list[i + 1] ?? x) : x))); }}>
                ↓
              </button>
              <button type="button" aria-label={`Remove ${name}`} onClick={() => { save(list.filter((_, j) => j !== i)); }}>
                ✕
              </button>
            </div>
            {objectFields(branches.get(name)).map((f) => (
              <div className="field" key={f.name}>
                <label className="field-label">{f.name}</label>
                <Field
                  name={f.name}
                  label={`${name} ${f.name}`}
                  field={isAnimated(item[f.name]) ? { kind: 'json' } : f.field}
                  value={item[f.name]}
                  onCommit={(v) => {
                    save(list.map((x, j) => (j === i ? { ...x, [f.name]: v } : x)));
                  }}
                />
                <span className="icon" />
              </div>
            ))}
          </div>
        );
      })}
      {names.length > 0 && (
        <label className="add-effect">
          Add{' '}
          <select
            aria-label={`Add ${props.title.toLowerCase()}`}
            value=""
            onChange={(e) => {
              if (e.currentTarget.value !== '') save([...list, create(e.currentTarget.value)]);
            }}
          >
            <option value="">choose…</option>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      )}
    </fieldset>
  );
}

/** Der Effects-Tab: Filter, Layer-Effekte und Schatten der gewählten Node. */
export function Effects(): ReactNode {
  const [studio, state] = useStudio();
  const ctx = nodeContext(studio, state);
  if (ctx === undefined) return <p className="empty">Select a node to edit its filters, effects and shadow.</p>;
  const type = str(ctx.node['type'], '');
  const hasFilters = propertySchema(type, 'filters') !== undefined;
  const hasEffects = propertySchema(type, 'effects') !== undefined;
  const shadowSchema = propertySchema(type, 'shadow');
  const shadow = ctx.node['shadow'];
  if (!hasFilters && !hasEffects && shadowSchema === undefined) return <p className="empty">Nodes of type {type} have no filters or effects.</p>;
  const saveShadow = (value: unknown): void => {
    void studio.patch([{ op: 'setProperty', nodeId: ctx.id, property: 'shadow', value }]);
  };
  return (
    <div className="inspector">
      <h3>
        {ctx.id} <span className="muted small">{type}</span>
      </h3>
      {hasFilters && <ListEditor title="Filters" property="filters" ctx={ctx} studio={studio} />}
      {hasEffects && <ListEditor title="Layer effects" property="effects" ctx={ctx} studio={studio} />}
      {shadowSchema !== undefined && (
        <fieldset className="effect-list">
          <legend>Shadow</legend>
          {isRecord(shadow) ? (
            <>
              {objectFields(shadowSchema).map((f) => (
                <div className="field" key={f.name}>
                  <label className="field-label">{f.name}</label>
                  <Field
                    name={f.name}
                    label={`shadow ${f.name}`}
                    field={isAnimated(shadow[f.name]) ? { kind: 'json' } : describeSchema(rec(rec(shadowSchema)['properties'])[f.name]).field}
                    value={shadow[f.name]}
                    onCommit={(v) => {
                      saveShadow({ ...shadow, [f.name]: v === null && f.name === 'color' ? '#000000' : v });
                    }}
                  />
                  <span className="icon" />
                </div>
              ))}
              <button type="button" onClick={() => { saveShadow(null); }}>
                Remove shadow
              </button>
            </>
          ) : (
            <button type="button" onClick={() => { saveShadow({ color: '#00000080', blur: 12, offsetX: 0, offsetY: 6 }); }}>
              Add shadow
            </button>
          )}
        </fieldset>
      )}
      <p className="muted small">Frame {num(state.frame, 0)}</p>
    </div>
  );
}
