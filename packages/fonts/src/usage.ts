/**
 * Prüft, ob alle Schriften, die ein Project nutzt, geladen sind, und erzeugt das Schrift-Manifest.
 */
import { DEFAULT_FONT_FAMILY, isRecord, type Diagnostic, type FontResolver, type IrProject } from '@agentic-video/core';

/** Eintrag im Render-Manifest für eine Schrift. */
export interface FontManifestEntry {
  readonly family: string;
  readonly weight: number | readonly [number, number];
  readonly style: 'normal' | 'italic';
  readonly hash: string;
  readonly path: string;
}

/**
 * Listet alle geladenen Schriften für das Render-Manifest.
 *
 * @example
 * ```ts
 * const manifest = { fonts: fontManifest(fontSet) };
 * ```
 */
export function fontManifest(fonts: FontResolver): FontManifestEntry[] {
  return fonts.all().map((f) => ({ family: f.family, weight: f.weight, style: f.style, hash: f.hash, path: f.path }));
}

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] ?? 0;
      prev[j] = Math.min(up + 1, (prev[j - 1] ?? 0) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length] ?? 0;
}

/**
 * Findet den ähnlichsten geladenen Familiennamen.
 *
 * @example
 * ```ts
 * closestFamily('Intr', fonts); // 'Inter'
 * ```
 */
export function closestFamily(name: string, fonts: FontResolver): string | undefined {
  const families = [...new Set(fonts.all().map((f) => f.family))];
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const f of families) {
    const score = distance(name.toLowerCase(), f.toLowerCase());
    if (score < bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return best;
}

function missingDiagnostic(family: string, fonts: FontResolver, where: { path: string; pointer: string; nodeId?: string; compositionId?: string }): Diagnostic {
  const close = closestFamily(family, fonts);
  const suggestions: string[] = [];
  if (close !== undefined) suggestions.push(`Use fontFamily "${close}".`);
  suggestions.push(`Register the font: add { "family": "${family}", "src": "fonts/${family.replace(/\s+/gu, '')}.ttf" } to project.fonts.`);
  return {
    code: 'OV_FONT_MISSING',
    severity: 'warning',
    errorClass: 'FontError',
    problem: `Font family "${family}" is not loaded; the default font is used instead.`,
    path: where.path,
    pointer: where.pointer,
    ...(where.nodeId !== undefined ? { nodeId: where.nodeId } : {}),
    ...(where.compositionId !== undefined ? { compositionId: where.compositionId } : {}),
    received: JSON.stringify(family),
    suggestions,
  };
}

/**
 * Meldet Text-Nodes, deren `fontFamily` nicht geladen ist (`OV_FONT_MISSING`).
 * Prüft auch `rich-text`-Spans, Untertitel und `settings.defaultFont`.
 *
 * @example
 * ```ts
 * const diagnostics = checkFontUsage(project, await loadFontSet({ fonts: project.fonts }));
 * ```
 */
export function checkFontUsage(project: IrProject, fonts: FontResolver): Diagnostic[] {
  const out: Diagnostic[] = [];
  const defaultFont = project.settings?.defaultFont;
  if (defaultFont !== undefined && !fonts.has(defaultFont)) {
    out.push(missingDiagnostic(defaultFont, fonts, { path: 'settings.defaultFont', pointer: '/settings/defaultFont' }));
  }
  const check = (family: unknown, where: { path: string; pointer: string; nodeId?: string; compositionId?: string }): void => {
    if (typeof family === 'string' && !fonts.has(family)) out.push(missingDiagnostic(family, fonts, where));
  };
  const visit = (node: unknown, path: string, pointer: string, compositionId: string): void => {
    if (!isRecord(node)) return;
    const id = typeof node['id'] === 'string' ? node['id'] : '?';
    const here = `${path}.${id}`;
    const where = (key: string, ptr: string) => ({ path: `${here}.${key}`, pointer: `${pointer}/${ptr}`, nodeId: id, compositionId });
    check(node['fontFamily'], where('fontFamily', 'fontFamily'));
    const spans = node['spans'];
    if (Array.isArray(spans)) {
      spans.forEach((span: unknown, i) => {
        if (isRecord(span)) check(span['fontFamily'], where(`spans[${String(i)}].fontFamily`, `spans/${String(i)}/fontFamily`));
      });
    }
    const speakers = node['speakerStyles'];
    if (isRecord(speakers)) {
      for (const [name, style] of Object.entries(speakers)) {
        if (isRecord(style)) check(style['fontFamily'], where(`speakerStyles.${name}.fontFamily`, `speakerStyles/${name}/fontFamily`));
      }
    }
    const children = node['children'];
    if (Array.isArray(children)) children.forEach((c: unknown, i) => { visit(c, `${here}.children`, `${pointer}/children/${String(i)}`, compositionId); });
    const mask = node['mask'];
    if (isRecord(mask)) visit(mask['node'], `${here}.mask`, `${pointer}/mask/node`, compositionId);
  };
  project.compositions.forEach((comp, ci) => {
    comp.nodes.forEach((n, ni) => { visit(n, `composition.${comp.id}.nodes`, `/compositions/${String(ci)}/nodes/${String(ni)}`, comp.id); });
  });
  return out;
}

/**
 * Standardfamilie eines Projects: `settings.defaultFont`, sonst `Inter`.
 *
 * @example
 * ```ts
 * projectDefaultFont({ schemaVersion: '1.0.0', compositions: [] }); // 'Inter'
 * ```
 */
export function projectDefaultFont(project: IrProject): string {
  return project.settings?.defaultFont ?? DEFAULT_FONT_FAMILY;
}
