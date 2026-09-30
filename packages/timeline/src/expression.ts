/**
 * Sichere Expression-Sprache (FR-12).
 *
 * Ausdrücke wie `sin(time * 2) * 40` werden geparst und interpretiert, nie als
 * JavaScript ausgeführt. Es gibt keinen Member-Zugriff, keine Zuweisung und nur
 * eine feste Liste von Funktionen. Damit ist die Sprache in JSON ohne Sandbox erlaubt.
 */
import { OpenVideoError } from '@agentic-video/schema';
import { easing } from './easing.js';
import { noise1, noise2, random, randomRange, wiggle } from './random.js';

/** Wert eines Ausdrucks: Zahl, Vektor oder Text (nur als Funktionsargument). */
export type ExprValue = number | readonly number[] | string;

/** Ein benanntes Event für Expressions: lokale Zeit in Sekunden und die Daten des Markers. */
export interface ExprEvent {
  readonly time: number;
  readonly data: Readonly<Record<string, string | number | boolean>>;
}

/** Variablen, die ein Ausdruck lesen darf. */
export interface ExprScope {
  readonly frame: number;
  readonly time: number;
  readonly fps: number;
  readonly seed: number;
  /** Dauer der Node in Sekunden. */
  readonly duration: number;
  /** Fortschritt der Node 0..1. */
  readonly progress: number;
  /** Marker-Zeiten in Sekunden. */
  readonly markers?: ReadonlyMap<string, number>;
  /** Benannte Events (Marker mit `kind: 'event'`): Zeit in Sekunden und Daten. */
  readonly events?: ReadonlyMap<string, ExprEvent>;
  /** Weitere, vom Aufrufer deklarierte Werte (z. B. `index`). */
  readonly vars?: Readonly<Record<string, number | readonly number[]>>;
}

type Node =
  | { readonly k: 'num'; readonly v: number }
  | { readonly k: 'str'; readonly v: string }
  | { readonly k: 'var'; readonly name: string }
  | { readonly k: 'arr'; readonly items: readonly Node[] }
  | { readonly k: 'un'; readonly op: string; readonly arg: Node }
  | { readonly k: 'bin'; readonly op: string; readonly left: Node; readonly right: Node }
  | { readonly k: 'cond'; readonly test: Node; readonly then: Node; readonly other: Node }
  | { readonly k: 'call'; readonly name: string; readonly args: readonly Node[] }
  | { readonly k: 'idx'; readonly target: Node; readonly index: Node };

interface Token {
  readonly t: 'num' | 'str' | 'id' | 'op' | 'eof';
  readonly v: string;
  readonly pos: number;
}

const OPERATORS = ['**', '==', '!=', '<=', '>=', '&&', '||', '+', '-', '*', '/', '%', '<', '>', '!', '?', ':', '(', ')', '[', ']', ','];

function exprError(source: string, problem: string, pos?: number): OpenVideoError {
  return new OpenVideoError({
    code: 'OV_EXPR_INVALID',
    errorClass: 'ExpressionError',
    problem,
    received: JSON.stringify(source),
    ...(pos !== undefined ? { details: { position: pos } } : {}),
    suggestions: [
      'Use numbers, + - * / % **, comparisons, ?:, and functions like sin, cos, clamp, lerp, random, noise, wiggle, ease, marker, event.',
      'Available variables: frame, time, fps, seed, duration, progress, pi, e.',
    ],
  });
}

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? '';
    if (/\s/u.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/u.test(ch)) {
      const m = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/u.exec(src.slice(i));
      if (m === null) throw exprError(src, `Invalid number at position ${String(i)}.`, i);
      out.push({ t: 'num', v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/u.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(src.slice(i));
      const word = m?.[0] ?? ch;
      out.push({ t: 'id', v: word, pos: i });
      i += word.length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
      if (end < 0) throw exprError(src, 'Unterminated string.', i);
      out.push({ t: 'str', v: src.slice(i + 1, end), pos: i });
      i = end + 1;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op === undefined) throw exprError(src, `Unexpected character "${ch}" at position ${String(i)}.`, i);
    out.push({ t: 'op', v: op, pos: i });
    i += op.length;
  }
  out.push({ t: 'eof', v: '', pos: src.length });
  return out;
}

const BINARY: Readonly<Record<string, [number, 'left' | 'right']>> = {
  '||': [1, 'left'],
  '&&': [2, 'left'],
  '==': [3, 'left'],
  '!=': [3, 'left'],
  '<': [4, 'left'],
  '>': [4, 'left'],
  '<=': [4, 'left'],
  '>=': [4, 'left'],
  '+': [5, 'left'],
  '-': [5, 'left'],
  '*': [6, 'left'],
  '/': [6, 'left'],
  '%': [6, 'left'],
  '**': [8, 'right'],
};

class Parser {
  private i = 0;
  constructor(
    private readonly tokens: readonly Token[],
    private readonly src: string,
  ) {}

  private peek(): Token {
    return this.tokens[this.i] ?? { t: 'eof', v: '', pos: this.src.length };
  }

  private next(): Token {
    const t = this.peek();
    this.i++;
    return t;
  }

  private expect(v: string): void {
    const t = this.next();
    if (t.v !== v) throw exprError(this.src, `Expected "${v}" at position ${String(t.pos)}.`, t.pos);
  }

  parse(): Node {
    const node = this.ternary();
    const t = this.peek();
    if (t.t !== 'eof') throw exprError(this.src, `Unexpected "${t.v}" at position ${String(t.pos)}.`, t.pos);
    return node;
  }

  private ternary(): Node {
    const test = this.binary(0);
    if (this.peek().v === '?') {
      this.next();
      const then = this.ternary();
      this.expect(':');
      const other = this.ternary();
      return { k: 'cond', test, then, other };
    }
    return test;
  }

  private binary(minPrec: number): Node {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      const info = t.t === 'op' ? BINARY[t.v] : undefined;
      if (info === undefined || info[0] < minPrec) return left;
      this.next();
      const right = this.binary(info[1] === 'left' ? info[0] + 1 : info[0]);
      left = { k: 'bin', op: t.v, left, right };
    }
  }

  private unary(): Node {
    const t = this.peek();
    if (t.t === 'op' && (t.v === '-' || t.v === '+' || t.v === '!')) {
      this.next();
      // Unäres Minus bindet schwächer als **: -2**2 = -4
      return { k: 'un', op: t.v, arg: this.binaryFromPower() };
    }
    return this.postfix(this.primary());
  }

  private binaryFromPower(): Node {
    const base = this.unary();
    if (this.peek().v === '**') {
      this.next();
      return { k: 'bin', op: '**', left: base, right: this.unary() };
    }
    return base;
  }

  private postfix(node: Node): Node {
    let current = node;
    while (this.peek().v === '[') {
      this.next();
      const index = this.ternary();
      this.expect(']');
      current = { k: 'idx', target: current, index };
    }
    return current;
  }

  private primary(): Node {
    const t = this.next();
    if (t.t === 'num') return { k: 'num', v: Number(t.v) };
    if (t.t === 'str') return { k: 'str', v: t.v };
    if (t.t === 'id') {
      if (this.peek().v === '(') {
        this.next();
        const args: Node[] = [];
        if (this.peek().v !== ')') {
          for (;;) {
            args.push(this.ternary());
            if (this.peek().v === ',') {
              this.next();
              continue;
            }
            break;
          }
        }
        this.expect(')');
        return { k: 'call', name: t.v, args };
      }
      return { k: 'var', name: t.v };
    }
    if (t.v === '(') {
      const inner = this.ternary();
      this.expect(')');
      return inner;
    }
    if (t.v === '[') {
      const items: Node[] = [];
      if (this.peek().v !== ']') {
        for (;;) {
          items.push(this.ternary());
          if (this.peek().v === ',') {
            this.next();
            continue;
          }
          break;
        }
      }
      this.expect(']');
      return { k: 'arr', items };
    }
    throw exprError(this.src, t.t === 'eof' ? 'Unexpected end of expression.' : `Unexpected "${t.v}" at position ${String(t.pos)}.`, t.pos);
  }
}

/** Liest nur eigene Eigenschaften, nie aus der Prototyp-Kette (Schutz vor `constructor` & Co.). */
function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

type Fn = (args: readonly ExprValue[], scope: ExprScope, src: string) => ExprValue;

function numArg(args: readonly ExprValue[], i: number, src: string, name: string): number {
  const v = args[i];
  if (typeof v !== 'number') throw exprError(src, `Argument ${String(i + 1)} of ${name}() must be a number.`);
  return v;
}

function strArg(args: readonly ExprValue[], i: number, src: string, name: string): string {
  const v = args[i];
  if (typeof v !== 'string') throw exprError(src, `Argument ${String(i + 1)} of ${name}() must be a string.`);
  return v;
}

const unaryMath = (f: (x: number) => number, name: string): Fn => (args, _s, src) => mapNum(args[0], f, src, name);

function mapNum(v: ExprValue | undefined, f: (x: number) => number, src: string, name: string): ExprValue {
  if (typeof v === 'number') return f(v);
  if (Array.isArray(v)) return v.map((x: number) => f(x));
  throw exprError(src, `${name}() expects a number or vector.`);
}

/** Funktionen der Expression-Sprache. */
export const EXPR_FUNCTIONS: Readonly<Record<string, Fn>> = {
  sin: unaryMath(Math.sin, 'sin'),
  cos: unaryMath(Math.cos, 'cos'),
  tan: unaryMath(Math.tan, 'tan'),
  asin: unaryMath(Math.asin, 'asin'),
  acos: unaryMath(Math.acos, 'acos'),
  atan: unaryMath(Math.atan, 'atan'),
  abs: unaryMath(Math.abs, 'abs'),
  sign: unaryMath(Math.sign, 'sign'),
  floor: unaryMath(Math.floor, 'floor'),
  ceil: unaryMath(Math.ceil, 'ceil'),
  round: unaryMath(Math.round, 'round'),
  trunc: unaryMath(Math.trunc, 'trunc'),
  sqrt: unaryMath(Math.sqrt, 'sqrt'),
  exp: unaryMath(Math.exp, 'exp'),
  log: unaryMath(Math.log, 'log'),
  log2: unaryMath(Math.log2, 'log2'),
  log10: unaryMath(Math.log10, 'log10'),
  fract: unaryMath((x) => x - Math.floor(x), 'fract'),
  radians: unaryMath((x) => (x * Math.PI) / 180, 'radians'),
  degrees: unaryMath((x) => (x * 180) / Math.PI, 'degrees'),
  atan2: (a, _s, src) => Math.atan2(numArg(a, 0, src, 'atan2'), numArg(a, 1, src, 'atan2')),
  pow: (a, _s, src) => numArg(a, 0, src, 'pow') ** numArg(a, 1, src, 'pow'),
  hypot: (a, _s, src) => Math.hypot(...a.map((_, i) => numArg(a, i, src, 'hypot'))),
  min: (a, _s, src) => Math.min(...a.map((_, i) => numArg(a, i, src, 'min'))),
  max: (a, _s, src) => Math.max(...a.map((_, i) => numArg(a, i, src, 'max'))),
  mod: (a, _s, src) => {
    const x = numArg(a, 0, src, 'mod');
    const m = numArg(a, 1, src, 'mod');
    return ((x % m) + m) % m;
  },
  clamp: (a, _s, src) => Math.min(Math.max(numArg(a, 0, src, 'clamp'), numArg(a, 1, src, 'clamp')), numArg(a, 2, src, 'clamp')),
  lerp: (a, _s, src) => {
    const x = numArg(a, 0, src, 'lerp');
    const y = numArg(a, 1, src, 'lerp');
    return x + (y - x) * numArg(a, 2, src, 'lerp');
  },
  mix: (a, _s, src) => {
    const x = numArg(a, 0, src, 'mix');
    const y = numArg(a, 1, src, 'mix');
    return x + (y - x) * numArg(a, 2, src, 'mix');
  },
  smoothstep: (a, _s, src) => {
    const e0 = numArg(a, 0, src, 'smoothstep');
    const e1 = numArg(a, 1, src, 'smoothstep');
    const x = Math.min(Math.max((numArg(a, 2, src, 'smoothstep') - e0) / (e1 - e0), 0), 1);
    return x * x * (3 - 2 * x);
  },
  step: (a, _s, src) => (numArg(a, 1, src, 'step') < numArg(a, 0, src, 'step') ? 0 : 1),
  linear: (a, _s, src) => {
    const t = numArg(a, 0, src, 'linear');
    const t0 = numArg(a, 1, src, 'linear');
    const t1 = numArg(a, 2, src, 'linear');
    const v0 = numArg(a, 3, src, 'linear');
    const v1 = numArg(a, 4, src, 'linear');
    const p = t1 === t0 ? 1 : Math.min(Math.max((t - t0) / (t1 - t0), 0), 1);
    return v0 + (v1 - v0) * p;
  },
  ease: (a, _s, src) => easing(strArg(a, 0, src, 'ease'))(Math.min(Math.max(numArg(a, 1, src, 'ease'), 0), 1)),
  random: (a, s, src) => random(s.seed, 'expr', ...a.map((_, i) => numArg(a, i, src, 'random'))),
  randomRange: (a, s, src) => randomRange(s.seed, numArg(a, 1, src, 'randomRange'), numArg(a, 2, src, 'randomRange'), 'expr', numArg(a, 0, src, 'randomRange')),
  noise: (a, s, src) => (a.length >= 2 ? noise2(s.seed, numArg(a, 0, src, 'noise'), numArg(a, 1, src, 'noise')) : noise1(s.seed, numArg(a, 0, src, 'noise'))),
  wiggle: (a, s, src) => wiggle(s.seed, s.time, numArg(a, 0, src, 'wiggle'), numArg(a, 1, src, 'wiggle'), a.length > 2 ? numArg(a, 2, src, 'wiggle') : 1),
  marker: (a, s, src) => {
    const id = strArg(a, 0, src, 'marker');
    const t = s.markers?.get(id);
    if (t === undefined) throw exprError(src, `Marker "${id}" does not exist.`);
    return t;
  },
  event: (a, s, src) => {
    const id = strArg(a, 0, src, 'event');
    const ev = s.events?.get(id);
    if (ev === undefined) throw exprError(src, `Event "${id}" does not exist (a composition marker with kind "event").`);
    if (a.length < 2) return ev.time;
    const key = strArg(a, 1, src, 'event');
    const value = own(ev.data, key);
    if (value === undefined) throw exprError(src, `Event "${id}" has no data field "${key}".`);
    return typeof value === 'boolean' ? (value ? 1 : 0) : value;
  },
  vec: (a, _s, src) => a.map((_, i) => numArg(a, i, src, 'vec')),
  length: (a, _s, src) => {
    const v = a[0];
    if (typeof v !== 'object') throw exprError(src, 'length() expects a vector.');
    return Math.hypot(...v);
  },
};

const CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, PI: Math.PI, e: Math.E, tau: Math.PI * 2 };

function arith(op: string, a: number, b: number): number {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      return a / b;
    case '%':
      return a % b;
    case '**':
      return a ** b;
    case '<':
      return a < b ? 1 : 0;
    case '>':
      return a > b ? 1 : 0;
    case '<=':
      return a <= b ? 1 : 0;
    case '>=':
      return a >= b ? 1 : 0;
    case '==':
      return a === b ? 1 : 0;
    case '!=':
      return a !== b ? 1 : 0;
    default:
      return Number.NaN;
  }
}

function evaluate(node: Node, scope: ExprScope, src: string): ExprValue {
  switch (node.k) {
    case 'num':
      return node.v;
    case 'str':
      return node.v;
    case 'var': {
      const builtin: Readonly<Record<string, number>> = {
        frame: scope.frame,
        time: scope.time,
        fps: scope.fps,
        seed: scope.seed,
        duration: scope.duration,
        progress: scope.progress,
      };
      const v = own(builtin, node.name) ?? own(scope.vars, node.name) ?? own(CONSTANTS, node.name);
      if (v === undefined) throw exprError(src, `Unknown name "${node.name}".`);
      return v;
    }
    case 'arr':
      return node.items.map((item) => {
        const v = evaluate(item, scope, src);
        if (typeof v !== 'number') throw exprError(src, 'Vector items must be numbers.');
        return v;
      });
    case 'un': {
      const v = evaluate(node.arg, scope, src);
      if (node.op === '!') return truthy(v) ? 0 : 1;
      return node.op === '-' ? mapNum(v, (x) => -x, src, '-') : v;
    }
    case 'bin': {
      if (node.op === '&&') return truthy(evaluate(node.left, scope, src)) ? evaluate(node.right, scope, src) : 0;
      if (node.op === '||') {
        const l = evaluate(node.left, scope, src);
        return truthy(l) ? l : evaluate(node.right, scope, src);
      }
      const l = evaluate(node.left, scope, src);
      const r = evaluate(node.right, scope, src);
      if (typeof l === 'string' || typeof r === 'string') {
        if (node.op === '==') return l === r ? 1 : 0;
        if (node.op === '!=') return l !== r ? 1 : 0;
        throw exprError(src, `Operator "${node.op}" cannot use strings.`);
      }
      if (typeof l === 'number' && typeof r === 'number') return arith(node.op, l, r);
      const la: readonly number[] = typeof l === 'number' ? [] : l;
      const ra: readonly number[] = typeof r === 'number' ? [] : r;
      const n = Math.max(la.length, ra.length);
      if (typeof l !== 'number' && typeof r !== 'number' && la.length !== ra.length) throw exprError(src, 'Vectors must have the same length.');
      return Array.from({ length: n }, (_, i) => arith(node.op, typeof l === 'number' ? l : (la[i] ?? 0), typeof r === 'number' ? r : (ra[i] ?? 0)));
    }
    case 'cond':
      return truthy(evaluate(node.test, scope, src)) ? evaluate(node.then, scope, src) : evaluate(node.other, scope, src);
    case 'call': {
      const fn = own(EXPR_FUNCTIONS, node.name);
      if (fn === undefined) throw exprError(src, `Unknown function "${node.name}".`);
      return fn(
        node.args.map((a) => evaluate(a, scope, src)),
        scope,
        src,
      );
    }
    case 'idx': {
      const target = evaluate(node.target, scope, src);
      const index = evaluate(node.index, scope, src);
      if (typeof target !== 'object' || typeof index !== 'number') throw exprError(src, 'Indexing needs a vector and a number.');
      const v = target[Math.floor(index)];
      if (v === undefined) throw exprError(src, `Index ${String(index)} is out of range.`);
      return v;
    }
  }
}

function truthy(v: ExprValue): boolean {
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v.length > 0;
  return v.length > 0;
}

/** Eine geparste, wiederverwendbare Expression. */
export interface CompiledExpression {
  readonly source: string;
  evaluate(scope: ExprScope): ExprValue;
}

const compiled = new Map<string, CompiledExpression>();

/**
 * Parst einen Ausdruck. Syntaxfehler werfen einen {@link OpenVideoError}.
 *
 * @example
 * ```ts
 * const e = compileExpression('sin(time * 2) * 40');
 * e.evaluate({ frame: 0, time: 0.25, fps: 30, seed: 0, duration: 5, progress: 0.05 }); // ≈ 19.18
 * ```
 */
export function compileExpression(source: string): CompiledExpression {
  const hit = compiled.get(source);
  if (hit !== undefined) return hit;
  const ast = new Parser(tokenize(source), source).parse();
  checkNames(ast, source);
  const result: CompiledExpression = { source, evaluate: (scope) => evaluate(ast, scope, source) };
  compiled.set(source, result);
  return result;
}

function checkNames(node: Node, src: string): void {
  switch (node.k) {
    case 'call':
      if (own(EXPR_FUNCTIONS, node.name) === undefined) throw exprError(src, `Unknown function "${node.name}".`);
      node.args.forEach((a) => {
        checkNames(a, src);
      });
      return;
    case 'un':
      checkNames(node.arg, src);
      return;
    case 'bin':
      checkNames(node.left, src);
      checkNames(node.right, src);
      return;
    case 'cond':
      checkNames(node.test, src);
      checkNames(node.then, src);
      checkNames(node.other, src);
      return;
    case 'arr':
      node.items.forEach((a) => {
        checkNames(a, src);
      });
      return;
    case 'idx':
      checkNames(node.target, src);
      checkNames(node.index, src);
      return;
    default:
      return;
  }
}

/** Wertet einen Ausdruck direkt aus. */
export function evaluateExpression(source: string, scope: ExprScope): ExprValue {
  return compileExpression(source).evaluate(scope);
}
