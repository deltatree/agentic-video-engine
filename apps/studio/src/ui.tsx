/**
 * Gemeinsame Bausteine: Tabs mit Tastaturbedienung, verstellbare Trenner und Roving Tabindex für Toolbars.
 */
import { useEffect, useId, useRef, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';

/** Ein Tab. */
export interface TabSpec<T extends string> {
  readonly id: T;
  readonly label: string;
}

/**
 * Tab-Leiste nach WAI-ARIA (Pfeiltasten, Pos1, Ende) mit genau einem sichtbaren Panel.
 *
 * @example
 * ```tsx
 * <Tabs label="Left panel" tabs={[{ id: 'tree', label: 'Scene Tree' }]} active="tree" onChange={setTab}>…</Tabs>
 * ```
 */
export function Tabs<T extends string>(props: { label: string; tabs: readonly TabSpec<T>[]; active: T; onChange: (id: T) => void; children: ReactNode; className?: string; collapsed?: boolean; onToggle?: () => void }): ReactNode {
  const base = useId();
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const index = Math.max(0, props.tabs.findIndex((t) => t.id === props.active));
  const onKey = (e: KeyboardEvent): void => {
    let next: number;
    if (e.key === 'ArrowRight') next = (index + 1) % props.tabs.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + props.tabs.length) % props.tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = props.tabs.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    const tab = props.tabs[next];
    if (tab === undefined) return;
    props.onChange(tab.id);
    refs.current.get(tab.id)?.focus();
  };
  const active = props.tabs[index];
  return (
    <section className={`panel ${props.className ?? ''}`} aria-label={props.label}>
      <div className="tabbar">
        <div role="tablist" aria-label={props.label} className="tablist" onKeyDown={onKey}>
          {props.tabs.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                if (el !== null) refs.current.set(t.id, el);
              }}
              type="button"
              role="tab"
              id={`${base}-${t.id}-tab`}
              aria-selected={t.id === props.active}
              aria-controls={`${base}-${t.id}-panel`}
              tabIndex={t.id === props.active ? 0 : -1}
              className="tab"
              onClick={() => {
                props.onChange(t.id);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        {props.onToggle !== undefined && (
          <button type="button" className="icon collapse" aria-label={`${props.collapsed === true ? 'Expand' : 'Collapse'} ${props.label} panel`} aria-expanded={props.collapsed !== true} title={`${props.collapsed === true ? 'Expand' : 'Collapse'} panel`} onClick={props.onToggle}>
            <span aria-hidden="true">{props.collapsed === true ? '▴' : '▾'}</span>
          </button>
        )}
      </div>
      {active !== undefined && props.collapsed !== true && (
        <div role="tabpanel" id={`${base}-${active.id}-panel`} aria-labelledby={`${base}-${active.id}-tab`} className="tabpanel" tabIndex={-1}>
          {props.children}
        </div>
      )}
    </section>
  );
}

/**
 * Verstellbarer Trenner (Maus und Pfeiltasten).
 *
 * @example
 * ```tsx
 * <Splitter label="Resize left panel" orientation="vertical" value={260} min={160} max={600} onChange={setLeft} />
 * ```
 */
export function Splitter(props: { label: string; orientation: 'vertical' | 'horizontal'; value: number; min: number; max: number; invert?: boolean; hidden?: boolean; onChange: (v: number) => void }): ReactNode {
  const clamp = (v: number): number => Math.max(props.min, Math.min(props.max, v));
  const sign = props.invert === true ? -1 : 1;
  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const start = props.orientation === 'vertical' ? e.clientX : e.clientY;
    const startValue = props.value;
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (ev: globalThis.PointerEvent): void => {
      const pos = props.orientation === 'vertical' ? ev.clientX : ev.clientY;
      props.onChange(clamp(startValue + sign * (pos - start)));
    };
    const up = (): void => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };
  const onKey = (e: KeyboardEvent): void => {
    const step = e.shiftKey ? 50 : 10;
    const dec = props.orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
    const inc = props.orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    if (e.key === dec) props.onChange(clamp(props.value - sign * step));
    else if (e.key === inc) props.onChange(clamp(props.value + sign * step));
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div
      role="separator"
      aria-label={props.label}
      aria-orientation={props.orientation}
      aria-valuenow={Math.round(props.value)}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      tabIndex={props.hidden === true ? -1 : 0}
      aria-hidden={props.hidden === true ? true : undefined}
      className={`splitter splitter-${props.orientation}${props.hidden === true ? ' collapsed' : ''}`}
      onPointerDown={onPointerDown}
      onKeyDown={onKey}
    />
  );
}

/**
 * Roving Tabindex für eine Toolbar (WAI-ARIA): Nur ein Element ist per Tab erreichbar,
 * Pfeiltasten, Pos1 und Ende bewegen den Fokus innerhalb der Toolbar.
 *
 * @example
 * ```tsx
 * const ref = useRef<HTMLElement>(null);
 * const onKeyDown = useRovingToolbar(ref);
 * <header role="toolbar" ref={ref} onKeyDown={onKeyDown}>…</header>
 * ```
 */
export function useRovingToolbar(ref: RefObject<HTMLElement | null>): (e: KeyboardEvent) => void {
  const active = useRef(0);
  const items = (): HTMLElement[] => {
    const root = ref.current;
    if (root === null) return [];
    return [...root.querySelectorAll<HTMLElement>('button, input, select')].filter((el) => !(el instanceof HTMLButtonElement && el.disabled) && !(el instanceof HTMLInputElement && el.disabled));
  };
  useEffect(() => {
    const list = items();
    if (list.length === 0) return;
    const index = Math.min(active.current, list.length - 1);
    list.forEach((el, i) => {
      el.tabIndex = i === index ? 0 : -1;
    });
  });
  return (e: KeyboardEvent): void => {
    const list = items();
    const current = list.findIndex((el) => el === document.activeElement);
    if (current < 0) return;
    let next: number;
    if (e.key === 'ArrowRight') next = (current + 1) % list.length;
    else if (e.key === 'ArrowLeft') next = (current - 1 + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    active.current = next;
    list.forEach((el, i) => {
      el.tabIndex = i === next ? 0 : -1;
    });
    list[next]?.focus();
  };
}
