/**
 * Preview/Bühne: Server-Frames mit Zoom und Schwenken, Linealen, Hilfslinien, Safe Areas,
 * Raster, Auswahl-Bounds, Verschieben mit Einrasten, Transform-Griffe (Größe, Drehung),
 * Rahmenauswahl, Live-Vorschau beim Ziehen und Asset-Drop.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { useStudio } from '../context.js';
import { snapMove, union, type Box, type Delta, type Snap } from '../geometry.js';
import { allIds, findNode, topLevel } from '../ir.js';
import { keyState } from '../keys.js';
import { num, rec, str, type PatchJson } from '../json.js';
import { flattenTree } from '../store.js';
import { HANDLES, angleOf, marqueeHits, normalizeBox, resizeBlocker, resizeBox, type Handle } from '../transform.js';
import { ASSET_DRAG_TYPE, STAGE_ASSET_TYPES } from './Library.js';

interface Guide {
  readonly id: number;
  readonly axis: 'x' | 'y';
  readonly pos: number;
}

type Drag =
  | { readonly kind: 'move'; readonly ids: readonly string[]; readonly start: { x: number; y: number }; readonly box: Box; readonly delta: Delta; readonly lineX?: number; readonly lineY?: number }
  | { readonly kind: 'pan'; readonly start: { x: number; y: number }; readonly pan: { x: number; y: number } }
  | { readonly kind: 'guide'; readonly guide: Guide }
  | { readonly kind: 'resize'; readonly id: string; readonly handle: Handle; readonly start: { x: number; y: number }; readonly box: Box; readonly next: Box }
  | { readonly kind: 'rotate'; readonly id: string; readonly center: { x: number; y: number }; readonly startAngle: number; readonly angle: number; readonly snap: boolean }
  | { readonly kind: 'marquee'; readonly start: { x: number; y: number }; readonly end: { x: number; y: number }; readonly additive: boolean };

function tickStep(zoom: number): number {
  for (const s of [5, 10, 20, 50, 100, 200, 500, 1000, 2000]) if (s * zoom >= 50) return s;
  return 5000;
}

function Ruler(props: { axis: 'x' | 'y'; length: number; pan: number; zoom: number; onPointerDown: (e: PointerEvent<HTMLDivElement>) => void }): ReactNode {
  const step = tickStep(props.zoom);
  const first = Math.floor(-props.pan / props.zoom / step) * step;
  const ticks: number[] = [];
  for (let u = first; u * props.zoom + props.pan < props.length && ticks.length < 200; u += step) ticks.push(u);
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

const CURSORS: Readonly<Record<Handle, string>> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

function handlePosition(h: Handle, box: Box): { x: number; y: number } {
  const x = h.includes('w') ? box.x : h.includes('e') ? box.x + box.width : box.x + box.width / 2;
  const y = h.startsWith('n') ? box.y : h.startsWith('s') ? box.y + box.height : box.y + box.height / 2;
  return { x, y };
}

/** Ganzzahlige Box mit mindestens 1 px Kante (Ergebnis eines Griffs). */
function roundBox(raw: Box): Box {
  return { x: Math.round(raw.x), y: Math.round(raw.y), width: Math.max(1, Math.round(raw.width)), height: Math.max(1, Math.round(raw.height)) };
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
  const [drag, setDragState] = useState<Drag | undefined>(undefined);
  // Neuester Stand des Ziehens, synchron zu den Zeigerereignissen. Unter Last kommen `pointermove` und
  // `pointerup` schneller als React neu rendert; der Zustand aus dem letzten Render wäre dann veraltet
  // (z. B. Drehwinkel noch beim Start: die Drehung wurde nicht gespeichert). Handler lesen darum die Ref.
  const dragRef = useRef<Drag | undefined>(undefined);
  const setDrag = (next: Drag | undefined): void => {
    dragRef.current = next;
    setDragState(next);
  };
  const [guideAxis, setGuideAxis] = useState<'x' | 'y'>('x');
  const [guidePos, setGuidePos] = useState('');
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
  const selectable = flat.filter((n) => {
    const node = findNode(state.comp, n.id)?.node;
    return node?.['locked'] !== true && node?.['visible'] !== false;
  });
  const selectedBoxes = state.selection.map((id) => ({ id, box: flat.find((n) => n.id === id)?.bounds })).filter((s): s is { id: string; box: Box } => s.box !== undefined);
  const single = selectedBoxes.length === 1 && state.selection.length === 1 ? selectedBoxes[0] : undefined;
  const singleNode = single !== undefined ? findNode(state.comp, single.id)?.node : undefined;
  const canTransform = singleNode !== undefined && singleNode['locked'] !== true;
  const blocker = canTransform ? resizeBlocker(singleNode) : 'locked';

  const hitTest = (p: { x: number; y: number }): string | undefined => {
    for (let i = selectable.length - 1; i >= 0; i--) {
      const n = selectable[i];
      const b = n?.bounds;
      if (n === undefined || b === undefined) continue;
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

  /** Live-Vorschau des aktuellen Zwischenstands (Story 20.5). */
  const preview = (patches: PatchJson[] | string): void => {
    if (typeof patches !== 'string') studio.previewPatches(patches);
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
      // Leere Fläche: Rahmenauswahl (mit Shift/Ctrl ergänzend).
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag({ kind: 'marquee', start: p, end: p, additive: modifier });
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

  const startHandle = (e: PointerEvent<HTMLElement>, handle: Handle | 'rotate'): void => {
    if (single === undefined || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    area.current?.setPointerCapture(e.pointerId);
    const p = toComp(e.clientX, e.clientY);
    if (handle === 'rotate') {
      const center = { x: single.box.x + single.box.width / 2, y: single.box.y + single.box.height / 2 };
      const a = angleOf(center, p);
      setDrag({ kind: 'rotate', id: single.id, center, startAngle: a, angle: a, snap: e.shiftKey });
      return;
    }
    setDrag({ kind: 'resize', id: single.id, handle, start: p, box: single.box, next: single.box });
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
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
    if (drag.kind === 'marquee') {
      setDrag({ ...drag, end: p });
      return;
    }
    if (drag.kind === 'resize') {
      // Shift hält das Seitenverhältnis, Alt skaliert um die Mitte.
      const next = roundBox(resizeBox(drag.box, drag.handle, p.x - drag.start.x, p.y - drag.start.y, e.shiftKey, e.altKey));
      setDrag({ ...drag, next });
      preview(studio.resizeNodePatches(drag.id, drag.box, next));
      return;
    }
    if (drag.kind === 'rotate') {
      const angle = angleOf(drag.center, p);
      setDrag({ ...drag, angle, snap: e.shiftKey });
      preview(studio.rotatePatches(drag.id, drag.startAngle, angle, e.shiftKey));
      return;
    }
    const raw = { dx: p.x - drag.start.x, dy: p.y - drag.start.y };
    const targets = snapTargets(new Set(drag.ids));
    // Alt schaltet das Einrasten ab.
    const snapped: Snap = e.altKey ? raw : snapMove(drag.box, raw.dx, raw.dy, targets.xs, targets.ys, 6 / zoom);
    const { lineX, lineY } = snapped;
    const delta = { dx: Math.round(snapped.dx), dy: Math.round(snapped.dy) };
    setDrag({ kind: 'move', ids: drag.ids, start: drag.start, box: drag.box, delta, ...(lineX !== undefined ? { lineX } : {}), ...(lineY !== undefined ? { lineY } : {}) });
    if (delta.dx !== 0 || delta.dy !== 0) studio.previewPatches(studio.movePatches(new Map(drag.ids.map((id) => [id, delta]))).patches);
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    const current = dragRef.current;
    setDrag(undefined);
    if (current === undefined) return;
    // Endstand aus dem pointerup selbst (Position und Shift beim Loslassen), nicht aus dem letzten Render.
    const up = toComp(e.clientX, e.clientY);
    const d: Drag =
      current.kind === 'rotate'
        ? { ...current, angle: angleOf(current.center, up), snap: e.shiftKey }
        : current.kind === 'resize'
          ? { ...current, next: roundBox(resizeBox(current.box, current.handle, up.x - current.start.x, up.y - current.start.y, e.shiftKey, e.altKey)) }
          : current;
    if (d.kind === 'guide') {
      const rect = area.current?.getBoundingClientRect();
      const inside = rect !== undefined && e.clientX > rect.left && e.clientY > rect.top;
      setGuides((list) => [...list.filter((g) => g.id !== d.guide.id), ...(inside ? [d.guide] : [])]);
      return;
    }
    if (d.kind === 'marquee') {
      const rect = { x: d.start.x, y: d.start.y, width: d.end.x - d.start.x, height: d.end.y - d.start.y };
      // Ein Klick ohne Ziehen leert die Auswahl.
      if (Math.abs(rect.width) * zoom < 3 && Math.abs(rect.height) * zoom < 3) {
        if (!d.additive) studio.select([]);
        return;
      }
      const hits = topLevel(state.comp, marqueeHits(selectable, rect));
      studio.select(hits, d.additive ? 'add' : 'replace');
      return;
    }
    if (d.kind === 'move' && (d.delta.dx !== 0 || d.delta.dy !== 0)) {
      void studio.moveNodes(new Map(d.ids.map((id) => [id, d.delta])));
      return;
    }
    if (d.kind === 'resize' && (d.next.width !== d.box.width || d.next.height !== d.box.height || d.next.x !== d.box.x || d.next.y !== d.box.y)) {
      const patches = studio.resizeNodePatches(d.id, d.box, d.next);
      if (typeof patches === 'string') {
        studio.notify('error', patches);
        studio.cancelPreview();
      } else void studio.patch(patches);
      return;
    }
    if (d.kind === 'rotate' && d.angle !== d.startAngle) {
      const patches = studio.rotatePatches(d.id, d.startAngle, d.angle, d.snap);
      if (typeof patches === 'string') {
        studio.notify('error', patches);
        studio.cancelPreview();
      } else void studio.patch(patches);
      return;
    }
    studio.cancelPreview();
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

  const addGuide = (): void => {
    const pos = Number(guidePos);
    if (guidePos.trim() === '' || !Number.isFinite(pos)) return;
    setGuides((list) => [...list, { id: nextGuide.current++, axis: guideAxis, pos: Math.round(pos) }]);
    setGuidePos('');
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    // Tab wählt die nächste Node (Shift+Tab die vorherige); am Ende verlässt Tab die Bühne wie gewohnt.
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey && selectable.length > 0) {
      const order = selectable.map((n) => n.id);
      const current = state.selection.length === 1 && state.selection[0] !== undefined ? order.indexOf(state.selection[0]) : -1;
      const next = e.shiftKey ? (current === -1 ? order.length - 1 : current - 1) : current + 1;
      const id = order[next];
      if (id === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      studio.select([id]);
      return;
    }
    const arrows: Record<string, Delta> = { ArrowLeft: { dx: -1, dy: 0 }, ArrowRight: { dx: 1, dy: 0 }, ArrowUp: { dx: 0, dy: -1 }, ArrowDown: { dx: 0, dy: 1 } };
    const d = arrows[e.key];
    if (d === undefined || state.selection.length === 0 || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    const f = e.shiftKey ? 10 : 1;
    // Kurz hintereinander gedrückte Pfeile ergeben einen Undo-Schritt (Story 20.3).
    void studio.nudge(d.dx * f, d.dy * f);
  };

  const onDrop = (e: DragEvent): void => {
    const data = e.dataTransfer.getData(ASSET_DRAG_TYPE);
    if (data === '') return;
    const parsed: unknown = JSON.parse(data);
    const asset = rec(parsed);
    const type = str(asset['type'], '');
    if (!STAGE_ASSET_TYPES.has(type)) {
      studio.notify('info', type === 'audio' ? 'Drop audio on the Timeline to create an audio track.' : `Assets of type ${type} cannot be placed on the stage.`);
      return;
    }
    e.preventDefault();
    const p = toComp(e.clientX, e.clientY);
    const id = str(asset['id'], 'asset');
    void studio.addNode({ id, type, asset: id, x: Math.round(p.x), y: Math.round(p.y) });
  };

  const liveGuides = drag?.kind === 'guide' ? [...guides.filter((g) => g.id !== drag.guide.id), drag.guide] : guides;
  const moveDelta = drag?.kind === 'move' ? drag.delta : undefined;
  const px = (v: number): string => `${String(v)}px`;
  const gridStep = tickStep(zoom) * zoom;
  const marquee = drag?.kind === 'marquee' ? normalizeBox({ x: drag.start.x, y: drag.start.y, width: drag.end.x - drag.start.x, height: drag.end.y - drag.start.y }) : undefined;
  const liveBox = (id: string, box: Box): Box => {
    if (drag?.kind === 'resize' && drag.id === id) return drag.next;
    if (moveDelta !== undefined && drag?.kind === 'move' && drag.ids.includes(id)) return { ...box, x: box.x + moveDelta.dx, y: box.y + moveDelta.dy };
    return box;
  };
  const rotation = drag?.kind === 'rotate' ? drag.angle - drag.startAngle : 0;
  const selectedLabel = state.selection.length === 0 ? 'No node selected' : `Selected: ${state.selection.join(', ')}`;

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
        <span className="guide-form" role="group" aria-label="Add guide">
          <select aria-label="Guide direction" value={guideAxis} onChange={(e) => { setGuideAxis(e.currentTarget.value === 'y' ? 'y' : 'x'); }}>
            <option value="x">Vertical guide at x</option>
            <option value="y">Horizontal guide at y</option>
          </select>
          <input
            type="number"
            aria-label="Guide position in pixels"
            placeholder="px"
            value={guidePos}
            onChange={(e) => { setGuidePos(e.currentTarget.value); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addGuide();
            }}
          />
          <button type="button" onClick={addGuide} disabled={guidePos.trim() === ''}>
            Add guide
          </button>
        </span>
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
            aria-describedby="stage-help stage-selection"
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
              const b = liveBox(id, box);
              const moving = (drag?.kind === 'move' && drag.ids.includes(id)) || (drag?.kind === 'resize' && drag.id === id) || (drag?.kind === 'rotate' && drag.id === id);
              return (
                <div
                  key={id}
                  className={`selection${moving ? ' moving' : ''}`}
                  data-node-id={id}
                  style={{
                    left: px(b.x * zoom),
                    top: px(b.y * zoom),
                    width: px(b.width * zoom),
                    height: px(b.height * zoom),
                    ...(drag?.kind === 'rotate' && drag.id === id ? { transform: `rotate(${String(rotation)}deg)` } : {}),
                  }}
                >
                  <span className="selection-label">{id}</span>
                </div>
              );
            })}
            {single !== undefined && canTransform && (
              <>
                {blocker === undefined &&
                  HANDLES.map((h) => {
                    const pos = handlePosition(h, liveBox(single.id, single.box));
                    return (
                      <span
                        key={h}
                        className="handle"
                        data-handle={h}
                        role="presentation"
                        title={`Resize (${h}); Shift keeps the aspect ratio, Alt resizes from the center`}
                        style={{ left: px(pos.x * zoom), top: px(pos.y * zoom), cursor: CURSORS[h] }}
                        onPointerDown={(e) => {
                          startHandle(e, h);
                        }}
                      />
                    );
                  })}
                {(() => {
                  const b = liveBox(single.id, single.box);
                  return (
                    <span
                      className="handle rotate"
                      data-handle="rotate"
                      role="presentation"
                      title={blocker !== undefined && blocker !== 'rotated' ? blocker : 'Rotate; Shift snaps to 15°'}
                      style={{ left: px((b.x + b.width / 2) * zoom), top: px(b.y * zoom - 24) }}
                      onPointerDown={(e) => {
                        startHandle(e, 'rotate');
                      }}
                    />
                  );
                })()}
              </>
            )}
          </div>
          {marquee !== undefined && <div className="marquee" style={{ left: px(pan.x + marquee.x * zoom), top: px(pan.y + marquee.y * zoom), width: px(marquee.width * zoom), height: px(marquee.height * zoom) }} aria-hidden="true" />}
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
        Click a node to select it, drag to move it, drag on an empty area to select several. Tab and Shift+Tab select the next or previous node. Arrow keys move the selection by one pixel, Shift+arrow by ten. Drag the handles to resize (Shift keeps the aspect ratio) or rotate (Shift snaps to 15 degrees). Hold Space and drag to pan, use the mouse wheel to zoom.
      </p>
      <p id="stage-selection" className="sr-only" aria-live="polite">
        {selectedLabel}
      </p>
    </div>
  );
}
