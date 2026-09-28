/**
 * Preview/Bühne: Server-Frames mit Zoom und Schwenken, Linealen, Hilfslinien, Safe Areas,
 * Raster, Auswahl-Bounds, Verschieben mit Einrasten und Asset-Drop.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useStudio } from '../context.js';
import { snapMove, union, type Box, type Delta, type Snap } from '../geometry.js';
import { allIds, findNode, topLevel } from '../ir.js';
import { keyState } from '../keys.js';
import { num, rec } from '../json.js';
import { flattenTree } from '../store.js';
import { ASSET_DRAG_TYPE } from './Library.js';

interface Guide {
  readonly id: number;
  readonly axis: 'x' | 'y';
  readonly pos: number;
}

type Drag =
  | { readonly kind: 'move'; readonly ids: readonly string[]; readonly start: { x: number; y: number }; readonly box: Box; readonly delta: Delta; readonly lineX?: number; readonly lineY?: number }
  | { readonly kind: 'pan'; readonly start: { x: number; y: number }; readonly pan: { x: number; y: number } }
  | { readonly kind: 'guide'; readonly guide: Guide };

function tickStep(zoom: number): number {
  for (const s of [5, 10, 20, 50, 100, 200, 500, 1000, 2000]) if (s * zoom >= 50) return s;
  return 5000;
}

function Ruler(props: { axis: 'x' | 'y'; length: number; pan: number; zoom: number; onPointerDown: (e: PointerEvent<HTMLDivElement>) => void }): ReactNode {
  const step = tickStep(props.zoom);
  const first = Math.floor(-props.pan / props.zoom / step) * step;
  const ticks: number[] = [];
  for (let u = first; (u * props.zoom + props.pan) < props.length && ticks.length < 200; u += step) ticks.push(u);
  return (
    <div className={`ruler ruler-${props.axis}`} aria-hidden="true" onPointerDown={props.onPointerDown} title="Drag to create a guide">
      {ticks.map((u) => (
        <span key={u} className="tick" style={props.axis === 'x' ? { left: `${String(u * props.zoom + props.pan)}px` } : { top: `${String(u * props.zoom + props.pan)}px` }}>
          {u}
        </span>
      ))}
    </div>
  );
}

/** Die Bühne. */
export function Preview(): ReactNode {
  const [studio, state] = useStudio();
  const area = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 450 });
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const [guides, setGuides] = useState<readonly Guide[]>([]);
  const [grid, setGrid] = useState(false);
  const [safe, setSafe] = useState(true);
  const [drag, setDrag] = useState<Drag | undefined>(undefined);
  const nextGuide = useRef(1);
  const fitted = useRef('');

  const width = num(state.comp?.['width'], 1920);
  const height = num(state.comp?.['height'], 1080);
  const zoom = state.zoom;
  const safeArea = rec(state.comp?.['safeArea']);
  const action = num(safeArea['action'], 0.035);
  const title = num(safeArea['title'], 0.05);

  useLayoutEffect(() => {
    const el = area.current;
    if (el === null) return;
    const observer = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    });
    observer.observe(el);
    setSize({ width: el.clientWidth, height: el.clientHeight });
    return () => {
      observer.disconnect();
    };
  }, []);

  const fit = useCallback((): void => {
    const z = Math.max(0.05, Math.min((size.width - 40) / width, (size.height - 40) / height));
    studio.setZoom(z);
    setPan({ x: (size.width - width * z) / 2, y: (size.height - height * z) / 2 });
  }, [size.width, size.height, width, height, studio]);

  // Beim ersten Laden und bei neuer Composition-Größe einpassen.
  useEffect(() => {
    const key = `${String(width)}x${String(height)}`;
    if (state.comp === undefined || fitted.current === key || size.width < 50) return;
    fitted.current = key;
    fit();
  }, [state.comp, width, height, size.width, fit]);

  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number): void => {
      const z = Math.max(0.05, Math.min(8, zoom * factor));
      setPan((p) => ({ x: cx - ((cx - p.x) * z) / zoom, y: cy - ((cy - p.y) * z) / zoom }));
      studio.setZoom(z);
    },
    [zoom, studio],
  );

  useEffect(() => {
    const el = area.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) zoomAt(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left, e.clientY - rect.top);
      else setPan((p) => ({ x: p.x - e.deltaX, y: p.y }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
    };
  }, [zoomAt]);

  // Zoom-Kürzel aus der Toolbar/Tastatur kommen als Ereignis an.
  useEffect(() => {
    const onZoom = (e: Event): void => {
      if (!(e instanceof CustomEvent)) return;
      const detail: unknown = e.detail;
      if (detail === 'fit') fit();
      else if (detail === 'in') zoomAt(1.25, size.width / 2, size.height / 2);
      else if (detail === 'out') zoomAt(0.8, size.width / 2, size.height / 2);
    };
    window.addEventListener('openvideo:zoom', onZoom);
    return () => {
      window.removeEventListener('openvideo:zoom', onZoom);
    };
  }, [fit, zoomAt, size.width, size.height]);

  const toComp = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = area.current?.getBoundingClientRect();
    return { x: (clientX - (rect?.left ?? 0) - pan.x) / zoom, y: (clientY - (rect?.top ?? 0) - pan.y) / zoom };
  };

  const ids = allIds(state.comp);
  const flat = flattenTree(state.tree).filter((n) => ids.has(n.id) && n.bounds !== undefined);
  const selectedBoxes = state.selection.map((id) => ({ id, box: flat.find((n) => n.id === id)?.bounds })).filter((s): s is { id: string; box: Box } => s.box !== undefined);

  const hitTest = (p: { x: number; y: number }): string | undefined => {
    for (let i = flat.length - 1; i >= 0; i--) {
      const n = flat[i];
      const b = n?.bounds;
      if (n === undefined || b === undefined) continue;
      const node = findNode(state.comp, n.id)?.node;
      if (node?.['locked'] === true || node?.['visible'] === false) continue;
      if (p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height) return n.id;
    }
    return undefined;
  };

  const snapTargets = (moving: ReadonlySet<string>): { xs: number[]; ys: number[] } => {
    const xs = [0, width / 2, width, width * action, width * (1 - action), width * title, width * (1 - title)];
    const ys = [0, height / 2, height, height * action, height * (1 - action), height * title, height * (1 - title)];
    for (const g of guides) (g.axis === 'x' ? xs : ys).push(g.pos);
    for (const n of flat) {
      if (moving.has(n.id) || n.bounds === undefined) continue;
      xs.push(n.bounds.x, n.bounds.x + n.bounds.width / 2, n.bounds.x + n.bounds.width);
      ys.push(n.bounds.y, n.bounds.y + n.bounds.height / 2, n.bounds.y + n.bounds.height);
    }
    return { xs, ys };
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button === 1 || (e.button === 0 && keyState.space)) {
      keyState.spaceUsed = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag({ kind: 'pan', start: { x: e.clientX, y: e.clientY }, pan });
      return;
    }
    if (e.button !== 0) return;
    const p = toComp(e.clientX, e.clientY);
    const hit = hitTest(p);
    const modifier = e.shiftKey || e.ctrlKey || e.metaKey;
    if (hit === undefined) {
      if (!modifier) studio.select([]);
      return;
    }
    let selection = state.selection;
    if (modifier) {
      studio.select([hit], 'toggle');
      return;
    }
    if (!selection.includes(hit)) {
      selection = [hit];
      studio.select(selection);
    }
    const moving = topLevel(state.comp, selection).filter((id) => findNode(state.comp, id)?.node['locked'] !== true);
    const box = union(moving.map((id) => flat.find((n) => n.id === id)?.bounds).filter((b): b is Box => b !== undefined));
    if (box === undefined) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ kind: 'move', ids: moving, start: p, box, delta: { dx: 0, dy: 0 } });
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (drag === undefined) return;
    if (drag.kind === 'pan') {
      setPan({ x: drag.pan.x + e.clientX - drag.start.x, y: drag.pan.y + e.clientY - drag.start.y });
      return;
    }
    const p = toComp(e.clientX, e.clientY);
    if (drag.kind === 'guide') {
      setDrag({ kind: 'guide', guide: { ...drag.guide, pos: Math.round(drag.guide.axis === 'x' ? p.x : p.y) } });
      return;
    }
    const raw = { dx: p.x - drag.start.x, dy: p.y - drag.start.y };
    const targets = snapTargets(new Set(drag.ids));
    // Alt schaltet das Einrasten ab.
    const snapped: Snap = e.altKey ? raw : snapMove(drag.box, raw.dx, raw.dy, targets.xs, targets.ys, 6 / zoom);
    const { lineX, lineY } = snapped;
    setDrag({ kind: 'move', ids: drag.ids, start: drag.start, box: drag.box, delta: { dx: Math.round(snapped.dx), dy: Math.round(snapped.dy) }, ...(lineX !== undefined ? { lineX } : {}), ...(lineY !== undefined ? { lineY } : {}) });
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag;
    setDrag(undefined);
    if (d === undefined) return;
    if (d.kind === 'guide') {
      const rect = area.current?.getBoundingClientRect();
      const inside = rect !== undefined && e.clientX > rect.left && e.clientY > rect.top;
      setGuides((list) => [...list.filter((g) => g.id !== d.guide.id), ...(inside ? [d.guide] : [])]);
      return;
    }
    if (d.kind === 'move' && (d.delta.dx !== 0 || d.delta.dy !== 0)) {
      void studio.moveNodes(new Map(d.ids.map((id) => [id, d.delta])));
    }
  };

  const startGuide = (axis: 'x' | 'y', e: PointerEvent<HTMLElement>, existing?: Guide): void => {
    e.stopPropagation();
    e.preventDefault();
    const p = toComp(e.clientX, e.clientY);
    const guide = existing ?? { id: nextGuide.current++, axis, pos: Math.round(axis === 'x' ? p.x : p.y) };
    // Der Zeiger gehört der Bühne, damit Bewegungen außerhalb des Lineals ankommen.
    area.current?.setPointerCapture(e.pointerId);
    setDrag({ kind: 'guide', guide });
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    const arrows: Record<string, Delta> = { ArrowLeft: { dx: -1, dy: 0 }, ArrowRight: { dx: 1, dy: 0 }, ArrowUp: { dx: 0, dy: -1 }, ArrowDown: { dx: 0, dy: 1 } };
    const d = arrows[e.key];
    if (d === undefined || state.selection.length === 0 || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    const f = e.shiftKey ? 10 : 1;
    void studio.moveNodes(new Map(topLevel(state.comp, state.selection).map((id) => [id, { dx: d.dx * f, dy: d.dy * f }])));
  };

  const onDrop = (e: DragEvent): void => {
    const data = e.dataTransfer.getData(ASSET_DRAG_TYPE);
    if (data === '') return;
    e.preventDefault();
    const parsed: unknown = JSON.parse(data);
    const asset = rec(parsed);
    const p = toComp(e.clientX, e.clientY);
    const id = String(asset['id']);
    void studio.addNode({ id, type: String(asset['type']), asset: id, x: Math.round(p.x), y: Math.round(p.y) });
  };

  const liveGuides = drag?.kind === 'guide' ? [...guides.filter((g) => g.id !== drag.guide.id), drag.guide] : guides;
  const moveDelta = drag?.kind === 'move' ? drag.delta : undefined;
  const px = (v: number): string => `${String(v)}px`;
  const gridStep = tickStep(zoom) * zoom;

  return (
    <div className="preview">
      <div className="stage-toolbar" role="toolbar" aria-label="Stage options">
        <label>
          <input type="checkbox" checked={grid} onChange={(e) => { setGrid(e.currentTarget.checked); }} /> Grid
        </label>
        <label>
          <input type="checkbox" checked={safe} onChange={(e) => { setSafe(e.currentTarget.checked); }} /> Safe areas
        </label>
        <label>
          <input type="checkbox" checked={state.debug} onChange={(e) => { studio.setDebug(e.currentTarget.checked); }} /> Debug overlay
        </label>
        <label>
          Resolution{' '}
          <select value={state.resolution} onChange={(e) => { studio.setResolution(Number(e.currentTarget.value)); }}>
            <option value={0.25}>25 %</option>
            <option value={0.5}>50 %</option>
            <option value={1}>100 %</option>
          </select>
        </label>
        <button type="button" onClick={() => { zoomAt(0.8, size.width / 2, size.height / 2); }} aria-label="Zoom out">−</button>
        <span className="zoom" aria-live="polite">{Math.round(zoom * 100)} %</span>
        <button type="button" onClick={() => { zoomAt(1.25, size.width / 2, size.height / 2); }} aria-label="Zoom in">+</button>
        <button type="button" onClick={fit}>Fit</button>
        {guides.length > 0 && (
          <button type="button" onClick={() => { setGuides([]); }}>
            Clear guides
          </button>
        )}
      </div>
      <div className="viewport">
        <div className="ruler-corner" aria-hidden="true" />
        <Ruler axis="x" length={size.width} pan={pan.x} zoom={zoom} onPointerDown={(e) => { startGuide('x', e); }} />
        <Ruler axis="y" length={size.height} pan={pan.y} zoom={zoom} onPointerDown={(e) => { startGuide('y', e); }} />
        <div
          ref={area}
          className={`stage-area${keyState.space ? ' panning' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(ASSET_DRAG_TYPE)) e.preventDefault();
          }}
          onDrop={onDrop}
        >
          <div
            className="stage"
            role="application"
            aria-label="Stage"
            aria-roledescription="canvas"
            aria-describedby="stage-help"
            tabIndex={0}
            onKeyDown={onKeyDown}
            style={{ left: px(pan.x), top: px(pan.y), width: px(width * zoom), height: px(height * zoom) }}
          >
            {state.image !== undefined && <img src={state.image.src} alt={`Frame ${String(state.image.frame)}`} draggable={false} className="frame" />}
            {grid && <div className="grid" style={{ backgroundSize: `${px(gridStep)} ${px(gridStep)}` }} />}
            {safe && (
              <>
                <div className="safe action" style={{ inset: `${px(height * action * zoom)} ${px(width * action * zoom)}` }} title="Action safe" />
                <div className="safe title" style={{ inset: `${px(height * title * zoom)} ${px(width * title * zoom)}` }} title="Title safe" />
              </>
            )}
            {selectedBoxes.map(({ id, box }) => {
              const moving = moveDelta !== undefined && drag?.kind === 'move' && drag.ids.includes(id);
              return (
                <div
                  key={id}
                  className={`selection${moving ? ' moving' : ''}`}
                  data-node-id={id}
                  style={{
                    left: px((box.x + (moving ? moveDelta.dx : 0)) * zoom),
                    top: px((box.y + (moving ? moveDelta.dy : 0)) * zoom),
                    width: px(box.width * zoom),
                    height: px(box.height * zoom),
                  }}
                >
                  <span className="selection-label">{id}</span>
                </div>
              );
            })}
          </div>
          {liveGuides.map((g) => (
            <div
              key={g.id}
              className={`guide guide-${g.axis}`}
              style={g.axis === 'x' ? { left: px(pan.x + g.pos * zoom) } : { top: px(pan.y + g.pos * zoom) }}
              title={`Guide at ${String(g.pos)} px (drag onto the ruler to remove)`}
              onPointerDown={(e) => {
                startGuide(g.axis, e, g);
              }}
            />
          ))}
          {drag?.kind === 'move' && drag.lineX !== undefined && <div className="snap snap-x" style={{ left: px(pan.x + drag.lineX * zoom) }} />}
          {drag?.kind === 'move' && drag.lineY !== undefined && <div className="snap snap-y" style={{ top: px(pan.y + drag.lineY * zoom) }} />}
        </div>
      </div>
      <p id="stage-help" className="sr-only">
        Click a node to select it, drag to move it. Arrow keys move the selection by one pixel, Shift+arrow by ten. Hold Space and drag to pan, use the mouse wheel to zoom.
      </p>
    </div>
  );
}
