/**
 * Einstieg der Seiten-Laufzeit (`dist/runtime.js`): registriert `window.__ovRuntime`.
 */
import { PIXI_VERSION } from '@agentic-video/renderer-pixi';
import { THREE_VERSION } from '@agentic-video/renderer-three';
import type { PageRuntime } from '../protocol.js';
import { renderHtmlLayer } from './html.js';
import { renderPixiLayer } from './pixi.js';
import { renderThreeLayer } from './three.js';

const runtime: PageRuntime = {
  renderHtml: renderHtmlLayer,
  renderThree: renderThreeLayer,
  renderPixi: renderPixiLayer,
  versions: () => ({ three: THREE_VERSION, pixi: PIXI_VERSION }),
};

window.__ovRuntime = runtime;
