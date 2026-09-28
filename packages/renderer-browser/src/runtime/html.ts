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
 */
import type { EvaluatedNode } from '@agentic-video/core';
import { DOCUMENT_NAME_PREFIX, type BrowserLayerPayload, type DocumentConfig } from '../protocol.js';
import { clearDefs, defineColorMatrices } from './defs.js';
import { loadFonts } from './fonts.js';
import { htmlNodeStyle } from './style.js';

interface Slot {
  readonly signature: string;
  readonly container: HTMLDivElement;
  readonly iframe: HTMLIFrameElement;
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

function srcdoc(html: string, css: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<link rel="stylesheet" href="fonts.css">',
    '<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;}</style>',
    `<style>${css}</style>`,
    `</head><body>${html}</body></html>`,
  ].join('');
}

async function createSlot(node: EvaluatedNode, payload: BrowserLayerPayload, signature: string, html: string, css: string): Promise<Slot> {
  const container = document.createElement('div');
  const iframe = document.createElement('iframe');
  const config: DocumentConfig = { seed: payload.seed, key: node.id, fps: payload.fps };
  iframe.name = DOCUMENT_NAME_PREFIX + JSON.stringify(config);
  iframe.setAttribute('scrolling', 'no');
  iframe.style.cssText = 'display:block;border:0;margin:0;padding:0;width:100%;height:100%;background:transparent;color-scheme:normal;';
  container.append(iframe);
  layerRoot().append(container);
  const loaded = new Promise<void>((resolve) => {
    iframe.addEventListener('load', () => {
      resolve();
    }, { once: true });
  });
  iframe.srcdoc = srcdoc(html, css);
  await loaded;
  return { signature, container, iframe };
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
 * await renderHtmlLayer({ nodes: [htmlNode], width: 640, height: 360, scale: 1, frame: 0, time: 0, fps: 30, seed: 1 });
 * ```
 */
export async function renderHtmlLayer(payload: BrowserLayerPayload): Promise<void> {
  clearDefs();
  for (const slot of slots.values()) slot.container.style.display = 'none';
  const used = new Set<string>();
  const docs: Document[] = [document];
  let index = 0;
  for (const node of payload.nodes) {
    if (node.type !== 'html') throw new TypeError(`Node "${node.id}" has type "${node.type}"; the browser backend renders only "html" nodes.`);
    const html = typeof node.props['html'] === 'string' ? node.props['html'] : '';
    const css = typeof node.props['css'] === 'string' ? node.props['css'] : '';
    const signature = JSON.stringify([html, css, payload.seed, payload.fps]);
    const timeMs = (node.time.localFrame / payload.fps) * 1000;
    let slot = slots.get(node.id);
    const clockNow = slot?.iframe.contentWindow?.__ovClock?.now ?? 0;
    if (slot === undefined || slot.signature !== signature || timeMs < clockNow) {
      slot?.container.remove();
      slot = await createSlot(node, payload, signature, html, css);
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
    const win = slot.iframe.contentWindow;
    const doc = slot.iframe.contentDocument;
    const clock = win?.__ovClock;
    if (win === null || doc === null || clock === undefined) throw new Error(`HTML node "${node.id}" has no virtual clock.`);
    await loadFonts(doc);
    clock.frame({ timeMs, frame: node.time.localFrame, fps: payload.fps, progress: node.time.progress, seed: payload.seed, key: node.id });
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
