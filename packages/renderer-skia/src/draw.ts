/**
 * Zeichnet ausgewertete 2D-Nodes auf einen CanvasKit-Canvas
 * (Vertrag: docs/reference/node-semantics.md).
 */
import type { Canvas, CanvasKit, Image, Paint, Path, PathBuilder, RuntimeEffect, SkottieAnimation } from 'canvaskit-wasm';
import {
  OpenVideoError,
  effectiveFill,
  getNumber,
  getPoints,
  getTransform,
  getVec2,
  isRecord,
  localBox,
  localMatrix,
  particles2d,
  revealShape,
  transformRect,
  unionRect,
  type EvaluatedNode,
  type EvaluatedScene,
  type Matrix2D,
  type Rect,
} from '@agentic-video/core';
import { applyStroke, blendModeOf, maskColorFilter, nodeImageFilter, paintFor, toColor, type Box } from './paint.js';
import { nullable, type Scope } from './scope.js';
import { drawSvgDocument } from './svg-draw.js';
import type { SvgDocument } from './svg.js';
import { drawTextLayout, type TextEngine, type TextLayout } from './text.js';

/** Für einen Frame vorab geladene Ressourcen. */
export interface FrameResources {
  /** Rasterbilder für `image` und `sprite`, nach Asset-ID. */
  readonly images: ReadonlyMap<string, Image>;
  /** Videobilder nach Node. */
  readonly videoFrames: ReadonlyMap<EvaluatedNode, Image>;
  /** Lottie-Animationen nach Asset-ID. */
  readonly lottie: ReadonlyMap<string, SkottieAnimation>;
  /** SVG-Dokumente nach Node. */
  readonly svgs: ReadonlyMap<EvaluatedNode, SvgDocument>;
}

/** Zustand eines Render-Auftrags. */
export interface DrawContext {
  readonly ck: CanvasKit;
  readonly scope: Scope;
  readonly text: TextEngine;
  readonly scene: EvaluatedScene;
  readonly resources: FrameResources;
  /** Kompilierte SkSL-Effekte nach Quelltext (über Frames hinweg). */
  readonly effect: (sksl: string, node: EvaluatedNode) => RuntimeEffect;
  readonly signal: { readonly aborted: boolean } | undefined;
  readonly layouts: Map<EvaluatedNode, TextLayout>;
}

/**
 * Wandelt eine 2D-Matrix `[a, b, c, d, e, f]` in eine 3×3-Matrix für CanvasKit.
 *
 * @example
 * ```ts
 * canvas.concat(matrix3(localMatrix(node)));
 * ```
 */
export function matrix3(m: Matrix2D): number[] {
  return [m[0], m[2], m[4], m[1], m[3], m[5], 0, 0, 1];
}

function abortError(): OpenVideoError {
  return new OpenVideoError({ code: 'OV_RENDER_ABORTED', errorClass: 'SkiaRendererError', problem: 'Rendering was aborted.', suggestions: ['Start the render again.'] });
}

/**
 * Lokale Zeit einer Node in Sekunden.
 *
 * @example
 * ```ts
 * localSeconds(node, 30); // 1.5 bei localFrame 45
 * ```
 */
export function localSeconds(node: EvaluatedNode, fps: number): number {
  return node.time.localFrame / fps;
}

/**
 * Eigengröße einer Node (Text gemessen, Medien aus dem Asset) für Box und Transform-Ursprung.
 *
 * @example
 * ```ts
 * const box = localBox(node, measuredSize(node, ctx));
 * ```
 */
export function measuredSize(node: EvaluatedNode, ctx: DrawContext): { width: number; height: number } | undefined {
  switch (node.type) {
    case 'text':
    case 'rich-text': {
      const layout = textLayout(node, ctx);
      return { width: layout.width, height: layout.height };
    }
    case 'image': {
      const img = ctx.resources.images.get(String(node.props['asset']));
      return img !== undefined ? { width: img.width(), height: img.height() } : undefined;
    }
    case 'sprite': {
      const img = ctx.resources.images.get(String(node.props['asset']));
      if (img === undefined) return undefined;
      return { width: img.width() / Math.max(1, getNumber(node, 'columns', 1)), height: img.height() / Math.max(1, getNumber(node, 'rows', 1)) };
    }
    case 'video': {
      const img = ctx.resources.videoFrames.get(node);
      return img !== undefined ? { width: img.width(), height: img.height() } : undefined;
    }
    case 'svg': {
      const doc = ctx.resources.svgs.get(node);
      return doc !== undefined ? { width: doc.width, height: doc.height } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Gesetzter Text einer Node (einmal pro Render-Auftrag).
 *
 * @example
 * ```ts
 * const { width, height } = textLayout(node, ctx);
 * ```
 */
export function textLayout(node: EvaluatedNode, ctx: DrawContext): TextLayout {
  let layout = ctx.layouts.get(node);
  if (layout === undefined) {
    layout = ctx.text.layout(node, ctx.scope);
    ctx.layouts.set(node, layout);
  }
  return layout;
}

/** Box für Reveal-Clips: Gruppen ohne Maße nutzen die Hülle ihrer Kinder. */
function contentBox(node: EvaluatedNode, box: Rect, ctx: DrawContext): Rect {
  if (box.width > 0 && box.height > 0) return box;
  if (node.type !== 'group') return box;
  let union: Rect | undefined;
  for (const child of node.children) {
    const measured = measuredSize(child, ctx);
    const childBox = contentBox(child, localBox(child, measured), ctx);
    union = unionRect(union, transformRect(localMatrix(child, measured), childBox));
  }
  return union ?? box;
}

/**
 * Zielrechteck einer Quelle `sw × sh` in einer Box nach `fit`.
 *
 * @example
 * ```ts
 * fitRect('contain', 200, 100, { x: 0, y: 0, width: 100, height: 100 }); // { x: 0, y: 25, width: 100, height: 50, clip: false }
 * ```
 */
export function fitRect(fit: unknown, sw: number, sh: number, box: Box): { x: number; y: number; width: number; height: number; clip: boolean } {
  if (fit === 'fill' || sw <= 0 || sh <= 0) return { ...box, clip: false };
  const s = fit === 'cover' ? Math.max(box.width / sw, box.height / sh) : fit === 'none' ? 1 : Math.min(box.width / sw, box.height / sh);
  const w = sw * s;
  const h = sh * s;
  return { x: box.x + (box.width - w) / 2, y: box.y + (box.height - h) / 2, width: w, height: h, clip: fit !== 'contain' };
}

function drawImageInBox(canvas: Canvas, ctx: DrawContext, img: Image, src: Box, box: Box, fit: unknown, smoothing: unknown): void {
  const { ck } = ctx;
  const dst = fitRect(fit, src.width, src.height, box);
  canvas.save();
  if (dst.clip) canvas.clipRect(ck.XYWHRect(box.x, box.y, box.width, box.height), ck.ClipOp.Intersect, true);
  const s = ck.XYWHRect(src.x, src.y, src.width, src.height);
  const d = ck.XYWHRect(dst.x, dst.y, dst.width, dst.height);
  const paint = ctx.scope.add(new ck.Paint());
  paint.setAntiAlias(true);
  if (smoothing === 'cubic') canvas.drawImageRectCubic(img, s, d, 1 / 3, 1 / 3, paint);
  else canvas.drawImageRectOptions(img, s, d, smoothing === 'nearest' ? ck.FilterMode.Nearest : ck.FilterMode.Linear, ck.MipmapMode.None, paint);
  canvas.restore();
}

// ---------------------------------------------------------------------------
// Formen
// ---------------------------------------------------------------------------

function cornerRadii(node: EvaluatedNode, w: number, h: number): [number, number, number, number] {
  const r = node.props['cornerRadius'];
  const limit = Math.min(w, h) / 2;
  const clamp = (v: unknown): number => (typeof v === 'number' && v > 0 ? Math.min(v, limit) : 0);
  if (Array.isArray(r)) return [clamp(r[0]), clamp(r[1]), clamp(r[2]), clamp(r[3])];
  const v = clamp(r);
  return [v, v, v, v];
}

function shapePath(node: EvaluatedNode, ctx: DrawContext): Path | undefined {
  const { ck, scope } = ctx;
  const b: PathBuilder = new ck.PathBuilder();
  switch (node.type) {
    case 'rect': {
      const w = getNumber(node, 'width', 0);
      const h = getNumber(node, 'height', 0);
      const [tl, tr, br, bl] = cornerRadii(node, w, h);
      b.addRRect(Float32Array.of(0, 0, w, h, tl, tl, tr, tr, br, br, bl, bl));
      break;
    }
    case 'ellipse':
      b.addOval(ck.XYWHRect(0, 0, getNumber(node, 'width', 0), getNumber(node, 'height', 0)));
      break;
    case 'line': {
      const a = getVec2(node, 'from', { x: 0, y: 0 });
      const c = getVec2(node, 'to', { x: 0, y: 0 });
      b.moveTo(a.x, a.y);
      b.lineTo(c.x, c.y);
      break;
    }
    case 'polyline':
    case 'polygon': {
      const pts = getPoints(node, 'points');
      const first = pts[0];
      if (first === undefined) break;
      b.moveTo(first[0], first[1]);
      for (const p of pts.slice(1)) b.lineTo(p[0], p[1]);
      if (node.type === 'polygon') b.close();
      break;
    }
    case 'path': {
      b.delete();
      const d = node.props['d'];
      if (typeof d !== 'string') return undefined;
      const path = nullable(ck.Path.MakeFromSVGString(d));
      if (path === null) {
        throw new OpenVideoError({
          code: 'OV_PATH_INVALID',
          errorClass: 'SkiaRendererError',
          problem: 'Path data "d" cannot be parsed.',
          nodeId: node.id,
          pointer: `${node.pointer}/d`,
          received: JSON.stringify(d.slice(0, 80)),
          suggestions: ['Use valid SVG path data, e.g. "M0 0 L100 0 L100 100 Z".'],
        });
      }
      scope.add(path);
      path.setFillType(node.props['fillRule'] === 'evenodd' ? ck.FillType.EvenOdd : ck.FillType.Winding);
      return path;
    }
    default:
      break;
  }
  return scope.add(b.detachAndDelete());
}

/** Beschneidet eine Kontur entlang der Pfadlänge (trimStart, trimEnd, trimOffset). */
function trimmed(path: Path, node: EvaluatedNode, scope: Scope): Path | undefined {
  const start = getNumber(node, 'trimStart', 0);
  const end = getNumber(node, 'trimEnd', 1);
  const offset = getNumber(node, 'trimOffset', 0);
  if (start <= 0 && end >= 1) return path;
  if (end <= start) return undefined;
  const s = (((start + offset) % 1) + 1) % 1;
  const e = s + (end - start);
  const copy = scope.add(path.copy());
  if (e <= 1) return nullable(copy.makeTrimmed(s, e, false)) ?? undefined;
  // Über das Pfadende hinaus: Komplement des Bereichs (e − 1, s).
  return nullable(copy.makeTrimmed(e - 1, s, true)) ?? undefined;
}

function drawShape(canvas: Canvas, node: EvaluatedNode, box: Box, ctx: DrawContext): void {
  const { ck, scope } = ctx;
  const path = shapePath(node, ctx);
  if (path === undefined) return;
  const fillValue = effectiveFill(node);
  const strokeValue = node.props['stroke'];
  if (node.type === 'line' || (node.type === 'polyline' && node.props['fill'] === undefined)) {
    // Linien zeichnen nur Kontur; ohne stroke mit der Füllfarbe (Standard weiß).
    const color = strokeValue ?? (node.type === 'line' ? fillValue : '#FFFFFF');
    const paint = paintFor(ck, scope, color, box);
    if (paint === undefined) return;
    applyStroke(ck, scope, paint, node, 1);
    const p = trimmed(path, node, scope);
    if (p !== undefined) canvas.drawPath(p, paint);
    return;
  }
  const fill = paintFor(ck, scope, fillValue, box);
  if (fill !== undefined) canvas.drawPath(path, fill);
  const stroke = paintFor(ck, scope, strokeValue, box);
  if (stroke !== undefined) {
    applyStroke(ck, scope, stroke, node, 1);
    const p = trimmed(path, node, scope);
    if (p !== undefined) canvas.drawPath(p, stroke);
  }
}

// ---------------------------------------------------------------------------
// Medien und Effekte
// ---------------------------------------------------------------------------

function drawSprite(canvas: Canvas, node: EvaluatedNode, box: Box, ctx: DrawContext): void {
  const img = ctx.resources.images.get(String(node.props['asset']));
  if (img === undefined) return;
  const cols = Math.max(1, Math.floor(getNumber(node, 'columns', 1)));
  const rows = Math.max(1, Math.floor(getNumber(node, 'rows', 1)));
  const count = Math.max(1, Math.floor(getNumber(node, 'frameCount', cols * rows)));
  const explicit = node.props['frame'];
  let index = typeof explicit === 'number' ? Math.floor(explicit) : Math.floor(localSeconds(node, ctx.scene.fps) * getNumber(node, 'frameRate', ctx.scene.fps) + 1e-9);
  index = node.props['loop'] === true ? ((index % count) + count) % count : Math.min(Math.max(index, 0), count - 1);
  const cw = img.width() / cols;
  const ch = img.height() / rows;
  const src = { x: (index % cols) * cw, y: Math.floor(index / cols) * ch, width: cw, height: ch };
  drawImageInBox(canvas, ctx, img, src, box, node.props['fit'] ?? 'fill', 'linear');
}

function drawLottie(canvas: Canvas, node: EvaluatedNode, box: Box, ctx: DrawContext): void {
  const anim = ctx.resources.lottie.get(String(node.props['asset']));
  if (anim === undefined) return;
  const lottieFps = anim.fps();
  const total = anim.duration() * lottieFps;
  const speed = getNumber(node, 'speed', 1);
  // Frame-genau: Composition-Frames direkt in Lottie-Frames umrechnen.
  let frame = (node.time.localFrame * speed * lottieFps) / ctx.scene.fps + getNumber(node, 'frameOffset', 0);
  if (node.props['loop'] === true && total > 0) frame = ((frame % total) + total) % total;
  else frame = Math.min(Math.max(frame, 0), total);
  anim.seekFrame(frame);
  const [w = 0, h = 0] = anim.size();
  const dst = fitRect(node.props['fit'] ?? 'contain', w, h, box);
  canvas.save();
  if (dst.clip) canvas.clipRect(ctx.ck.XYWHRect(box.x, box.y, box.width, box.height), ctx.ck.ClipOp.Intersect, true);
  anim.render(canvas, ctx.ck.XYWHRect(dst.x, dst.y, dst.width, dst.height));
  canvas.restore();
}

function drawShader(canvas: Canvas, node: EvaluatedNode, box: Box, ctx: DrawContext): void {
  const { ck, scope } = ctx;
  const sksl = node.props['sksl'];
  if (typeof sksl !== 'string') return;
  const effect = ctx.effect(sksl, node);
  const floats = new Float32Array(effect.getUniformFloatCount());
  const custom = isRecord(node.props['uniforms']) ? node.props['uniforms'] : {};
  for (let i = 0; i < effect.getUniformCount(); i++) {
    const name = effect.getUniformName(i);
    const u = effect.getUniform(i);
    let values: readonly number[];
    if (name === 'time') values = [localSeconds(node, ctx.scene.fps)];
    else if (name === 'frame') values = [node.time.localFrame];
    else if (name === 'resolution') values = [box.width, box.height];
    else {
      const v = custom[name];
      values = typeof v === 'number' ? [v] : Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
    }
    for (let k = 0; k < u.columns * u.rows; k++) floats[u.slot + k] = values[k] ?? 0;
  }
  const paint = scope.add(new ck.Paint());
  paint.setShader(scope.add(effect.makeShader(floats)));
  canvas.drawRect(ck.XYWHRect(0, 0, box.width, box.height), paint);
}

function drawParticles(canvas: Canvas, node: EvaluatedNode, ctx: DrawContext): void {
  const { ck, scope } = ctx;
  const fps = ctx.scene.fps;
  const t = localSeconds(node, fps);
  const alive = particles2d(node, t, fps);
  const shape = node.props['shape'];
  const previous = shape === 'spark' ? new Map(particles2d(node, t - 1 / fps, fps).map((p) => [p.index, p])) : undefined;
  const paint = scope.add(new ck.Paint());
  paint.setAntiAlias(true);
  for (const p of alive) {
    if (p.opacity <= 0 || p.size <= 0) continue;
    paint.setColor(toColor(ck, p.color, p.opacity));
    if (shape === 'square') {
      canvas.save();
      canvas.translate(p.x, p.y);
      canvas.rotate(p.rotation, 0, 0);
      paint.setStyle(ck.PaintStyle.Fill);
      canvas.drawRect(ck.XYWHRect(-p.size / 2, -p.size / 2, p.size, p.size), paint);
      canvas.restore();
    } else if (shape === 'spark') {
      const prev = previous?.get(p.index);
      let angle = (p.rotation * Math.PI) / 180;
      if (prev !== undefined && (prev.x !== p.x || prev.y !== p.y)) angle = Math.atan2(p.y - prev.y, p.x - prev.x);
      const len = 3 * p.size;
      paint.setStyle(ck.PaintStyle.Stroke);
      paint.setStrokeWidth(Math.max(1, p.size / 3));
      paint.setStrokeCap(ck.StrokeCap.Round);
      canvas.drawLine(p.x - Math.cos(angle) * len, p.y - Math.sin(angle) * len, p.x, p.y, paint);
    } else {
      paint.setStyle(ck.PaintStyle.Fill);
      canvas.drawCircle(p.x, p.y, p.size / 2, paint);
    }
  }
}

function drawContent(canvas: Canvas, node: EvaluatedNode, box: Box, ctx: DrawContext): void {
  const { ck } = ctx;
  switch (node.type) {
    case 'group': {
      if (node.props['clip'] === true) canvas.clipRect(ck.XYWHRect(0, 0, getNumber(node, 'width', 0), getNumber(node, 'height', 0)), ck.ClipOp.Intersect, true);
      for (const child of node.children) drawNode(canvas, child, ctx);
      return;
    }
    case 'rect':
    case 'ellipse':
    case 'line':
    case 'polyline':
    case 'polygon':
    case 'path':
      drawShape(canvas, node, box, ctx);
      return;
    case 'text':
    case 'rich-text':
      drawTextLayout(canvas, node, textLayout(node, ctx), { ck, scope: ctx.scope, fps: ctx.scene.fps });
      return;
    case 'image': {
      const img = ctx.resources.images.get(String(node.props['asset']));
      if (img !== undefined) drawImageInBox(canvas, ctx, img, { x: 0, y: 0, width: img.width(), height: img.height() }, box, node.props['fit'] ?? 'fill', node.props['smoothing']);
      return;
    }
    case 'video': {
      const img = ctx.resources.videoFrames.get(node);
      // `smoothing` tragen animierte Bilder, die als Video gezeichnet werden (Story 17.4).
      if (img !== undefined) drawImageInBox(canvas, ctx, img, { x: 0, y: 0, width: img.width(), height: img.height() }, box, node.props['fit'] ?? 'fill', node.props['smoothing'] ?? 'linear');
      return;
    }
    case 'svg': {
      const doc = ctx.resources.svgs.get(node);
      if (doc === undefined) return;
      const dst = fitRect(node.props['fit'] ?? 'contain', doc.width, doc.height, box);
      canvas.save();
      if (dst.clip) canvas.clipRect(ck.XYWHRect(box.x, box.y, box.width, box.height), ck.ClipOp.Intersect, true);
      canvas.translate(dst.x, dst.y);
      canvas.scale(dst.width / doc.width, dst.height / doc.height);
      drawSvgDocument(canvas, doc, { ck, scope: ctx.scope, text: ctx.text });
      canvas.restore();
      return;
    }
    case 'sprite':
      drawSprite(canvas, node, box, ctx);
      return;
    case 'lottie':
      drawLottie(canvas, node, box, ctx);
      return;
    case 'shader':
      drawShader(canvas, node, box, ctx);
      return;
    case 'particles':
      drawParticles(canvas, node, ctx);
      return;
    default:
      throw new OpenVideoError({
        code: 'OV_SKIA_UNSUPPORTED',
        errorClass: 'SkiaRendererError',
        problem: `The Skia renderer cannot draw nodes of type "${node.type}".`,
        nodeId: node.id,
        pointer: node.pointer,
        suggestions: ['Set `renderer` to a backend that supports this node type, e.g. "browser" or "three".'],
      });
  }
}

/**
 * Begrenzung für `saveLayer`, wenn der Inhalt sicher in der Box liegt.
 *
 * Ohne Begrenzung ist ein Layer so groß wie der ganze Canvas; Anlegen und Zurückschreiben
 * kosten dann pro Node einen vollen Frame (1080p: rund 8 ms). Außerhalb der Box ist der Layer
 * leer, und leere Pixel ändern das Ziel bei `normal` (SrcOver) nicht. Innen kann sich ein Kanal
 * um 1 ändern, weil Skia Bildkoordinaten relativ zum Layer-Ursprung rundet; das Ergebnis bleibt
 * deterministisch. Deshalb nur ohne Filter, Maske und Blend Mode, und nur für Nodes, deren
 * Zeichnung die Box nie verlässt (Bilder werden auf die Box beschnitten, Flächen ohne Kontur).
 */
function layerBounds(node: EvaluatedNode, box: Box, blend: unknown, hasFilter: boolean): Box | undefined {
  if (hasFilter || node.mask !== undefined || (blend !== undefined && blend !== 'normal')) return undefined;
  if (!(box.width > 0 && box.height > 0)) return undefined;
  switch (node.type) {
    case 'image':
    case 'video':
    case 'sprite':
      return box;
    case 'rect':
    case 'ellipse':
      return node.props['stroke'] === undefined ? box : undefined;
    default:
      return undefined;
  }
}

/**
 * Zeichnet eine Node mit Transform, Reveal-Clip, Opacity, Blend Mode, Filtern, Schatten und Maske.
 *
 * @example
 * ```ts
 * for (const node of request.nodes) drawNode(canvas, node, ctx);
 * ```
 */
export function drawNode(canvas: Canvas, node: EvaluatedNode, ctx: DrawContext): void {
  if (ctx.signal?.aborted === true) throw abortError();
  const { ck, scope } = ctx;
  const transform = getTransform(node);
  if (transform.opacity <= 0) return;
  const measured = measuredSize(node, ctx);
  const box = localBox(node, measured);
  canvas.save();
  canvas.concat(matrix3(localMatrix(node, measured)));
  if (node.reveal !== undefined) {
    const r = revealShape(node.reveal, contentBox(node, box, ctx));
    const rect = ck.XYWHRect(r.x, r.y, Math.max(0, r.width), Math.max(0, r.height));
    if (r.shape === 'ellipse') {
      const b = new ck.PathBuilder();
      b.addOval(rect);
      canvas.clipPath(scope.add(b.detachAndDelete()), ck.ClipOp.Intersect, true);
    } else {
      canvas.clipRect(rect, ck.ClipOp.Intersect, true);
    }
  }
  const blend = node.props['blendMode'];
  const imageFilter = nodeImageFilter(ck, scope, node);
  const needsLayer = transform.opacity < 1 || (blend !== undefined && blend !== 'normal') || imageFilter !== null || node.mask !== undefined;
  if (needsLayer) {
    const layer: Paint = scope.add(new ck.Paint());
    layer.setAlphaf(transform.opacity);
    layer.setBlendMode(blendModeOf(ck, blend));
    if (imageFilter !== null) layer.setImageFilter(imageFilter);
    const bounds = layerBounds(node, box, blend, imageFilter !== null);
    if (bounds !== undefined) canvas.saveLayer(layer, ck.XYWHRect(bounds.x, bounds.y, bounds.width, bounds.height));
    else canvas.saveLayer(layer);
  }
  drawContent(canvas, node, box, ctx);
  if (node.mask !== undefined) {
    // Maske im lokalen Raum der Node: DstIn behält den Inhalt, wo die Maske deckt.
    const maskPaint = scope.add(new ck.Paint());
    maskPaint.setBlendMode(ck.BlendMode.DstIn);
    maskPaint.setColorFilter(maskColorFilter(ck, scope, node.mask.mode, node.mask.invert));
    canvas.saveLayer(maskPaint);
    if (node.mask.mode === 'luminance') canvas.drawColor(ck.BLACK, ck.BlendMode.Src);
    drawNode(canvas, node.mask.node, ctx);
    canvas.restore();
  }
  if (needsLayer) canvas.restore();
  canvas.restore();
}

/**
 * Alle Nodes eines Baums inklusive Masken-Nodes, in Zeichenreihenfolge.
 *
 * @example
 * ```ts
 * walkNodes(scene.nodes, (node) => ids.push(node.id));
 * ```
 */
export function walkNodes(nodes: readonly EvaluatedNode[], visit: (node: EvaluatedNode) => void): void {
  for (const n of nodes) {
    visit(n);
    walkNodes(n.children, visit);
    if (n.mask !== undefined) walkNodes([n.mask.node], visit);
  }
}
