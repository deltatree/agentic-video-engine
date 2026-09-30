/**
 * Ein Eingabefeld je Feldart (Zahl mit Slider, Farbe, Text, Auswahl, Wahrheitswert, Vec2, JSON).
 * Änderungen werden erst beim Loslassen, Enter oder Verlassen übernommen (ein Patch je Änderung);
 * während ein Slider gezogen wird, meldet `onPreview` Zwischenwerte für die Live-Vorschau (Story 20.5).
 */
import { isRecord } from '@agentic-video/core';
import { useEffect, useId, useState, type ReactNode } from 'react';
import type { FieldKind } from '../fields.js';
import { num } from '../json.js';

function sliderRange(field: Extract<FieldKind, { kind: 'number' }>, name: string, value: number): { min: number; max: number; step: number } {
  if (field.min !== undefined && field.max !== undefined) return { min: field.min, max: field.max, step: field.max - field.min <= 1 ? 0.01 : 1 };
  if (name === 'rotation' || name.endsWith('degrees')) return { min: -360, max: 360, step: 1 };
  const span = Math.max(100, Math.abs(value) * 2);
  return { min: field.min ?? -span, max: span, step: field.integer ? 1 : Math.abs(value) < 10 && span <= 100 ? 0.1 : 1 };
}

function toHex6(color: string): string {
  if (/^#[0-9a-fA-F]{6}/u.test(color)) return color.slice(0, 7);
  if (/^#[0-9a-fA-F]{3}$/u.test(color)) return color.replace(/^#(.)(.)(.)$/u, '#$1$1$2$2$3$3');
  return '#000000';
}

/**
 * Feld für einen Wert. `value` ist der Wert am aktuellen Frame, `onCommit` bekommt den neuen Wert
 * (oder `null` zum Entfernen).
 *
 * @example
 * ```tsx
 * <Field name="x" field={{ kind: 'number', integer: false }} value={40} onCommit={(v) => save(v)} />
 * ```
 */
export function Field(props: { name: string; label?: string; field: FieldKind; value: unknown; onCommit: (value: unknown) => void; onPreview?: (value: unknown) => void; disabled?: boolean; placeholder?: string }): ReactNode {
  const id = useId();
  const label = props.label ?? props.name;
  const f = props.field;
  const [draft, setDraft] = useState<unknown>(props.value);
  useEffect(() => {
    setDraft(props.value);
  }, [props.value]);

  const commit = (v: unknown): void => {
    if (JSON.stringify(v) !== JSON.stringify(props.value)) props.onCommit(v);
  };

  switch (f.kind) {
    case 'number': {
      const value = num(draft, 0);
      const range = sliderRange(f, props.name, num(props.value, 0));
      return (
        <div className="field-control number">
          <input
            type="range"
            aria-label={`${label} slider`}
            min={Math.min(range.min, value)}
            max={Math.max(range.max, value)}
            step={range.step}
            value={value}
            disabled={props.disabled}
            onChange={(e) => {
              const v = Number(e.currentTarget.value);
              setDraft(v);
              props.onPreview?.(v);
            }}
            onPointerUp={() => {
              commit(draft);
            }}
            onKeyUp={() => {
              commit(draft);
            }}
          />
          <input
            id={id}
            type="number"
            aria-label={label}
            step={f.integer ? 1 : 'any'}
            value={typeof draft === 'number' ? Math.round(draft * 1000) / 1000 : ''}
            placeholder={props.placeholder ?? '—'}
            disabled={props.disabled}
            onChange={(e) => {
              setDraft(e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value));
            }}
            onBlur={() => {
              commit(typeof draft === 'number' && Number.isFinite(draft) ? draft : null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        </div>
      );
    }
    case 'color': {
      const text = typeof draft === 'string' ? draft : '';
      return (
        <div className="field-control color">
          <input
            type="color"
            aria-label={`${label} color picker`}
            value={toHex6(text)}
            disabled={props.disabled}
            onChange={(e) => {
              setDraft(e.currentTarget.value.toUpperCase());
            }}
            onBlur={(e) => {
              commit(e.currentTarget.value.toUpperCase());
            }}
          />
          <input
            type="text"
            aria-label={label}
            value={text}
            placeholder={props.placeholder ?? (isRecord(props.value) ? 'gradient' : '#RRGGBB')}
            disabled={props.disabled}
            onChange={(e) => {
              setDraft(e.currentTarget.value);
            }}
            onBlur={() => {
              commit(text === '' ? null : text);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        </div>
      );
    }
    case 'text': {
      const text = typeof draft === 'string' ? draft : '';
      return (
        <textarea
          aria-label={label}
          {...(props.placeholder !== undefined ? { placeholder: props.placeholder } : {})}
          rows={props.name === 'text' || props.name === 'html' || props.name === 'css' || props.name === 'code' ? 3 : 1}
          value={text}
          disabled={props.disabled}
          onChange={(e) => {
            setDraft(e.currentTarget.value);
          }}
          onBlur={() => {
            commit(text === '' ? null : text);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || props.name !== 'text')) {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
      );
    }
    case 'enum':
      return (
        <select
          aria-label={label}
          value={typeof draft === 'string' ? draft : ''}
          disabled={props.disabled}
          onChange={(e) => {
            commit(e.currentTarget.value === '' ? null : e.currentTarget.value);
          }}
        >
          <option value="">(default)</option>
          {f.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case 'boolean':
      return (
        <input
          type="checkbox"
          aria-label={label}
          checked={draft === true}
          disabled={props.disabled}
          onChange={(e) => {
            commit(e.currentTarget.checked);
          }}
        />
      );
    case 'vec2': {
      const v = isRecord(draft) ? draft : {};
      const part = (axis: 'x' | 'y'): ReactNode => (
        <input
          type="number"
          aria-label={`${label} ${axis}`}
          step="any"
          value={typeof v[axis] === 'number' ? v[axis] : ''}
          placeholder={axis}
          disabled={props.disabled}
          onChange={(e) => {
            setDraft({ x: num(v['x'], 0), y: num(v['y'], 0), [axis]: Number(e.currentTarget.value) });
          }}
          onBlur={() => {
            commit(isRecord(draft) ? { x: num(draft['x'], 0), y: num(draft['y'], 0) } : null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
      );
      return (
        <div className="field-control vec2">
          {part('x')}
          {part('y')}
        </div>
      );
    }
    case 'json':
      return <JsonField label={label} value={props.value} onCommit={commit} {...(props.disabled !== undefined ? { disabled: props.disabled } : {})} />;
  }
}

function JsonField(props: { label: string; value: unknown; onCommit: (v: unknown) => void; disabled?: boolean }): ReactNode {
  const initial = props.value === undefined ? '' : JSON.stringify(props.value);
  const [text, setText] = useState(initial);
  const [error, setError] = useState(false);
  useEffect(() => {
    setText(initial);
    setError(false);
  }, [initial]);
  return (
    <textarea
      aria-label={`${props.label} (JSON)`}
      aria-invalid={error}
      className="json"
      rows={1}
      value={text}
      placeholder="JSON"
      disabled={props.disabled}
      onChange={(e) => {
        setText(e.currentTarget.value);
      }}
      onBlur={() => {
        if (text.trim() === '') {
          props.onCommit(null);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(text);
          setError(false);
          props.onCommit(parsed);
        } catch {
          setError(true);
        }
      }}
    />
  );
}
