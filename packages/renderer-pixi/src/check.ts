/**
 * Vorab-Prüfung für den PixiJS-Renderer (FR-31, FR-44): meldet Node-Typen und Properties,
 * die PixiJS nicht wie Skia darstellen kann, als `OV_PIXI_UNSUPPORTED` mit Vorschlag `renderer: 'skia'`.
 */
import { isRecord, type Diagnostic, type Severity } from '@agentic-video/core';

/** Node-Typen, die der PixiJS-Renderer zeichnet. */
export const PIXI_NODE_TYPES: readonly string[] = ['group', 'rect', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'text', 'rich-text', 'image', 'video', 'sprite', 'shader', 'particles'];

/** Blend Modes, die PixiJS (mit `pixi.js/advanced-blend-modes` und dem eigenen `hue`-Filter) kennt. */
export const PIXI_BLEND_MODES: readonly string[] = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'add',
];

const SUGGESTION = "Set renderer: 'skia' on this node.";

interface Ctx {
  readonly out: Diagnostic[];
}

function report(ctx: Ctx, node: Readonly<Record<string, unknown>>, pointer: string, problem: string, feature: string, severity: Severity = 'warning', extra: readonly string[] = []): void {
  ctx.out.push({
    code: 'OV_PIXI_UNSUPPORTED',
    severity,
    errorClass: 'PixiRendererError',
    problem,
    nodeId: typeof node['id'] === 'string' ? node['id'] : '(unknown)',
    pointer,
    details: { feature },
    suggestions: [SUGGESTION, ...extra],
  });
}

function isConic(paint: unknown): boolean {
  return isRecord(paint) && paint['type'] === 'conic';
}

const TEXT_PROPS: readonly (readonly [string, string])[] = [
  ['textPath', 'Text along a path (textPath) is not supported by PixiJS.'],
  ['textAnimation', 'Per-unit text animation (textAnimation) is not supported by PixiJS.'],
  ['maxLines', 'maxLines is not supported by PixiJS; the text is not truncated.'],
  ['ellipsis', 'ellipsis is not supported by PixiJS.'],
  ['fontFeatures', 'OpenType features (fontFeatures) are not supported by PixiJS.'],
  ['fontVariations', 'Variable font axes (fontVariations) are not supported by PixiJS.'],
];

/** Stil-Eigenschaften eines Textes oder Spans, die PixiJS nicht darstellt. */
function checkTextStyle(style: Readonly<Record<string, unknown>>, pointer: string, node: Readonly<Record<string, unknown>>, ctx: Ctx): void {
  const decoration = style['decoration'];
  if (decoration !== undefined && decoration !== 'none') report(ctx, node, `${pointer}/decoration`, 'Text decoration is not supported by PixiJS.', 'text.decoration');
  if (style === node && node['direction'] === 'rtl') report(ctx, node, `${pointer}/direction`, 'Right-to-left text is not supported by PixiJS.', 'text.rtl');
  const stretch = style['fontStretch'];
  if (stretch !== undefined && stretch !== 100) report(ctx, node, `${pointer}/fontStretch`, 'fontStretch is not supported by PixiJS.', 'text.fontStretch');
  for (const key of ['fontFeatures', 'fontVariations']) {
    if (style !== node && style[key] !== undefined) report(ctx, node, `${pointer}/${key}`, `${key} in a span is not supported by PixiJS.`, `text.${key}`);
  }
  for (const key of ['fill', 'stroke']) {
    if (style !== node && isConic(style[key])) report(ctx, node, `${pointer}/${key}`, 'Conic gradients are not supported by PixiJS.', 'gradient.conic', 'warning', ['Use a linear or radial gradient.']);
  }
}

function checkOne(node: Readonly<Record<string, unknown>>, pointer: string, ctx: Ctx): void {
  const type = String(node['type']);
  if (!PIXI_NODE_TYPES.includes(type)) {
    report(ctx, node, pointer, `Node type "${type}" is not supported by the PixiJS renderer.`, `node.${type}`, 'error');
    return;
  }
  const blend = node['blendMode'];
  if (typeof blend === 'string' && !PIXI_BLEND_MODES.includes(blend)) report(ctx, node, `${pointer}/blendMode`, `Blend mode "${blend}" is not supported by PixiJS.`, `blendMode.${blend}`, 'warning', [`Use one of: ${PIXI_BLEND_MODES.join(', ')}.`]);
  if (node['shadow'] !== undefined) report(ctx, node, `${pointer}/shadow`, 'Drop shadows are not supported by the PixiJS renderer.', 'shadow');
  for (const key of ['fill', 'stroke']) {
    if (isConic(node[key])) report(ctx, node, `${pointer}/${key}`, 'Conic gradients are not supported by PixiJS.', 'gradient.conic', 'warning', ['Use a linear or radial gradient.']);
  }
  if (node['strokeDash'] !== undefined) report(ctx, node, `${pointer}/strokeDash`, 'Dashed strokes (strokeDash) are not supported by PixiJS.', 'strokeDash');
  for (const key of ['trimStart', 'trimEnd', 'trimOffset']) {
    if (node[key] !== undefined) report(ctx, node, `${pointer}/${key}`, `Stroke trimming (${key}) is not supported by PixiJS.`, 'trim');
  }
  if (node['fillRule'] === 'evenodd') report(ctx, node, `${pointer}/fillRule`, 'fillRule "evenodd" is not supported by PixiJS.', 'fillRule.evenodd');
  if (type === 'text' || type === 'rich-text') {
    for (const [key, problem] of TEXT_PROPS) if (node[key] !== undefined) report(ctx, node, `${pointer}/${key}`, problem, `text.${key}`);
    checkTextStyle(node, pointer, node, ctx);
    const spans = node['spans'];
    if (type === 'rich-text' && Array.isArray(spans)) {
      spans.forEach((span: unknown, i) => {
        if (isRecord(span)) checkTextStyle(span, `${pointer}/spans/${String(i)}`, node, ctx);
      });
    }
  }
  if (type === 'image' && node['smoothing'] === 'cubic') report(ctx, node, `${pointer}/smoothing`, 'Cubic smoothing is not supported by PixiJS; linear is used.', 'image.smoothing.cubic', 'info');
  if (type === 'video' && node['loop'] === true) {
    report(ctx, node, `${pointer}/loop`, 'Looping video needs the video duration, which the PixiJS layer input does not provide; the time is clamped by the host.', 'video.loop', 'warning');
  }
  if (type === 'shader') {
    if (typeof node['glsl'] !== 'string') {
      report(ctx, node, `${pointer}/glsl`, 'The PixiJS renderer needs GLSL source (glsl); SkSL is only supported by Skia.', 'shader.sksl', 'error', ['Add glsl: "void mainImage(out vec4 fragColor, in vec2 fragCoord) { fragColor = vec4(fragCoord / resolution, 0.5, 1.0); }"']);
    }
    const uniforms = node['uniforms'];
    if (isRecord(uniforms)) {
      for (const [name, value] of Object.entries(uniforms)) {
        if (Array.isArray(value) && (value.length < 1 || value.length > 4)) report(ctx, node, `${pointer}/uniforms/${name}`, `Uniform "${name}" has ${String(value.length)} values; PixiJS shaders take 1 to 4.`, 'shader.uniform-array');
      }
    }
  }
  const mask = node['mask'];
  if (isRecord(mask) && isRecord(mask['node'])) checkOne(mask['node'], `${pointer}/mask/node`, ctx);
  const children = node['children'];
  if (Array.isArray(children)) {
    children.forEach((child: unknown, i) => {
      if (isRecord(child)) checkOne(child, `${pointer}/children/${String(i)}`, ctx);
    });
  }
}

/**
 * Prüft eine IR-Node (samt Kindern und Maske) auf Features, die PixiJS nicht darstellen kann.
 * Nicht unterstützte Node-Typen sind Fehler; ignorierte Properties sind Warnungen.
 *
 * @example
 * ```ts
 * checkPixiNode({ id: 'title', type: 'text', text: 'Hi', textPath: { d: 'M0 0 L100 0' } });
 * // [{ code: 'OV_PIXI_UNSUPPORTED', severity: 'warning', … }]
 * ```
 */
export function checkPixiNode(node: Readonly<Record<string, unknown>>): Diagnostic[] {
  const ctx: Ctx = { out: [] };
  checkOne(node, '', ctx);
  return ctx.out;
}
