/**
 * HTML/CSS-Import (FR-85): eine `html`-Node (verlustfrei). Eingebettete Daten (data-URIs)
 * werden Assets unter `/assets/<id>`. Externe URLs werden beim Rendern blockiert und
 * erzeugen eine Diagnose.
 */
import type { Diagnostic } from '@agentic-video/core';
import { IdAllocator, isExternalUrl, lossy, makeAsset, mimeInfo, parseDataUri, type ImportedAsset, type NodeImportResult } from './common.js';

/** Optionen für {@link importHtml}. */
export interface HtmlImportOptions {
  /** ID der Node (Standard `html`); Assets erhalten sie als Präfix. */
  readonly id?: string;
  /** Größe der Box in Pixeln (Standard 1920 × 1080). */
  readonly width?: number;
  readonly height?: number;
}

/** Tags, deren `href` eine Ressource lädt (bei `<a>` ist es nur ein Link). */
const HREF_LOADS = new Set(['link', 'image', 'use', 'feimage']);
const LOADING_ATTRS = new Set(['src', 'poster', 'data', 'background']);

interface Ctx {
  readonly ids: IdAllocator;
  readonly assets: ImportedAsset[];
  readonly diagnostics: Diagnostic[];
}

function embed(uri: string, ctx: Ctx): string {
  const data = parseDataUri(uri);
  if (data === undefined) return uri;
  const info = mimeInfo(data.mime) ?? { type: 'data' as const, ext: 'bin' };
  const id = ctx.ids.next(info.type);
  ctx.assets.push(makeAsset(id, info.type, info.ext, data.bytes, { mime: data.mime }));
  return `/assets/${id}`;
}

function external(url: string, where: string, ctx: Ctx): void {
  ctx.diagnostics.push(
    lossy(where, `External resource "${url}" is blocked during rendering and will be missing.`, `Download the file, import it as an asset (openvideo assets import ${url}) and reference it as /assets/<id>.`),
  );
}

/** Ersetzt `url(...)` und meldet `@import` in CSS-Text. */
function rewriteCss(css: string, where: string, ctx: Ctx): string {
  for (const m of css.matchAll(/@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)/giu)) {
    const url = m[1] ?? '';
    if (isExternalUrl(url)) external(url, where, ctx);
  }
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/giu, (all, quote: string, url: string, offset: number) => {
    const trimmed = url.trim();
    if (trimmed.startsWith('data:')) return `url(${quote}${embed(trimmed, ctx)}${quote})`;
    // @import wurde oben schon gemeldet.
    const isImport = /@import\s*$/iu.test(css.slice(0, offset));
    if (isExternalUrl(trimmed) && !isImport) external(trimmed, where, ctx);
    return all;
  });
}

/** Ersetzt data-URIs in Attributen und `<style>`-Blöcken; meldet externe Ressourcen. */
function rewriteHtml(html: string, ctx: Ctx): string {
  const withStyles = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/giu, (_all, open: string, body: string, close: string) => `${open}${rewriteCss(body, 'html > style', ctx)}${close}`);
  return withStyles.replace(/<([A-Za-z][\w:-]*)(\s[^<>]*?)?(\/?)>/gu, (all, tag: string, attrs: string | undefined, slash: string) => {
    if (attrs === undefined) return all;
    const name = tag.toLowerCase();
    const where = `html > ${name}`;
    const rewritten = attrs.replace(/([\w:-]+)(\s*=\s*)(?:"([^"]*)"|'([^']*)')/gu, (whole, key: string, eq: string, dq: string | undefined, sq: string | undefined) => {
      const attr = key.toLowerCase();
      const value = dq ?? sq ?? '';
      const quote = dq !== undefined ? '"' : "'";
      if (attr === 'style') return `${key}${eq}${quote}${rewriteCss(value, `${where}[style]`, ctx)}${quote}`;
      if (attr === 'srcset') {
        const parts = value.split(',').map((part) => {
          const [url = '', ...rest] = part.trim().split(/\s+/u);
          if (url.startsWith('data:')) return [embed(url, ctx), ...rest].join(' ');
          if (isExternalUrl(url)) external(url, `${where}[srcset]`, ctx);
          return part.trim();
        });
        return `${key}${eq}${quote}${parts.join(', ')}${quote}`;
      }
      const loads = LOADING_ATTRS.has(attr) || ((attr === 'href' || attr === 'xlink:href') && HREF_LOADS.has(name));
      if (!loads) return whole;
      if (value.trim().startsWith('data:')) return `${key}${eq}${quote}${embed(value.trim(), ctx)}${quote}`;
      if (isExternalUrl(value)) external(value.trim(), `${where}[${attr}]`, ctx);
      return whole;
    });
    return `<${tag}${rewritten}${slash}>`;
  });
}

/** Zerlegt ein vollständiges Dokument in Body-Inhalt und Kopf-Stile. */
function splitDocument(html: string, ctx: Ctx): { body: string; headCss: string[] } {
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/iu.exec(html)?.[1];
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/iu.exec(html)?.[1];
  if (body === undefined && head === undefined) return { body: html, headCss: [] };
  const headCss: string[] = [];
  const headScripts: string[] = [];
  if (head !== undefined) {
    for (const m of head.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)) headCss.push(m[1] ?? '');
    for (const m of head.matchAll(/<script\b[\s\S]*?<\/script>/giu)) headScripts.push(m[0]);
    for (const m of head.matchAll(/<link\b[^>]*>/giu)) {
      const href = /href\s*=\s*["']([^"']+)["']/iu.exec(m[0])?.[1] ?? '';
      if (/rel\s*=\s*["']?stylesheet/iu.test(m[0])) {
        if (isExternalUrl(href)) external(href, 'html > head > link', ctx);
        else ctx.diagnostics.push(lossy('html > head > link', `Linked stylesheet "${href}" is not inlined and will be missing.`, 'Pass the stylesheet content as the css argument.'));
      }
    }
  }
  return { body: [...headScripts, body ?? ''].join('\n'), headCss };
}

/**
 * Importiert HTML (und optional CSS) als `html`-Node. data-URIs werden Assets,
 * die Seite erreicht sie unter `/assets/<id>`. Externe URLs erzeugen `OV_IMPORT_LOSSY`.
 *
 * @example
 * ```ts
 * const { nodes, assets } = importHtml('<h1>Hi</h1><img src="data:image/png;base64,...">', 'h1 { color: red }', { id: 'card' });
 * // nodes[0] = { id: 'card', type: 'html', width: 1920, height: 1080, html: '<h1>Hi</h1><img src="/assets/card-image-1">', css: 'h1 { color: red }', assets: ['card-image-1'] }
 * ```
 */
export function importHtml(html: string, css?: string, options: HtmlImportOptions = {}): NodeImportResult {
  const id = options.id ?? 'html';
  const ctx: Ctx = { ids: new IdAllocator(id), assets: [], diagnostics: [] };
  const { body, headCss } = splitDocument(html, ctx);
  const outHtml = rewriteHtml(body, ctx);
  const cssParts = [...headCss, ...(css !== undefined ? [css] : [])].map((c) => rewriteCss(c, 'css', ctx));
  const node: Record<string, unknown> = { id, type: 'html', width: options.width ?? 1920, height: options.height ?? 1080, html: outHtml };
  if (cssParts.length > 0) node['css'] = cssParts.join('\n');
  if (ctx.assets.length > 0) node['assets'] = ctx.assets.map((a) => a.asset.id);
  return { nodes: [node], assets: ctx.assets, diagnostics: ctx.diagnostics };
}
