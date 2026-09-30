/**
 * Strukturierte Fehler über die Grenze Seite → Host (Story 21.7): Playwright überträgt aus
 * `page.evaluate` nur die Fehlermeldung. Die Seiten-Laufzeit verpackt darum die Diagnose eines
 * `OpenVideoError` als JSON zwischen Markern in die Meldung; der Host packt sie wieder aus.
 */
import { OpenVideoError, isRecord, type Diagnostic } from '@agentic-video/core';

const START = '[ov-diagnostic]';
const END = '[/ov-diagnostic]';

/**
 * Verpackt einen `OpenVideoError` der Seite als `Error`, dessen Meldung die Diagnose trägt.
 * Andere Fehler kommen unverändert zurück; der Host übersetzt sie wie bisher (z. B.
 * `OV_BROWSER_TIMER_LIMIT` aus der virtuellen Uhr, sonst `OV_BROWSER_RENDER`).
 *
 * @example
 * ```ts
 * try { await renderPixiLayer(p, url); } catch (error) { throw toPageError(error); }
 * ```
 */
export function toPageError(error: unknown): unknown {
  if (!(error instanceof OpenVideoError)) return error;
  const diagnostic = error.diagnostic;
  return new Error(`${diagnostic.errorClass}: ${diagnostic.problem} ${START}${JSON.stringify(diagnostic)}${END}`);
}

function isDiagnostic(value: unknown): value is Diagnostic {
  return (
    isRecord(value) &&
    typeof value['code'] === 'string' &&
    typeof value['errorClass'] === 'string' &&
    typeof value['problem'] === 'string' &&
    (value['severity'] === 'error' || value['severity'] === 'warning' || value['severity'] === 'info') &&
    Array.isArray(value['suggestions']) &&
    value['suggestions'].every((s) => typeof s === 'string')
  );
}

/**
 * Liest die Diagnose aus einer Fehlermeldung von `page.evaluate` (siehe {@link toPageError}).
 *
 * @example
 * ```ts
 * const d = pageDiagnostic(String(error)); // { code: 'OV_PIXI_ASSET_LOAD', … } oder undefined
 * ```
 */
export function pageDiagnostic(message: string): Diagnostic | undefined {
  const start = message.indexOf(START);
  const end = message.indexOf(END, start);
  if (start < 0 || end < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.slice(start + START.length, end));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  return isDiagnostic(parsed) ? parsed : undefined;
}

/**
 * Macht aus einem Fehler des Render-Hosts einen `OpenVideoError`: Diagnosen aus der Seite bleiben
 * erhalten (auch wenn der Host sie schon als `OV_BROWSER_RENDER` verpackt hat), andere
 * `OpenVideoError` bleiben unverändert, sonstige Fehler werden `OV_BROWSER_LAYER_FAILED`.
 *
 * @example
 * ```ts
 * try { return await host.render(kind, payload); } catch (error) { throw hostLayerError(error, kind, nodeIds); }
 * ```
 */
export function hostLayerError(error: unknown, kind: string, nodeIds: readonly string[]): OpenVideoError {
  // Der Host übersetzt Seitenfehler selbst (`OV_BROWSER_RENDER`); die Diagnose der Seite steckt dann in `cause`.
  const source = error instanceof OpenVideoError ? error.cause : error;
  const message = source instanceof Error ? source.message : String(source);
  const diagnostic = source === undefined ? undefined : pageDiagnostic(message);
  if (diagnostic === undefined && error instanceof OpenVideoError) return error;
  if (diagnostic !== undefined) {
    const { severity: _severity, ...rest } = diagnostic;
    return new OpenVideoError({ ...rest, ...(rest.nodeId === undefined && nodeIds.length === 1 && nodeIds[0] !== undefined ? { nodeId: nodeIds[0] } : {}), cause: error });
  }
  return new OpenVideoError({
    code: 'OV_BROWSER_LAYER_FAILED',
    errorClass: 'BrowserRendererError',
    problem: `The ${kind} layer with node(s) ${nodeIds.join(', ')} could not be rendered: ${message.split('\n')[0] ?? message}`,
    ...(nodeIds.length === 1 && nodeIds[0] !== undefined ? { nodeId: nodeIds[0] } : {}),
    details: { layer: kind },
    cause: error,
    suggestions: ['Run `openvideo doctor` to check Chromium, WebGL and WebGPU.', `Render only this layer with \`openvideo frame\` to reproduce the error.`],
  });
}
