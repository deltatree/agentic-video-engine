/**
 * Einstieg der Seiten-Laufzeit (`dist/runtime.js`): registriert `window.__ovRuntime`.
 */
import { PIXI_VERSION } from '@agentic-video/renderer-pixi';
import { THREE_VERSION } from '@agentic-video/renderer-three';
import type { PageRuntime } from '../protocol.js';
import { toPageError } from '../page-error.js';
import { renderHtmlLayer } from './html.js';
import { renderPixiLayer } from './pixi.js';
import { renderThreeLayer } from './three.js';

/** Gibt Fehler strukturiert an den Host weiter (Diagnose in der Meldung, Story 21.7). */
function structured<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (error) {
      throw toPageError(error);
    }
  };
}

const runtime: PageRuntime = {
  renderHtml: structured(renderHtmlLayer),
  renderThree: structured(renderThreeLayer),
  renderPixi: structured(renderPixiLayer),
  versions: () => ({ three: THREE_VERSION, pixi: PIXI_VERSION }),
};

window.__ovRuntime = runtime;
