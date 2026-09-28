/**
 * Debug-Overlays (FR-27) und Kontaktbögen für visuelle Prüfungen.
 */
import type { Canvas, CanvasKit } from 'canvaskit-wasm';
import { applyToPoint, getTransform, luminance, parseColor, type DebugOptions, type EvaluatedNode, type EvaluatedScene, type FontResolver, type NodeBounds, type RgbaImage } from '@agentic-video/core';
import { walkNodes } from './draw.js';
import { imageFromRgba, makeSurface, rgbaFromSurface } from './image.js';
import { toColor } from './paint.js';
import { Scope } from './scope.js';
import { TextEngine } from './text.js';

/** Rasterweite des Debug-Gitters in Composition-Pixeln. */
export const DEBUG_GRID_SIZE = 100;

const COLORS = { grid: '#FFFFFF33', safeAction: '#00E5FFCC', safeTitle: '#FFD400CC', bounds: '#FF3B6BE6', anchor: '#00FF88FF', baseline: '#3B8BFFE6', label: '#FFFFFFFF', labelBg: '#000000B3' };

/**
 * Zeichnet Debug-Hilfen in Composition-Koordinaten auf einen Canvas (Skalierung muss gesetzt sein).
 * `showCameraFrustum` und `showLightHelpers` gehören zum 3D-Renderer und werden hier übergangen.
 *
 * @example
 * ```ts
 * canvas.scale(0.5, 0.5);
 * drawDebugOverlay(ck, canvas, engine, scene, bounds, { showBounds: true });
 * ```
 */
export function drawDebugOverlay(ck: CanvasKit, canvas: Canvas, text: TextEngine, scene: EvaluatedScene, bounds: readonly NodeBounds[], options: DebugOptions, scope: Scope): void {
  const stroke = (color: string, width: number) => {
    const p = scope.add(new ck.Paint());
    p.setAntiAlias(true);
    p.setStyle(ck.PaintStyle.Stroke);
    p.setStrokeWidth(width);
    p.setColor(toColor(ck, color));
    return p;
  };
  if (options.showGrid === true) {
    const p = stroke(COLORS.grid, 1);
    for (let x = DEBUG_GRID_SIZE; x < scene.width; x += DEBUG_GRID_SIZE) canvas.drawLine(x, 0, x, scene.height, p);
    for (let y = DEBUG_GRID_SIZE; y < scene.height; y += DEBUG_GRID_SIZE) canvas.drawLine(0, y, scene.width, y, p);
  }
  if (options.showSafeArea === true) {
    // Sicherheitsbereiche: Rand als Anteil der Bildgröße.
    const area = (fraction: number, color: string) => {
      const mx = scene.width * fraction;
      const my = scene.height * fraction;
      canvas.drawRect(ck.LTRBRect(mx, my, scene.width - mx, scene.height - my), stroke(color, 2));
    };
    area(scene.safeArea.action, COLORS.safeAction);
    area(scene.safeArea.title, COLORS.safeTitle);
  }
  const nodes = new Map<string, EvaluatedNode>();
  walkNodes(scene.nodes, (n) => nodes.set(n.id, n));
  for (const b of bounds) {
    if (options.showBounds === true) canvas.drawRect(ck.XYWHRect(b.bounds.x, b.bounds.y, b.bounds.width, b.bounds.height), stroke(COLORS.bounds, 1.5));
    if (options.showBaseline === true && b.text !== undefined) {
      const a = applyToPoint(b.matrix, b.box.x, b.box.y + b.text.baseline);
      const c = applyToPoint(b.matrix, b.box.x + b.box.width, b.box.y + b.text.baseline);
      canvas.drawLine(a.x, a.y, c.x, c.y, stroke(COLORS.baseline, 1.5));
    }
    if (options.showAnchors === true) {
      const node = nodes.get(b.id);
      const origin = node !== undefined ? getTransform(node).origin : { x: 0.5, y: 0.5 };
      const pt = applyToPoint(b.matrix, b.box.x + origin.x * b.box.width, b.box.y + origin.y * b.box.height);
      const fill = scope.add(new ck.Paint());
      fill.setAntiAlias(true);
      fill.setColor(toColor(ck, COLORS.anchor));
      canvas.drawCircle(pt.x, pt.y, 4, fill);
      canvas.drawLine(pt.x - 8, pt.y, pt.x + 8, pt.y, stroke(COLORS.anchor, 1));
      canvas.drawLine(pt.x, pt.y - 8, pt.x, pt.y + 8, stroke(COLORS.anchor, 1));
    }
    if (options.showNodeIds === true) {
      const label = text.label(scope, b.id, { size: 13, color: COLORS.label });
      const w = label.getMaxIntrinsicWidth() + 8;
      const h = label.getHeight() + 4;
      const bg = scope.add(new ck.Paint());
      bg.setColor(toColor(ck, COLORS.labelBg));
      const y = Math.max(0, b.bounds.y - h);
      canvas.drawRect(ck.XYWHRect(b.bounds.x, y, w, h), bg);
      canvas.drawParagraph(label, b.bounds.x + 4, y + 2);
    }
  }
}

/**
 * Rendert Debug-Hilfen als eigenes transparentes Bild (Bounds, Anchors, Safe Areas, Baselines, Gitter, Node-IDs).
 *
 * @example
 * ```ts
 * const overlay = renderDebugOverlay(ck, fonts, scene, computeBounds(scene, measurer), { showBounds: true, showGrid: true }, { width: 960, height: 540 });
 * ```
 */
export function renderDebugOverlay(canvasKit: CanvasKit, fonts: FontResolver, scene: EvaluatedScene, bounds: readonly NodeBounds[], options: DebugOptions, size: { readonly width: number; readonly height: number }): RgbaImage {
  const scope = new Scope();
  const engine = new TextEngine(canvasKit, fonts);
  try {
    const surface = makeSurface(canvasKit, size.width, size.height, scope);
    const canvas = surface.getCanvas();
    canvas.clear(canvasKit.TRANSPARENT);
    canvas.scale(size.width / scene.width, size.height / scene.height);
    drawDebugOverlay(canvasKit, canvas, engine, scene, bounds, options, scope);
    return rgbaFromSurface(canvasKit, surface);
  } finally {
    scope.dispose();
    engine.dispose();
  }
}

/** Optionen für {@link renderContactSheet}. */
export interface ContactSheetOptions {
  readonly columns: number;
  /** Breite einer Zelle in Pixeln; Bilder werden seitentreu hineinskaliert. */
  readonly cellWidth: number;
  /** Hintergrundfarbe, z. B. `#101014`. */
  readonly background: string;
}

/**
 * Setzt Bilder mit Beschriftung unter jedem Bild zu einem Kontaktbogen zusammen.
 *
 * @example
 * ```ts
 * const sheet = renderContactSheet(ck, fonts, frames.map((image, i) => ({ image, label: `frame ${i}` })), { columns: 4, cellWidth: 320, background: '#101014' });
 * ```
 */
export function renderContactSheet(canvasKit: CanvasKit, fonts: FontResolver, frames: readonly { readonly image: RgbaImage; readonly label: string }[], options: ContactSheetOptions): RgbaImage {
  const ck = canvasKit;
  const columns = Math.max(1, Math.floor(options.columns));
  const cellWidth = Math.max(1, Math.round(options.cellWidth));
  const gap = 8;
  const labelSize = 14;
  const labelHeight = Math.ceil(labelSize * 1.6);
  const rows = Math.max(1, Math.ceil(frames.length / columns));
  const heights = frames.map((f) => (f.image.width > 0 ? Math.round((f.image.height / f.image.width) * cellWidth) : 0));
  const rowHeights = Array.from({ length: rows }, (_, r) => Math.max(0, ...heights.slice(r * columns, (r + 1) * columns)) + labelHeight);
  const width = columns * cellWidth + (columns + 1) * gap;
  const height = rowHeights.reduce((a, b) => a + b, 0) + (rows + 1) * gap;
  const bg = parseColor(options.background);
  const labelColor = luminance(bg.r, bg.g, bg.b) > 0.5 ? '#000000' : '#FFFFFF';
  const scope = new Scope();
  const engine = new TextEngine(ck, fonts);
  try {
    const surface = makeSurface(ck, width, height, scope);
    const canvas = surface.getCanvas();
    canvas.clear(toColor(ck, options.background));
    const paint = scope.add(new ck.Paint());
    paint.setAntiAlias(true);
    let y = gap;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < columns; c++) {
        const i = r * columns + c;
        const frame = frames[i];
        if (frame === undefined) continue;
        const x = gap + c * (cellWidth + gap);
        const h = heights[i] ?? 0;
        if (frame.image.width > 0 && frame.image.height > 0) {
          const img = scope.add(imageFromRgba(ck, frame.image));
          canvas.drawImageRectOptions(img, ck.XYWHRect(0, 0, frame.image.width, frame.image.height), ck.XYWHRect(x, y, cellWidth, h), ck.FilterMode.Linear, ck.MipmapMode.None, paint);
        }
        const label = engine.label(scope, frame.label, { size: labelSize, color: labelColor, width: cellWidth, align: 'center' });
        canvas.drawParagraph(label, x, y + h + (labelHeight - label.getHeight()) / 2);
      }
      y += (rowHeights[r] ?? 0) + gap;
    }
    return rgbaFromSurface(ck, surface);
  } finally {
    scope.dispose();
    engine.dispose();
  }
}
