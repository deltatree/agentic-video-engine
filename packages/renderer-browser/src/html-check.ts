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

/**
 * Prüft eine html-Node (IR) für das `browser`-Backend.
 *
 * - `<script>` im Inhalt → `OV_HTML_SCRIPT` (info): Skripte laufen nur ausdrücklich erlaubt und
 *   nur mit OS-Sandbox (ADR 0008, Story 16.1).
 * - `mask` an der html-Node → `OV_BROWSER_UNSUPPORTED` (error).
 *
 * @example
 * ```ts
 * checkHtmlNode({ id: 'clock', type: 'html', html: '<script>…</script>', width: 100, height: 50 }).diagnostics[0]?.code; // 'OV_HTML_SCRIPT'
 * ```
 */
export function checkHtmlNode(node: Readonly<Record<string, unknown>>): BackendCheck {
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

