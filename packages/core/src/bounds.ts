/**
 * Bounding Boxes und Szenen-Diagnosen (FR-25, FR-26).
 */
import type { Diagnostic } from '@agentic-video/schema';
import type { EvaluatedNode, EvaluatedScene, TextMeasurer } from './contracts.js';
import { IDENTITY, multiply, transformRect, unionRect, type Matrix2D, type Rect } from './matrix.js';
import { getNumber, getTransform, localBox, localMatrix } from './props.js';

/** Bounding Box einer Node in Composition-Koordinaten. */
export interface NodeBounds {
  readonly id: string;
  readonly type: string;
  readonly parentId: string | undefined;
  readonly depth: number;
  /** Achsenparallele Hülle in Composition-Pixeln. */
  readonly bounds: Rect;
  /** Lokale Box vor Transformation. */
  readonly box: Rect;
  /** Gesamtmatrix lokal → Composition. */
  readonly matrix: Matrix2D;
  /** Effektive Opacity inklusive Eltern. */
  readonly opacity: number;
  readonly text?: { readonly lines: number; readonly overflow: boolean; readonly missingGlyphs: number; readonly baseline: number };
}

/** Node-Typen ohne 2D-Box (3D-Kinder liegen im 3D-Raum). */
const NO_2D_BOX = new Set(['camera3d', 'light3d', 'mesh3d', 'model3d', 'instances3d', 'particles3d', 'group3d']);

/**
 * Berechnet Bounding Boxes aller 2D-Nodes.
 *
 * @param measurer Misst Text; ohne Messer werden Texte grob geschätzt.
 *
 * @example
 * ```ts
 * const bounds = computeBounds(scene, skiaMeasurer);
 * bounds.find((b) => b.id === 'headline')?.bounds;
 * ```
 */
export function computeBounds(scene: EvaluatedScene, measurer?: TextMeasurer): NodeBounds[] {
  const out: NodeBounds[] = [];
  const visit = (node: EvaluatedNode, parent: Matrix2D, parentId: string | undefined, depth: number, parentOpacity: number): Rect | undefined => {
    if (NO_2D_BOX.has(node.type)) return undefined;
    let measured: { width: number; height: number } | undefined;
    let text: NodeBounds['text'];
    if (node.type === 'text' || node.type === 'rich-text') {
      if (measurer !== undefined) {
        const m = measurer.measure(node);
        measured = { width: m.width, height: m.height };
        text = { lines: m.lines, overflow: m.overflow, missingGlyphs: m.missingGlyphs, baseline: m.baseline };
      } else {
        const size = getNumber(node, 'fontSize', 48);
        const content = typeof node.props['text'] === 'string' ? node.props['text'] : '';
        const lines = content.split('\n');
        measured = { width: getNumber(node, 'width', Math.max(...lines.map((l) => l.length)) * size * 0.55), height: lines.length * size * getNumber(node, 'lineHeight', 1.2) };
      }
    }
    const matrix = multiply(parent, localMatrix(node, measured));
    const opacity = parentOpacity * getTransform(node).opacity;
    let box: Rect = localBox(node, measured);
    let childUnion: Rect | undefined;
    for (const child of node.children) {
      const r = visit(child, matrix, node.id, depth + 1, opacity);
      if (r !== undefined) childUnion = unionRect(childUnion, r);
    }
    let bounds = transformRect(matrix, box);
    if (node.type === 'group' && box.width === 0 && box.height === 0) {
      if (childUnion !== undefined) bounds = childUnion;
      box = { x: 0, y: 0, width: 0, height: 0 };
    }
    const stroke = getNumber(node, 'strokeWidth', 0);
    if (stroke > 0 && node.props['stroke'] !== undefined) bounds = { x: bounds.x - stroke / 2, y: bounds.y - stroke / 2, width: bounds.width + stroke, height: bounds.height + stroke };
    out.push({ id: node.id, type: node.type, parentId, depth, bounds, box, matrix, opacity, ...(text !== undefined ? { text } : {}) });
    return bounds;
  };
  for (const node of scene.nodes) visit(node, IDENTITY, undefined, 0, 1);
  return out;
}

function inside(inner: Rect, outer: Rect): boolean {
  const eps = 0.5;
  return inner.x >= outer.x - eps && inner.y >= outer.y - eps && inner.x + inner.width <= outer.x + outer.width + eps && inner.y + inner.height <= outer.y + outer.height + eps;
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * Prüft einen Frame auf Safe-Area-Verletzungen, Überlauf und Text-Probleme.
 *
 * Regeln:
 * - Text außerhalb der Title-Safe-Zone → Warnung `OV_SAFE_AREA`.
 * - Andere Nodes außerhalb der Action-Safe-Zone → Hinweis `OV_SAFE_AREA`,
 *   außer flächige Hintergründe (≥ 90 % der Fläche) und unsichtbare Nodes.
 * - Node ganz außerhalb des Bildes → Hinweis `OV_OUT_OF_FRAME`.
 * - Text teilweise außerhalb des Bildes → Warnung `OV_OVERFLOW`.
 * - Text mit Überlauf (maxLines, Breite) → Warnung `OV_TEXT_OVERFLOW`.
 * - Fehlende Glyphen → Warnung `OV_MISSING_GLYPHS`.
 */
export function analyzeScene(scene: EvaluatedScene, bounds: readonly NodeBounds[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const frameRect: Rect = { x: 0, y: 0, width: scene.width, height: scene.height };
  const safe = (m: number): Rect => ({ x: scene.width * m, y: scene.height * m, width: scene.width * (1 - 2 * m), height: scene.height * (1 - 2 * m) });
  const titleSafe = safe(scene.safeArea.title);
  const actionSafe = safe(scene.safeArea.action);
  const base = { errorClass: 'SceneDiagnostic', frame: scene.frame, compositionId: scene.compositionId } as const;
  for (const b of bounds) {
    if (b.opacity <= 0.001 || b.bounds.width <= 0 || b.bounds.height <= 0) continue;
    const isText = b.type === 'text' || b.type === 'rich-text';
    const area = b.bounds.width * b.bounds.height;
    const isBackground = area >= scene.width * scene.height * 0.9;
    const details = { x: Math.round(b.bounds.x), y: Math.round(b.bounds.y), width: Math.round(b.bounds.width), height: Math.round(b.bounds.height) };
    if (!intersects(b.bounds, frameRect)) {
      out.push({ ...base, code: 'OV_OUT_OF_FRAME', severity: 'info', nodeId: b.id, problem: `Node "${b.id}" is completely outside the frame.`, details, suggestions: ['Move the node into the frame or hide it in this frame.'] });
      continue;
    }
    if (isText && !inside(b.bounds, frameRect)) {
      out.push({ ...base, code: 'OV_OVERFLOW', severity: 'warning', nodeId: b.id, problem: `Text "${b.id}" is cut off at the frame edge.`, details, suggestions: ['Reduce fontSize, set a wrap width, or move the text inward.'] });
    } else if (isText && !inside(b.bounds, titleSafe)) {
      out.push({ ...base, code: 'OV_SAFE_AREA', severity: 'warning', nodeId: b.id, problem: `Text "${b.id}" leaves the title-safe area.`, details: { ...details, safeMargin: scene.safeArea.title }, suggestions: [`Keep text inside x ${String(Math.round(titleSafe.x))}–${String(Math.round(titleSafe.x + titleSafe.width))}, y ${String(Math.round(titleSafe.y))}–${String(Math.round(titleSafe.y + titleSafe.height))}.`] });
    } else if (!isText && !isBackground && b.depth === 0 && !inside(b.bounds, actionSafe) && inside(b.bounds, frameRect)) {
      out.push({ ...base, code: 'OV_SAFE_AREA', severity: 'info', nodeId: b.id, problem: `Node "${b.id}" leaves the action-safe area.`, details, suggestions: ['Move important content inward.'] });
    }
    if (b.text?.overflow === true) {
      out.push({ ...base, code: 'OV_TEXT_OVERFLOW', severity: 'warning', nodeId: b.id, problem: `Text "${b.id}" does not fit its box (${String(b.text.lines)} lines).`, details, suggestions: ['Reduce fontSize, shorten the text, or increase width/maxLines.'] });
    }
    if (b.text !== undefined && b.text.missingGlyphs > 0) {
      out.push({ ...base, code: 'OV_MISSING_GLYPHS', severity: 'warning', nodeId: b.id, problem: `Text "${b.id}" has ${String(b.text.missingGlyphs)} characters the font cannot draw.`, suggestions: ['Use a font that covers these characters, or add a fallback font to project.fonts.'] });
    }
  }
  return out;
}
