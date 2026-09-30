/**
 * Vorab-Prüfung für das `browser`-Backend (FR-44).
 */
import type { BackendCheck, Diagnostic } from '@agentic-video/core';

/** Fähigkeiten des `browser`-Backends. */
export const HTML_CAPABILITIES: readonly string[] = [
  'browser.html',
  'browser.css',
  'browser.css-animations',
  'browser.web-animations',
  'browser.svg',
  'browser.canvas2d',
  'browser.webgl2',
  'browser.webgpu',
  'browser.web-components',
  'browser.webfonts',
  'browser.scripts.sandboxed',
  'browser.virtual-time',
  'browser.network-blocked',
];

/**
 * Fasst Diagnosen zu einem {@link BackendCheck} zusammen: unterstützt, solange kein Fehler dabei ist.
 *
 * @example
 * ```ts
 * checkResult([]); // { supported: true, diagnostics: [] }
 * ```
 */
export function checkResult(diagnostics: readonly Diagnostic[]): BackendCheck {
  return { supported: !diagnostics.some((d) => d.severity === 'error'), diagnostics };
}

/** Optionen für {@link checkHtmlNode}. */
export interface HtmlCheckOptions {
  /** Laufen Skripte in HTML-Layern (`allowHtmlScripts`, Story 16.1)? Standard: nein. */
  readonly allowScripts?: boolean;
}

/** Standard-HTML-Tags mit Bindestrich (SVG/MathML); alle anderen sind Custom Elements. */
const HYPHENATED_BUILTINS = new Set(['annotation-xml', 'color-profile', 'font-face', 'font-face-src', 'font-face-uri', 'font-face-format', 'font-face-name', 'missing-glyph']);

/**
 * Inhalte, die ohne Skripte leer bleiben (Story 17.6): `<canvas>` (2D, WebGL, WebGPU) und Custom
 * Elements ohne deklaratives Shadow DOM. Liefert je Art einen lesbaren Namen.
 */
function scriptDependentContent(html: string): { readonly canvas?: string; readonly customElements: readonly string[] } {
  const out: { canvas?: string; customElements: string[] } = { customElements: [] };
  if (/<canvas\b/iu.test(html)) {
    const webgpu = /navigator\s*\.\s*gpu|getContext\(\s*['"]webgpu['"]/iu.test(html);
    const webgl = /getContext\(\s*['"](?:experimental-)?webgl2?['"]/iu.test(html);
    out.canvas = webgpu ? 'WebGPU canvas' : webgl ? 'WebGL canvas' : 'canvas';
  }
  // Deklaratives Shadow DOM rendert ohne Skripte; dann sind Custom Elements unkritisch.
  if (!/<template\b[^>]*\bshadowroot(?:mode)?\s*=/iu.test(html)) {
    const tags = new Set<string>();
    for (const m of html.matchAll(/<([a-z][a-z0-9]*-[a-z0-9._-]*)(?=[\s/>])/giu)) {
      const tag = (m[1] ?? '').toLowerCase();
      if (tag !== '' && !HYPHENATED_BUILTINS.has(tag)) tags.add(tag);
    }
    out.customElements = [...tags].sort();
  }
  return out;
}

/**
 * Prüft eine html-Node (IR) für das `browser`-Backend.
 *
 * - `<script>` im Inhalt → `OV_HTML_SCRIPT` (info): Skripte laufen nur ausdrücklich erlaubt und
 *   nur mit OS-Sandbox (ADR 0008, Story 16.1).
 * - Ohne erlaubte Skripte: `<canvas>` (2D, WebGL, WebGPU) → `OV_HTML_CANVAS_NO_SCRIPTS` (warning),
 *   Custom Elements ohne deklaratives Shadow DOM → `OV_HTML_WEB_COMPONENTS_NO_SCRIPTS` (warning);
 *   beides bleibt sonst leer (Story 17.6).
 * - `mask` an der html-Node → `OV_BROWSER_UNSUPPORTED` (error).
 *
 * @example
 * ```ts
 * checkHtmlNode({ id: 'clock', type: 'html', html: '<script>…</script>', width: 100, height: 50 }).diagnostics[0]?.code; // 'OV_HTML_SCRIPT'
 * checkHtmlNode({ id: 'g', type: 'html', html: '<canvas></canvas>', width: 1, height: 1 }).diagnostics[0]?.code; // 'OV_HTML_CANVAS_NO_SCRIPTS'
 * ```
 */
export function checkHtmlNode(node: Readonly<Record<string, unknown>>, options: HtmlCheckOptions = {}): BackendCheck {
  const diagnostics: Diagnostic[] = [];
  const id = node['id'];
  const where = typeof id === 'string' ? { nodeId: id } : {};
  const html = node['html'];
  if (typeof html === 'string' && /<script\b/iu.test(html)) {
    diagnostics.push({
      code: 'OV_HTML_SCRIPT',
      severity: 'info',
      errorClass: 'BrowserRendererError',
      problem: 'HTML content contains <script>; scripts run only when explicitly allowed (--trusted or OPENVIDEO_ALLOW_HTML_SCRIPTS=1) and only if Chromium runs with the OS sandbox, with virtual time and no network.',
      ...where,
      suggestions: ['Use the CLI with --trusted for your own projects, or set OPENVIDEO_ALLOW_HTML_SCRIPTS=1 on a render host with the Chromium OS sandbox (ADR 0008).', 'Drive animation from window.openvideo.onFrame or CSS animations instead of real timers.'],
    });
  }
  if (typeof html === 'string' && options.allowScripts !== true) {
    const found = scriptDependentContent(html);
    const enable = 'Allow scripts for trusted projects: `openvideo render --trusted` or OPENVIDEO_ALLOW_HTML_SCRIPTS=1 on a host with the Chromium OS sandbox (ADR 0008).';
    if (found.canvas !== undefined) {
      diagnostics.push({
        code: 'OV_HTML_CANVAS_NO_SCRIPTS',
        severity: 'warning',
        errorClass: 'BrowserRendererError',
        problem: `HTML content contains a ${found.canvas}, but scripts are disabled; the canvas stays empty in the render.`,
        ...where,
        details: { content: found.canvas },
        suggestions: [enable, found.canvas === 'canvas' ? 'Replace the canvas drawing with SVG or CSS, which render without scripts.' : 'Use a scene3d node (Three.js) or a shader node for GPU content instead of a script-driven canvas.'],
      });
    }
    if (found.customElements.length > 0) {
      diagnostics.push({
        code: 'OV_HTML_WEB_COMPONENTS_NO_SCRIPTS',
        severity: 'warning',
        errorClass: 'BrowserRendererError',
        problem: `HTML content uses custom elements (${found.customElements.join(', ')}), but scripts are disabled; they are never defined and render only their light-DOM content.`,
        ...where,
        details: { elements: found.customElements.join(', ') },
        suggestions: [enable, 'Use declarative shadow DOM (<template shadowrootmode="open">) so the component renders without scripts.'],
      });
    }
  }
  if (node['mask'] !== undefined) {
    diagnostics.push({
      code: 'OV_BROWSER_UNSUPPORTED',
      severity: 'error',
      errorClass: 'BrowserRendererError',
      problem: 'The browser backend cannot apply a node mask to an html node.',
      ...where,
      suggestions: ['Wrap the html node in a group and put the mask on the group.', 'Or use a CSS mask (mask-image) inside the html content.'],
    });
  }
  return checkResult(diagnostics);
}

