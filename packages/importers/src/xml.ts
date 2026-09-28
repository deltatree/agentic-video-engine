/**
 * Kleiner, strenger XML-Parser für SVG: Elemente, Attribute, Text, CDATA.
 * Kommentare, Processing Instructions und DOCTYPE werden übersprungen.
 */
import { importError } from './common.js';

/** Ein XML-Element. */
export interface XmlElement {
  readonly kind: 'element';
  /** Lokaler Name ohne Namensraum-Präfix, z. B. `rect`. */
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XmlChild[];
}

/** Ein Textknoten. */
export interface XmlText {
  readonly kind: 'text';
  readonly text: string;
}

export type XmlChild = XmlElement | XmlText;

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Löst XML-Entities auf (`&amp;`, `&#38;`, `&#x26;`). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/gu, (all, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(parseInt(name.slice(1), 10));
    return ENTITIES[name] ?? all;
  });
}

function localName(qname: string): string {
  const i = qname.indexOf(':');
  return i < 0 ? qname : qname.slice(i + 1);
}

interface MutableElement {
  kind: 'element';
  name: string;
  attrs: Record<string, string>;
  children: XmlChild[];
}

/**
 * Parst XML-Text in einen Elementbaum und liefert das Wurzelelement.
 * Attributnamen behalten ihr Präfix (`xlink:href`); Elementnamen verlieren es.
 *
 * @example
 * ```ts
 * parseXml('<svg><rect width="10"/></svg>').children[0]; // { kind: 'element', name: 'rect', ... }
 * ```
 */
export function parseXml(source: string): XmlElement {
  const root: MutableElement = { kind: 'element', name: '#document', attrs: {}, children: [] };
  const stack: MutableElement[] = [root];
  let i = 0;
  const top = (): MutableElement => stack[stack.length - 1] ?? root;
  const bad = (problem: string) => importError('OV_IMPORT_PARSE', `${problem} (offset ${String(i)}).`, 'Pass well-formed XML markup.');
  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt < 0) {
      const text = source.slice(i);
      if (text.length > 0) top().children.push({ kind: 'text', text: decodeEntities(text) });
      break;
    }
    if (lt > i) top().children.push({ kind: 'text', text: decodeEntities(source.slice(i, lt)) });
    i = lt;
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      if (end < 0) throw bad('Unterminated comment');
      i = end + 3;
    } else if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i + 9);
      if (end < 0) throw bad('Unterminated CDATA section');
      top().children.push({ kind: 'text', text: source.slice(i + 9, end) });
      i = end + 3;
    } else if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i + 2);
      if (end < 0) throw bad('Unterminated processing instruction');
      i = end + 2;
    } else if (source.startsWith('<!', i)) {
      // DOCTYPE, optional mit internem Subset in eckigen Klammern
      let depth = 0;
      let j = i + 2;
      for (; j < source.length; j++) {
        const c = source[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      i = j + 1;
    } else if (source.startsWith('</', i)) {
      const end = source.indexOf('>', i);
      if (end < 0) throw bad('Unterminated closing tag');
      const name = localName(source.slice(i + 2, end).trim());
      const open = stack.pop();
      if (open === undefined || open === root || open.name !== name) throw bad(`Unexpected closing tag </${name}>`);
      i = end + 1;
    } else {
      const m = /^<([A-Za-z_][\w.:-]*)/u.exec(source.slice(i, i + 256));
      const qname = m?.[1];
      if (qname === undefined) throw bad('Invalid tag');
      i += qname.length + 1;
      const attrs: Record<string, string> = {};
      const attrRe = /\s*([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')|\s*(\/?>)/uy;
      let selfClosing: boolean;
      for (;;) {
        attrRe.lastIndex = i;
        const a = attrRe.exec(source);
        if (a === null) throw bad(`Invalid attribute in <${qname}>`);
        i = attrRe.lastIndex;
        if (a[5] !== undefined) {
          selfClosing = a[5] === '/>';
          break;
        }
        const key = a[1] ?? '';
        attrs[key] = decodeEntities(a[3] ?? a[4] ?? '');
      }
      const el: MutableElement = { kind: 'element', name: localName(qname), attrs, children: [] };
      top().children.push(el);
      if (!selfClosing) stack.push(el);
    }
  }
  if (stack.length > 1) throw bad(`Unclosed element <${top().name}>`);
  const first = root.children.find((c): c is XmlElement => c.kind === 'element');
  if (first === undefined) throw bad('The document has no root element');
  return first;
}

/** Kind-Elemente eines Elements. */
export function childElements(el: XmlElement): XmlElement[] {
  return el.children.filter((c): c is XmlElement => c.kind === 'element');
}

/** Gesamter Textinhalt eines Elements (rekursiv). */
export function textContent(el: XmlElement): string {
  return el.children.map((c) => (c.kind === 'text' ? c.text : textContent(c))).join('');
}
