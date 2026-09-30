/**
 * HTML-Layer in der Seite: ein iframe je `html`-Node.
 *
 * Entscheidung iframe `srcdoc` statt Shadow DOM:
 * - Styles sind vollständig getrennt; auch `html`, `body`, `:root` und `@keyframes`
 *   einer Node wirken nicht auf andere Nodes.
 * - `<script>`-Elemente laufen (per `innerHTML` in Shadow DOM liefen sie nicht), und
 *   globale Namen wie `window.t` für `id="t"` verhalten sich wie in einer normalen Seite.
 * - Jedes Dokument hat eine eigene virtuelle Uhr (`addInitScript` läuft auch in iframes).
 * - `srcdoc` erbt die Origin der Host-Seite; `/assets/<id>` und `/fonts.css` bleiben erreichbar.
 *
 * Skripte (D1, ADR 0008): Ohne `allowScripts` bekommt das iframe `sandbox="allow-same-origin"`
 * (kein `allow-scripts`) und das Dokument als erstes Element die CSP `script-src 'none'`.
 * Damit laufen weder `<script>` noch Event-Handler, `javascript:`-URLs oder verschachtelte
 * iframes. Die Host-Seite liest das Dokument weiter (gleiche Origin) und stellt Animationen
 * und CSS-Variablen selbst auf den Frame.
 * Mit `allowScripts` hat das iframe `allow-scripts allow-same-origin`. Diese Kombination ist
 * keine Grenze: Ein Skript kann die Host-Seite erreichen. Die Host-Seite braucht aber Zugriff
 * auf das Dokument (Uhr, Schriften, Animationen). Die Grenze ist dann der Container (ADR 0008).
 * `css` kann das `<style>`-Element in keinem Modus verlassen.
 */
import { OpenVideoError, type EvaluatedNode } from '@agentic-video/core';
import { DOCUMENT_NAME_PREFIX, type BrowserLayerPayload, type DocumentConfig, type FrameState, type HtmlRenderOptions } from '../protocol.js';
import { applyFrame, seekAnimations } from './animations.js';
import { clearDefs, defineColorMatrices } from './defs.js';
import { loadFonts } from './fonts.js';
import { htmlNodeStyle } from './style.js';

interface Slot {
  readonly signature: string;
  readonly container: HTMLDivElement;
  readonly iframe: HTMLIFrameElement;
  /** Laufen Skripte in diesem Dokument? */
  readonly scripts: boolean;
  /** Zeit des zuletzt gerenderten Frames (für Dokumente ohne eigene Uhr). */
  now: number;
}

/** CSP als erstes Element im Dokument ohne Skripte. */
const NO_SCRIPT_CSP = `<meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'">`;

/**
 * Verhindert, dass `css` das `<style>`-Element beendet. Im HTML-Parser endet `<style>` nur an
 * `</style`; `<\/style` ist in CSS gleichwertig (Escape von `/`) und beendet es nicht.
 */
function styleText(css: string): string {
  return css.replace(/<\/(style)/giu, '<\\/$1');
}

/** Höchstzahl gehaltener iframes; ältere unbenutzte werden entfernt. */
const MAX_SLOTS = 32;

const slots = new Map<string, Slot>();

function element<K extends keyof HTMLElementTagNameMap>(tag: K, id: string): HTMLElementTagNameMap[K] {
  const existing = document.getElementById(id);
  if (existing !== null) existing.remove();
  const el = document.createElement(tag);
  el.id = id;
  document.body.append(el);
  return el;
}

function layerRoot(): HTMLElement {
  const root = document.getElementById('ov-root');
  if (root !== null) return root;
  const el = element('div', 'ov-root');
  el.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden;isolation:isolate;';
  return el;
}

function srcdoc(html: string, css: string, scripts: boolean): string {
  return [
    '<!doctype html><html><head>',
    scripts ? '' : NO_SCRIPT_CSP,
    '<meta charset="utf-8">',
    '<link rel="stylesheet" href="fonts.css">',
    '<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;}</style>',
    `<style>${styleText(css)}</style>`,
    `</head><body>${html}</body></html>`,
  ].join('');
}

async function createSlot(node: EvaluatedNode, payload: BrowserLayerPayload, signature: string, html: string, css: string, scripts: boolean): Promise<Slot> {
  const container = document.createElement('div');
  const iframe = document.createElement('iframe');
  const config: DocumentConfig = { seed: payload.seed, key: node.id, fps: payload.fps };
  iframe.name = DOCUMENT_NAME_PREFIX + JSON.stringify(config);
  iframe.setAttribute('scrolling', 'no');
  iframe.setAttribute('sandbox', scripts ? 'allow-scripts allow-same-origin' : 'allow-same-origin');
  iframe.style.cssText = 'display:block;border:0;margin:0;padding:0;width:100%;height:100%;background:transparent;color-scheme:normal;';
  container.append(iframe);
  layerRoot().append(container);
  const loaded = new Promise<void>((resolve) => {
    iframe.addEventListener('load', () => {
      resolve();
    }, { once: true });
  });
  iframe.srcdoc = srcdoc(html, css, scripts);
  await loaded;
  return { signature, container, iframe, scripts, now: 0 };
}

async function settle(doc: Document): Promise<void> {
  await loadFonts(doc);
  void doc.documentElement.getBoundingClientRect();
  await doc.fonts.ready;
  await Promise.all(
    [...doc.images].map((img) =>
      img.decode().catch((error: unknown) => {
        // Fehlende oder blockierte Bilder rendern leer (Netzblockade, ADR 0013).
        return error;
      }),
    ),
  );
}

/**
 * Rendert einen HTML-Layer in das DOM der Host-Seite; die Aufnahme macht danach der Host.
 *
 * @example
 * ```ts
 * await renderHtmlLayer({ nodes: [htmlNode], width: 640, height: 360, scale: 1, frame: 0, time: 0, fps: 30, seed: 1 }, { allowScripts: false });
 * ```
 */
export async function renderHtmlLayer(payload: BrowserLayerPayload, options: HtmlRenderOptions): Promise<void> {
  const scripts = options.allowScripts;
  clearDefs();
  for (const slot of slots.values()) slot.container.style.display = 'none';
  const used = new Set<string>();
  const docs: Document[] = [document];
  let index = 0;
  for (const node of payload.nodes) {
    if (node.type !== 'html') {
      throw new OpenVideoError({
        code: 'OV_BROWSER_PAYLOAD',
        errorClass: 'BrowserRendererError',
        problem: `Node "${node.id}" has type "${node.type}"; the browser backend renders only "html" nodes.`,
        nodeId: node.id,
        pointer: node.pointer,
        suggestions: ['Set renderer only on html nodes to "browser"; other node types use their default backend.'],
      });
    }
    const html = typeof node.props['html'] === 'string' ? node.props['html'] : '';
    const css = typeof node.props['css'] === 'string' ? node.props['css'] : '';
    const signature = JSON.stringify([html, css, payload.seed, payload.fps, scripts]);
    const timeMs = (node.time.localFrame / payload.fps) * 1000;
    if (!Number.isFinite(timeMs)) {
      throw new OpenVideoError({
        code: 'OV_BROWSER_PAYLOAD',
        errorClass: 'BrowserRendererError',
        problem: `HTML node "${node.id}" has a non-finite local time.`,
        nodeId: node.id,
        pointer: node.pointer,
        suggestions: ['Check the fps of the composition and the timing of the node (from, duration, speed).'],
      });
    }
    let slot = slots.get(node.id);
    if (slot === undefined || slot.signature !== signature || timeMs < slot.now) {
      slot?.container.remove();
      slot = await createSlot(node, payload, signature, html, css, scripts);
      slots.set(node.id, slot);
    }
    // Zeichenreihenfolge über z-index: ein iframe im DOM zu verschieben würde es neu laden.
    used.add(node.id);
    const slotIndex = index++;
    const style = htmlNodeStyle(node, payload.scale, (i) => `ov-cm-${String(slotIndex)}-${String(i)}`);
    defineColorMatrices(style.colorMatrices, (i) => `ov-cm-${String(slotIndex)}-${String(i)}`);
    const c = slot.container.style;
    c.display = 'block';
    c.zIndex = String(slotIndex);
    c.position = 'absolute';
    c.left = '0';
    c.top = '0';
    c.width = `${String(style.width)}px`;
    c.height = `${String(style.height)}px`;
    c.transformOrigin = '0 0';
    c.transform = style.transform;
    c.opacity = style.opacity;
    c.mixBlendMode = style.mixBlendMode;
    c.filter = style.filter;
    c.clipPath = style.clipPath;
    c.background = style.background;
    const doc = slot.iframe.contentDocument;
    if (doc === null) {
      throw new OpenVideoError({
        code: 'OV_BROWSER_HTML_DOCUMENT',
        errorClass: 'BrowserRendererError',
        problem: `HTML node "${node.id}" has no readable document.`,
        nodeId: node.id,
        pointer: node.pointer,
        suggestions: ['Render again; the document frame was replaced while loading.', 'Remove navigation (location changes, meta refresh) from the HTML.'],
      });
    }
    await loadFonts(doc);
    const state: FrameState = { timeMs, frame: node.time.localFrame, fps: payload.fps, progress: node.time.progress, seed: payload.seed, key: node.id };
    if (slot.scripts) {
      const clock = slot.iframe.contentWindow?.__ovClock;
      if (clock === undefined) {
        throw new OpenVideoError({
          code: 'OV_BROWSER_HTML_CLOCK',
          errorClass: 'BrowserRendererError',
          problem: `HTML node "${node.id}" has no virtual clock; its scripts replaced or blocked the injected clock.`,
          nodeId: node.id,
          pointer: node.pointer,
          suggestions: ['Do not overwrite window.__ovClock, Date or performance in the HTML scripts.', 'Render the node without scripts (remove --trusted) if it does not need them.'],
        });
      }
      clock.frame(state);
    } else {
      // Ohne Skripte läuft keine Uhr im Dokument; die Host-Seite stellt es von außen.
      applyFrame(doc, state);
      seekAnimations(doc, timeMs);
    }
    slot.now = timeMs;
    docs.push(doc);
  }
  // Speicher begrenzen: unbenutzte iframes entfernen, sobald zu viele gehalten werden.
  if (slots.size > MAX_SLOTS) {
    for (const [id, slot] of slots) {
      if (!used.has(id)) {
        slot.container.remove();
        slots.delete(id);
      }
    }
  }
  await Promise.all(docs.map(settle));
}
