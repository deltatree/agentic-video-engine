/**
 * AST-Rückschreiben (FR-76): Patches aus dem Studio ändern die TSX-Quelle.
 *
 * Elemente werden über ihr `id`-Attribut (String-Literal) gefunden. Jede Änderung
 * ist ein Textersatz an AST-Positionen; der übrige Text bleibt Byte für Byte gleich.
 * Nicht literale Werte (Ausdrücke) werden nicht überschrieben: Diagnose `OV_ROUNDTRIP_DYNAMIC`.
 */
import ts from 'typescript';
import { COMPOUND_DEFAULTS, OpenVideoError, isRecord, type Diagnostic, type Patch, type PatchKeyframe } from '@agentic-video/core';
import { COMPONENT_FOR_NODE_TYPE, LIGHT_COMPONENTS } from '@agentic-video/sdk';

/** Optionen für {@link applyPatchesToSource}. */
export interface RoundtripOptions {
  /** Dateiname für Diagnosen (Standard `composition.tsx`). */
  readonly fileName?: string;
}

/** Ergebnis von {@link applyPatchesToSource}. */
export interface RoundtripResult {
  readonly source: string;
  /** Patches, die vollständig angewendet wurden. */
  readonly applied: readonly Patch[];
  readonly diagnostics: readonly Diagnostic[];
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

type Tag = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

interface ElementRef {
  readonly node: ts.JsxElement | ts.JsxSelfClosingElement;
  readonly tag: Tag;
}

/** Ein Patch kann an dieser Stelle nicht zurückgeschrieben werden; wird zur Diagnose. */
class Refusal extends OpenVideoError {
  readonly code: string;
  readonly problem: string;
  readonly suggestions: readonly string[];

  constructor(
    code: string,
    problem: string,
    suggestions: readonly string[],
    readonly node?: ts.Node,
  ) {
    super({ code, errorClass: 'RoundtripError', problem, suggestions });
    this.code = code;
    this.problem = problem;
    this.suggestions = suggestions;
  }
}

const SDK_MODULE = '@agentic-video/sdk';

// ---------------------------------------------------------------------------
// Literale
// ---------------------------------------------------------------------------

function unwrap(e: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e;
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/** Ist der Ausdruck ein reines Literal (Zahl, Text, Wahrheitswert, null, Objekt-/Array-Literal)? */
function isLiteral(expr: ts.Expression): boolean {
  const e = unwrap(expr);
  if (ts.isNumericLiteral(e) || ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
  if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isPrefixUnaryExpression(e)) return (e.operator === ts.SyntaxKind.MinusToken || e.operator === ts.SyntaxKind.PlusToken) && ts.isNumericLiteral(e.operand);
  if (ts.isArrayLiteralExpression(e)) return e.elements.every((x) => isLiteral(x));
  if (ts.isObjectLiteralExpression(e)) return e.properties.every((p) => ts.isPropertyAssignment(p) && propertyName(p.name) !== undefined && isLiteral(p.initializer));
  return false;
}

/** Wert eines Literal-Ausdrucks (nur für {@link isLiteral}-Ausdrücke). */
function literalValue(expr: ts.Expression): unknown {
  const e = unwrap(expr);
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (e.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand)) return e.operator === ts.SyntaxKind.MinusToken ? -Number(e.operand.text) : Number(e.operand.text);
  if (ts.isArrayLiteralExpression(e)) return e.elements.map((x) => literalValue(x));
  if (ts.isObjectLiteralExpression(e)) {
    const out: Record<string, unknown> = {};
    for (const p of e.properties) if (ts.isPropertyAssignment(p)) out[propertyName(p.name) ?? ''] = literalValue(p.initializer);
    return out;
  }
  return undefined;
}

/**
 * Schreibt einen JSON-Wert als TypeScript-Literal.
 *
 * @example
 * ```ts
 * toLiteral({ x: 1.2, y: 1 }); // "{ x: 1.2, y: 1 }"
 * ```
 */
export function toLiteral(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Refusal('OV_ROUNDTRIP_VALUE', `Cannot write ${String(value)} into source code.`, ['Use a finite number.']);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((v: unknown) => toLiteral(v)).join(', ')}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '{}';
    return `{ ${entries.map(([k, v]) => `${/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(k) ? k : JSON.stringify(k)}: ${toLiteral(v)}`).join(', ')} }`;
  }
  throw new Refusal('OV_ROUNDTRIP_VALUE', `Cannot write a ${typeof value} into source code.`, ['Use JSON data.']);
}

/** Text ohne Sonderzeichen darf als `name="…"` stehen; sonst `name={"…"}`. */
function jsxStringSafe(value: string): boolean {
  return !/["\\&{}<>\n\r]/u.test(value);
}

function attributeValue(value: unknown): string {
  return typeof value === 'string' && jsxStringSafe(value) ? `"${value}"` : `{${toLiteral(value)}}`;
}

// ---------------------------------------------------------------------------
// Suche im AST
// ---------------------------------------------------------------------------

function attributeText(attr: ts.JsxAttribute): string | undefined {
  const init = attr.initializer;
  if (init === undefined) return undefined;
  if (ts.isStringLiteral(init)) return init.text;
  if (ts.isJsxExpression(init) && init.expression !== undefined) {
    const e = unwrap(init.expression);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  }
  return undefined;
}

function findAttribute(tag: Tag, name: string): ts.JsxAttribute | undefined {
  return tag.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
}

function tagName(tag: Tag): string {
  return tag.tagName.getText();
}

function collectElements(sf: ts.SourceFile): ElementRef[] {
  const out: ElementRef[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isJsxElement(n)) out.push({ node: n, tag: n.openingElement });
    else if (ts.isJsxSelfClosingElement(n)) out.push({ node: n, tag: n });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function findById(sf: ts.SourceFile, id: string): ElementRef {
  const hits = collectElements(sf).filter((e) => {
    const attr = findAttribute(e.tag, 'id');
    return attr !== undefined && attributeText(attr) === id;
  });
  const [first, second] = hits;
  if (first === undefined) {
    throw new Refusal('OV_ROUNDTRIP_NOT_FOUND', `No JSX element with id="${id}" in the source.`, [`Add id="${id}" to the element in the TSX file.`, 'Elements without an id attribute get generated ids and cannot be edited in code by id.']);
  }
  if (second !== undefined) throw new Refusal('OV_ROUNDTRIP_AMBIGUOUS', `Several JSX elements use id="${id}".`, ['Give every element a unique id.'], second.tag);
  return first;
}

function findParent(sf: ts.SourceFile, parentId: string | null): ElementRef {
  if (parentId !== null) return findById(sf, parentId);
  const scene = collectElements(sf).find((e) => e.node.kind === ts.SyntaxKind.JsxElement && tagName(e.tag) === 'Scene');
  if (scene === undefined) throw new Refusal('OV_ROUNDTRIP_NOT_FOUND', 'No <Scene> element with children found for a top-level node.', ['Wrap the scene in <Scene>…</Scene>.']);
  return scene;
}

// ---------------------------------------------------------------------------
// Werte-Plätze (Attribut oder Feld eines Objekt-Literals)
// ---------------------------------------------------------------------------

interface Slot {
  /** Aktueller Ausdruck; `undefined`, wenn die Property fehlt. `true`-Kurzform: TrueKeyword-Text. */
  readonly expr: ts.Expression | undefined;
  readonly shorthand: boolean;
  /** Setzt den Wert (Text eines Ausdrucks). */
  readonly write: (exprText: string, value?: unknown) => Edit[];
  readonly remove: () => Edit[];
}

function nested(keys: readonly string[], exprText: string, defaults?: Readonly<Record<string, unknown>>): string {
  const [key, ...rest] = keys;
  if (key === undefined) return exprText;
  const others = Object.entries(defaults ?? {}).filter(([k]) => k !== key);
  const parts = [`${key}: ${nested(rest, exprText)}`, ...others.map(([k, v]) => `${k}: ${toLiteral(v)}`)];
  return `{ ${parts.join(', ')} }`;
}

function removeListItem<T extends ts.Node>(list: ts.NodeArray<T>, index: number, container: ts.Node, empty: string): Edit {
  const item = list[index];
  if (item === undefined) return { start: container.getStart(), end: container.end, text: empty };
  if (list.length === 1) return { start: container.getStart(), end: container.end, text: empty };
  const prev = list[index - 1];
  if (prev !== undefined) return { start: prev.end, end: item.end, text: '' };
  const next = list[index + 1];
  return { start: item.getStart(), end: next === undefined ? item.end : next.getStart(), text: '' };
}

function objectSlot(obj: ts.ObjectLiteralExpression, keys: readonly string[]): Slot {
  const [key, ...rest] = keys;
  if (key === undefined) throw new Refusal('OV_ROUNDTRIP_PATH', 'Empty property path.', []);
  const index = obj.properties.findIndex((p) => p.name !== undefined && propertyName(p.name) === key);
  const prop = obj.properties[index];
  if (prop === undefined) {
    const insert = (exprText: string): Edit[] => {
      const text = `${key}: ${nested(rest, exprText)}`;
      const last = obj.properties[obj.properties.length - 1];
      if (last === undefined) return [{ start: obj.getStart(), end: obj.end, text: `{ ${text} }` }];
      return [{ start: last.end, end: last.end, text: `, ${text}` }];
    };
    return { expr: undefined, shorthand: false, write: insert, remove: () => [] };
  }
  if (!ts.isPropertyAssignment(prop)) throw new Refusal('OV_ROUNDTRIP_DYNAMIC', `Property "${key}" is not a literal "key: value" entry.`, [`Write ${key}: <value> as a literal.`], prop);
  if (rest.length === 0) {
    return {
      expr: prop.initializer,
      shorthand: false,
      write: (exprText) => [{ start: prop.initializer.getStart(), end: prop.initializer.end, text: exprText }],
      remove: () => [removeListItem(obj.properties, index, obj, '{}')],
    };
  }
  const inner = unwrap(prop.initializer);
  if (!ts.isObjectLiteralExpression(inner)) throw new Refusal('OV_ROUNDTRIP_DYNAMIC', `"${key}" is not an object literal.`, [`Write ${key}: { … } as an object literal.`], prop.initializer);
  return objectSlot(inner, rest);
}

function attributeSlot(tag: Tag, keys: readonly string[]): Slot {
  const [first, ...rest] = keys;
  if (first === undefined) throw new Refusal('OV_ROUNDTRIP_PATH', 'Empty property path.', []);
  // Alias des SDK: `font` steht für `fontFamily`.
  const name = first === 'fontFamily' && findAttribute(tag, 'fontFamily') === undefined && findAttribute(tag, 'font') !== undefined ? 'font' : first;
  const attr = findAttribute(tag, name);
  if (attr === undefined) {
    // Stehen die Attribute je auf eigener Zeile, bekommt das neue Attribut auch eine eigene Zeile.
    const text = tag.getSourceFile().text;
    const last = tag.attributes.properties[tag.attributes.properties.length - 1];
    const gap = last !== undefined && onlyWhitespaceBefore(text, last.getStart()) ? `\n${indentAt(text, last.getStart())}` : ' ';
    return {
      expr: undefined,
      shorthand: false,
      write: (exprText, value) => [
        {
          start: tag.attributes.end,
          end: tag.attributes.end,
          text: `${gap}${name}=${rest.length === 0 && typeof value === 'string' && jsxStringSafe(value) ? `"${value}"` : `{${nested(rest, exprText, COMPOUND_DEFAULTS[name])}}`}`,
        },
      ],
      remove: () => [],
    };
  }
  const init = attr.initializer;
  const removeAttr = (): Edit[] => [{ start: attr.getFullStart(), end: attr.end, text: '' }];
  if (rest.length === 0) {
    if (init === undefined) {
      return { expr: undefined, shorthand: true, write: (exprText) => [{ start: attr.getStart(), end: attr.end, text: `${name}={${exprText}}` }], remove: removeAttr };
    }
    if (ts.isStringLiteral(init)) {
      return {
        expr: init,
        shorthand: false,
        write: (exprText, value) => [{ start: init.getStart(), end: init.end, text: typeof value === 'string' && jsxStringSafe(value) ? `"${value}"` : `{${exprText}}` }],
        remove: removeAttr,
      };
    }
    if (ts.isJsxExpression(init) && init.expression !== undefined) {
      const expr = init.expression;
      return { expr, shorthand: false, write: (exprText) => [{ start: expr.getStart(), end: expr.end, text: exprText }], remove: removeAttr };
    }
    throw new Refusal('OV_ROUNDTRIP_DYNAMIC', `Attribute ${name} has no value expression.`, [`${name}={…}`], attr);
  }
  const expr = init !== undefined && ts.isJsxExpression(init) && init.expression !== undefined ? unwrap(init.expression) : undefined;
  if (expr === undefined || !ts.isObjectLiteralExpression(expr)) {
    throw new Refusal('OV_ROUNDTRIP_DYNAMIC', `Attribute ${name} is not an object literal, so ${keys.join('.')} cannot be changed in place.`, [`Write ${name}={{ … }} as an object literal.`], attr);
  }
  return objectSlot(expr, rest);
}

function dynamic(slot: Slot, path: string): Refusal {
  const text = slot.expr?.getText() ?? '';
  return new Refusal('OV_ROUNDTRIP_DYNAMIC', `${path} is the expression \`${text}\`, not a literal; the patch was not applied here.`, [`Change the expression in code, or replace it with a literal such as ${path.split('.').pop() ?? path}={…}.`], slot.expr);
}

// ---------------------------------------------------------------------------
// Keyframes
// ---------------------------------------------------------------------------

interface TimeKey {
  readonly domain: 'frames' | 'seconds';
  readonly n: number;
}

function timeKey(t: unknown): TimeKey | undefined {
  if (typeof t === 'number') return { domain: 'frames', n: t };
  if (typeof t !== 'string') return undefined;
  const m = /^(-?[0-9]+(?:\.[0-9]+)?)(s|ms|f)$/u.exec(t);
  if (m === null) return undefined;
  const n = Number(m[1]);
  return m[2] === 'f' ? { domain: 'frames', n } : { domain: 'seconds', n: m[2] === 'ms' ? n / 1000 : n };
}

function sameTime(a: unknown, b: unknown): boolean {
  const ka = timeKey(a);
  const kb = timeKey(b);
  if (ka === undefined || kb === undefined) return JSON.stringify(a) === JSON.stringify(b);
  return (ka.n === 0 && kb.n === 0) || (ka.domain === kb.domain && ka.n === kb.n);
}

function keyframeText(k: PatchKeyframe): string {
  return toLiteral({ t: k.t, v: k.v, ...(k.ease !== undefined ? { ease: k.ease } : {}) });
}

function keyframesCall(expr: ts.Expression | undefined): { call: ts.CallExpression; array: ts.ArrayLiteralExpression } | undefined {
  if (expr === undefined) return undefined;
  const e = unwrap(expr);
  if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression) || e.expression.text !== 'keyframes') return undefined;
  const arg = e.arguments[0];
  if (arg === undefined || !ts.isArrayLiteralExpression(arg)) return undefined;
  return { call: e, array: arg };
}

function keyframeTimes(array: ts.ArrayLiteralExpression): unknown[] {
  return array.elements.map((el) => {
    if (!ts.isObjectLiteralExpression(el)) throw new Refusal('OV_ROUNDTRIP_DYNAMIC', 'A keyframe is not an object literal.', ['Write keyframes as { t: …, v: … } literals.'], el);
    const t = el.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && propertyName(p.name) === 't');
    if (t === undefined || !isLiteral(t.initializer)) throw new Refusal('OV_ROUNDTRIP_DYNAMIC', 'A keyframe time is not a literal.', ['Write t: 30 or t: "1s".'], el);
    return literalValue(t.initializer);
  });
}

// ---------------------------------------------------------------------------
// Imports und Einfügen von Elementen
// ---------------------------------------------------------------------------

function ensureImport(sf: ts.SourceFile, name: string): Edit[] {
  const imports = sf.statements.filter(ts.isImportDeclaration);
  for (const imp of imports) {
    if (!ts.isStringLiteral(imp.moduleSpecifier) || imp.moduleSpecifier.text !== SDK_MODULE) continue;
    const bindings = imp.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    if (bindings.elements.some((e) => e.name.text === name)) return [];
    const last = bindings.elements[bindings.elements.length - 1];
    if (last === undefined) return [{ start: bindings.getStart(), end: bindings.end, text: `{ ${name} }` }];
    return [{ start: last.end, end: last.end, text: `, ${name}` }];
  }
  const after = imports[imports.length - 1];
  const line = `import { ${name} } from '${SDK_MODULE}';\n`;
  return after === undefined ? [{ start: 0, end: 0, text: line }] : [{ start: after.end, end: after.end, text: `\n${line.trimEnd()}` }];
}

function lineStart(text: string, pos: number): number {
  return text.lastIndexOf('\n', pos - 1) + 1;
}

function indentAt(text: string, pos: number): string {
  const start = lineStart(text, pos);
  return /^[ \t]*/u.exec(text.slice(start))?.[0] ?? '';
}

function onlyWhitespaceBefore(text: string, pos: number): boolean {
  return /^[ \t]*$/u.test(text.slice(lineStart(text, pos), pos));
}

/** Fügt `elementText` als letztes Kind von `parent` ein. */
function appendChild(sf: ts.SourceFile, parent: ElementRef, elementText: string): Edit[] {
  const text = sf.text;
  const parentIndent = indentAt(text, parent.node.getStart());
  if (ts.isJsxSelfClosingElement(parent.node)) {
    const tag = parent.node;
    const inner = `${parentIndent}  `;
    return [{ start: tag.attributes.end, end: tag.end, text: `>\n${inner}${reindent(elementText, inner)}\n${parentIndent}</${tagName(tag)}>` }];
  }
  const el = parent.node;
  const lastChild = [...el.children].reverse().find((c) => !ts.isJsxText(c) || c.text.trim() !== '');
  const childIndent = lastChild !== undefined ? indentAt(text, lastChild.getStart()) : `${parentIndent}  `;
  const closing = el.closingElement.getStart();
  if (onlyWhitespaceBefore(text, closing)) {
    const at = lineStart(text, closing);
    return [{ start: at, end: at, text: `${childIndent}${reindent(elementText, childIndent)}\n` }];
  }
  return [{ start: closing, end: closing, text: reindent(elementText, childIndent) }];
}

function reindent(elementText: string, indent: string): string {
  return elementText.split('\n').map((l, i) => (i === 0 || l === '' ? l : `${indent}${l}`)).join('\n');
}

/**
 * Schreibt eine IR-Node als JSX-Element (für `addNode`).
 *
 * @example
 * ```ts
 * nodeToJsx({ id: 'badge', type: 'rect', width: 10, height: 10 }); // '<Rect id="badge" width={10} height={10} />'
 * ```
 */
export function nodeToJsx(node: Readonly<Record<string, unknown>>): { readonly text: string; readonly components: readonly string[] } {
  const type = node['type'];
  if (typeof type !== 'string') throw new Refusal('OV_ROUNDTRIP_VALUE', 'The new node has no type.', ['node: { id: "x", type: "rect", … }']);
  const component = type === 'light3d' ? LIGHT_COMPONENTS[String(node['kind'])] : COMPONENT_FOR_NODE_TYPE[type];
  if (component === undefined) throw new Refusal('OV_ROUNDTRIP_UNSUPPORTED', `No SDK element for node type "${type}".`, ['Add the node in code.']);
  const components = [component];
  const attrs: string[] = [];
  const id = node['id'];
  if (typeof id === 'string') attrs.push(`id=${attributeValue(id)}`);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'id' || k === 'type' || k === 'children' || v === undefined || (type === 'light3d' && k === 'kind')) continue;
    const mask = k === 'mask' && isRecord(v) && isRecord(v['node']) ? v : undefined;
    if (mask !== undefined) {
      const maskNode = isRecord(mask['node']) ? nodeToJsx(mask['node']) : undefined;
      const rest = Object.entries(mask).filter(([mk]) => mk !== 'node').map(([mk, mv]) => `, ${mk}: ${toLiteral(mv)}`).join('');
      if (maskNode !== undefined) {
        components.push(...maskNode.components);
        attrs.push(`mask={{ node: ${maskNode.text}${rest} }}`);
      }
      continue;
    }
    attrs.push(`${k}=${attributeValue(v)}`);
  }
  const open = `<${component}${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}`;
  const children = Array.isArray(node['children']) ? node['children'].filter(isRecord) : [];
  if (children.length === 0) return { text: `${open} />`, components };
  const inner = children.map((c) => {
    const r = nodeToJsx(c);
    components.push(...r.components);
    return `  ${r.text.split('\n').join('\n  ')}`;
  });
  return { text: `${open}>\n${inner.join('\n')}\n</${component}>`, components };
}

/** Bereich eines Elements; ganze Zeilen, wenn es allein auf seinen Zeilen steht. */
function elementRange(text: string, el: ElementRef): { start: number; end: number } {
  const start = el.node.getStart();
  const end = el.node.end;
  const nl = text.indexOf('\n', end);
  const lineEnd = nl === -1 ? text.length : nl;
  if (onlyWhitespaceBefore(text, start) && /^[ \t]*$/u.test(text.slice(end, lineEnd))) {
    return { start: lineStart(text, start), end: nl === -1 ? lineEnd : nl + 1 };
  }
  return { start, end };
}

function directChild(el: ElementRef, nodeId: string): void {
  const parent = el.node.parent;
  if (!ts.isJsxElement(parent)) {
    throw new Refusal('OV_ROUNDTRIP_DYNAMIC', `Element "${nodeId}" is not a direct child of a JSX element (for example inside a condition or map).`, ['Move or remove the element in code.'], el.node);
  }
}

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

function applyOne(sf: ts.SourceFile, patch: Patch): Edit[] {
  switch (patch.op) {
    case 'setProperty': {
      const el = findById(sf, patch.nodeId);
      const keys = patch.property.split('.').filter((k) => k.length > 0);
      if (keys[0] === 'id' || keys[0] === 'type' || keys[0] === 'children') throw new Refusal('OV_ROUNDTRIP_PATH', `Property "${patch.property}" cannot be set.`, ['Use addNode, removeNode or moveNode.']);
      const slot = attributeSlot(el.tag, keys);
      if (patch.value === undefined || (patch.value === null && patch.keepNull !== true)) return slot.remove();
      if (slot.expr !== undefined && !isLiteral(slot.expr)) throw dynamic(slot, patch.property);
      return slot.write(toLiteral(patch.value), patch.value);
    }
    case 'addNode': {
      const parent = findParent(sf, patch.parentId);
      const { text, components } = nodeToJsx(patch.node);
      const imports = [...new Set(components)].flatMap((c) => ensureImport(sf, c));
      return [...appendChild(sf, parent, text), ...dedupe(imports)];
    }
    case 'removeNode': {
      const el = findById(sf, patch.nodeId);
      directChild(el, patch.nodeId);
      const r = elementRange(sf.text, el);
      return [{ start: r.start, end: r.end, text: '' }];
    }
    case 'moveNode': {
      const el = findById(sf, patch.nodeId);
      directChild(el, patch.nodeId);
      const parent = findParent(sf, patch.parentId);
      if (parent.node.getStart() >= el.node.getStart() && parent.node.end <= el.node.end) {
        throw new Refusal('OV_ROUNDTRIP_PATH', `Cannot move "${patch.nodeId}" into itself.`, ['Choose a parent outside the moved element.']);
      }
      const r = elementRange(sf.text, el);
      return [{ start: r.start, end: r.end, text: '' }, ...appendChild(sf, parent, el.node.getText())];
    }
    case 'addKeyframe': {
      const el = findById(sf, patch.nodeId);
      const slot = attributeSlot(el.tag, patch.property.split('.'));
      const key = keyframeText(patch.keyframe);
      const imports = ensureImport(sf, 'keyframes');
      const kf = keyframesCall(slot.expr);
      if (kf !== undefined) {
        const times = keyframeTimes(kf.array);
        const same = times.findIndex((t) => sameTime(t, patch.keyframe.t));
        const existing = kf.array.elements[same];
        if (existing !== undefined) return [{ start: existing.getStart(), end: existing.end, text: key }];
        const keys = [...times, patch.keyframe.t].map(timeKey);
        const comparable = keys.every((k) => k !== undefined && k.domain === keys[0]?.domain);
        const target = timeKey(patch.keyframe.t);
        const before = comparable && target !== undefined ? times.findIndex((t) => (timeKey(t)?.n ?? 0) > target.n) : -1;
        const at = kf.array.elements[before];
        if (at !== undefined) return [{ start: at.getStart(), end: at.getStart(), text: `${key}, ` }];
        const last = kf.array.elements[kf.array.elements.length - 1];
        return last === undefined ? [{ start: kf.array.getStart(), end: kf.array.end, text: `[${key}]` }] : [{ start: last.end, end: last.end, text: `, ${key}` }];
      }
      if (slot.expr !== undefined && !isLiteral(slot.expr)) throw dynamic(slot, patch.property);
      const zero = timeKey(patch.keyframe.t)?.n === 0;
      const current = slot.shorthand ? 'true' : slot.expr?.getText();
      const list = current === undefined || zero ? `[${key}]` : `[{ t: 0, v: ${current} }, ${key}]`;
      return [...slot.write(`keyframes(${list})`), ...imports];
    }
    case 'removeKeyframe': {
      const el = findById(sf, patch.nodeId);
      const slot = attributeSlot(el.tag, patch.property.split('.'));
      const kf = keyframesCall(slot.expr);
      if (kf === undefined) {
        if (slot.expr !== undefined && !isLiteral(slot.expr)) throw dynamic(slot, patch.property);
        throw new Refusal('OV_ROUNDTRIP_NO_KEYFRAME', `Property "${patch.property}" has no keyframes([…]) in the source.`, ['Use addKeyframe first.']);
      }
      const times = keyframeTimes(kf.array);
      const index = times.findIndex((t) => sameTime(t, patch.t));
      if (index < 0) throw new Refusal('OV_ROUNDTRIP_NO_KEYFRAME', `No keyframe at ${JSON.stringify(patch.t)} on "${patch.property}".`, ['Check the keyframe times in the source.']);
      const remaining = kf.array.elements.filter((_, i) => i !== index);
      if (remaining.length === 0) return slot.remove();
      const only = remaining[0];
      if (remaining.length === 1 && kf.call.arguments.length === 1 && only !== undefined && ts.isObjectLiteralExpression(only)) {
        const v = only.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && propertyName(p.name) === 'v');
        if (v !== undefined) return slot.write(v.initializer.getText(), isLiteral(v.initializer) ? literalValue(v.initializer) : undefined);
      }
      return [removeListItem(kf.array.elements, index, kf.array, '[]')];
    }
    default:
      throw new Refusal('OV_ROUNDTRIP_UNSUPPORTED', `Patch ${patch.op} cannot be written back into TSX.`, ['Edit the composition() definition in code.', 'Use a JSON composition for this change.']);
  }
}

function dedupe(edits: readonly Edit[]): Edit[] {
  const seen = new Set<string>();
  return edits.filter((e) => {
    const k = `${String(e.start)}:${String(e.end)}:${e.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Wendet Textersetzungen von hinten nach vorn an. Überlappungen sind ein Programmierfehler. */
function applyEdits(text: string, edits: readonly Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  let limit = Number.POSITIVE_INFINITY;
  for (const e of sorted) {
    if (e.end > limit) throw new Refusal('OV_ROUNDTRIP_CONFLICT', 'Two edits of one patch overlap.', ['Split the patch into two patches.']);
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    limit = e.start;
  }
  return out;
}

function nodeIdOf(patch: Patch): string | undefined {
  return 'nodeId' in patch ? patch.nodeId : undefined;
}

/**
 * Schreibt Patches per TypeScript-AST in eine TSX-Quelle zurück.
 *
 * @example
 * ```ts
 * const r = applyPatchesToSource(source, [{ op: 'setProperty', nodeId: 'headline', property: 'fontSize', value: 82 }], { fileName: 'video.tsx' });
 * // r.source: nur `fontSize={92}` → `fontSize={82}` geändert
 * ```
 */
export function applyPatchesToSource(source: string, patches: readonly Patch[], options: RoundtripOptions = {}): RoundtripResult {
  const fileName = options.fileName ?? 'composition.tsx';
  let text = source;
  const applied: Patch[] = [];
  const diagnostics: Diagnostic[] = [];
  patches.forEach((patch, index) => {
    const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    try {
      text = applyEdits(text, applyOne(sf, patch));
      applied.push(patch);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      const nodeId = nodeIdOf(patch);
      const where = error.node === undefined ? undefined : sf.getLineAndCharacterOfPosition(error.node.getStart());
      diagnostics.push({
        code: error.code,
        severity: 'error',
        errorClass: 'RoundtripError',
        problem: `Patch ${String(index + 1)} (${patch.op}): ${error.problem}`,
        ...(nodeId !== undefined ? { nodeId } : {}),
        details: {
          file: fileName,
          patchIndex: index,
          ...(where !== undefined ? { line: where.line + 1, column: where.character + 1 } : {}),
          ...(error.code === 'OV_ROUNDTRIP_DYNAMIC' && error.node !== undefined ? { expression: error.node.getText().slice(0, 200) } : {}),
        },
        suggestions: error.suggestions,
      });
    }
  });
  return { source: text, applied, diagnostics };
}

