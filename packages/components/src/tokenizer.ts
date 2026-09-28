/**
 * Kleiner, deterministischer Tokenizer für Syntax-Hervorhebung in `CodeEditor` und `Terminal`.
 *
 * Er erkennt Schlüsselwörter, Strings, Zahlen, Kommentare, Typen und Funktionsaufrufe.
 * Er ist kein Parser: Ziel ist eine gut lesbare Einfärbung, nicht Korrektheit.
 */

/** Unterstützte Sprachen. */
export const LANGUAGES = ['ts', 'js', 'json', 'python', 'bash', 'css', 'html', 'rust', 'go'] as const;
/** Eine unterstützte Sprache. */
export type Language = (typeof LANGUAGES)[number];

/** Art eines Tokens. */
export type TokenKind = 'keyword' | 'string' | 'number' | 'comment' | 'type' | 'function' | 'punctuation' | 'plain';

/** Ein Token: Text und Art. Die Texte aller Tokens ergeben zusammen den Quelltext. */
export interface Token {
  readonly text: string;
  readonly kind: TokenKind;
}

interface LanguageRules {
  readonly keywords: ReadonlySet<string>;
  readonly types: ReadonlySet<string>;
  readonly lineComment?: string;
  readonly blockComment?: readonly [string, string];
  readonly quotes: string;
  /** Großgeschriebene Bezeichner gelten als Typen. */
  readonly capitalTypes: boolean;
}

const words = (s: string): ReadonlySet<string> => new Set(s.split(' '));

const JS_KEYWORDS =
  'break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return super switch this throw try typeof var void while with yield async await static get set true false null undefined as';

const RULES: Readonly<Record<Language, LanguageRules>> = {
  ts: {
    keywords: words(`${JS_KEYWORDS} interface type enum implements private protected public readonly declare namespace abstract keyof satisfies infer is`),
    types: words('string number boolean unknown never any void object bigint symbol'),
    lineComment: '//',
    blockComment: ['/*', '*/'],
    quotes: '\'"`',
    capitalTypes: true,
  },
  js: { keywords: words(JS_KEYWORDS), types: words(''), lineComment: '//', blockComment: ['/*', '*/'], quotes: '\'"`', capitalTypes: true },
  json: { keywords: words('true false null'), types: words(''), quotes: '"', capitalTypes: false },
  python: {
    keywords: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None self'),
    types: words('int float str bool list dict set tuple bytes object'),
    lineComment: '#',
    quotes: '\'"',
    capitalTypes: true,
  },
  bash: {
    keywords: words('if then else elif fi for while until do done case esac in function return export local readonly echo cd sudo exit set source'),
    types: words('npm npx node git ls cat grep curl docker'),
    lineComment: '#',
    quotes: '\'"',
    capitalTypes: false,
  },
  css: {
    keywords: words('important media import from to keyframes root hover focus active before after'),
    types: words('px em rem vh vw deg ms s'),
    blockComment: ['/*', '*/'],
    quotes: '\'"',
    capitalTypes: false,
  },
  html: { keywords: words(''), types: words(''), blockComment: ['<!--', '-->'], quotes: '\'"', capitalTypes: false },
  rust: {
    keywords: words('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'),
    types: words('i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box'),
    lineComment: '//',
    blockComment: ['/*', '*/'],
    quotes: '"',
    capitalTypes: true,
  },
  go: {
    keywords: words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil'),
    types: words('int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 string bool byte rune error any'),
    lineComment: '//',
    blockComment: ['/*', '*/'],
    quotes: '"`\'',
    capitalTypes: true,
  },
};

/** Prüft, ob ein Name eine unterstützte Sprache ist. */
export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((l) => l === value);
}

const IDENT_START = /[A-Za-z_$]/u;
const IDENT = /[A-Za-z0-9_$-]/u;
const DIGIT = /[0-9]/u;
const NUMBER = /^(0[xXbBoO][0-9a-fA-F_]+|[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9]+)?[a-zA-Z%]*)/u;

function push(out: Token[], text: string, kind: TokenKind): void {
  if (text === '') return;
  const last = out[out.length - 1];
  // Benachbarte Tokens gleicher Art zusammenfassen: weniger Spans im Rich-Text.
  if (last?.kind === kind) out[out.length - 1] = { text: last.text + text, kind };
  else out.push({ text, kind });
}

/** Liest einen String ab `i` bis zum passenden Anführungszeichen (mit Escapes, ohne Zeilenumbruch außer bei Backticks). */
function readString(src: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') j += 2;
    else if (c === quote) return j + 1;
    else if (c === '\n' && quote !== '`') return j;
    else j++;
  }
  return src.length;
}

function tokenizeHtml(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      const j = end < 0 ? src.length : end + 3;
      push(out, src.slice(i, j), 'comment');
      i = j;
    } else if (src[i] === '<') {
      const close = src.indexOf('>', i);
      const j = close < 0 ? src.length : close + 1;
      const tag = src.slice(i, j);
      const m = /^(<\/?)([A-Za-z0-9-]*)/u.exec(tag);
      const head = m?.[0] ?? '<';
      push(out, m?.[1] ?? '<', 'punctuation');
      push(out, m?.[2] ?? '', 'keyword');
      let k = head.length;
      while (k < tag.length) {
        const c = tag[k] ?? '';
        if (c === '"' || c === "'") {
          const e = readString(tag, k, c);
          push(out, tag.slice(k, e), 'string');
          k = e;
        } else if (/[A-Za-z_:@-]/u.test(c)) {
          let e = k;
          while (e < tag.length && /[A-Za-z0-9_:@.-]/u.test(tag[e] ?? '')) e++;
          push(out, tag.slice(k, e), 'function');
          k = e;
        } else {
          push(out, c, c.trim() === '' ? 'plain' : 'punctuation');
          k++;
        }
      }
      i = j;
    } else {
      const next = src.indexOf('<', i);
      const j = next < 0 ? src.length : next;
      push(out, src.slice(i, j), 'plain');
      i = j;
    }
  }
  return out;
}

/**
 * Zerlegt Quelltext in Tokens. Die Texte aller Tokens ergeben zusammen genau den Quelltext.
 *
 * @example
 * ```ts
 * tokenize('const x = 1;', 'ts');
 * // [{ text: 'const', kind: 'keyword' }, { text: ' x = ', kind: 'plain' }, { text: '1', kind: 'number' }, { text: ';', kind: 'punctuation' }]
 * ```
 */
export function tokenize(src: string, language: Language): Token[] {
  if (language === 'html') return tokenizeHtml(src);
  const rules = RULES[language];
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? '';
    if (rules.lineComment !== undefined && src.startsWith(rules.lineComment, i) && !(language === 'bash' && i > 0 && /\S/u.test(src[i - 1] ?? ''))) {
      const end = src.indexOf('\n', i);
      const j = end < 0 ? src.length : end;
      push(out, src.slice(i, j), 'comment');
      i = j;
    } else if (rules.blockComment !== undefined && src.startsWith(rules.blockComment[0], i)) {
      const end = src.indexOf(rules.blockComment[1], i + rules.blockComment[0].length);
      const j = end < 0 ? src.length : end + rules.blockComment[1].length;
      push(out, src.slice(i, j), 'comment');
      i = j;
    } else if (rules.quotes.includes(c)) {
      // Python-Docstrings mit drei Anführungszeichen
      const triple = c + c + c;
      if (language === 'python' && src.startsWith(triple, i)) {
        const end = src.indexOf(triple, i + 3);
        const j = end < 0 ? src.length : end + 3;
        push(out, src.slice(i, j), 'string');
        i = j;
      } else {
        const j = readString(src, i, c);
        // JSON: Schlüssel vor ':' als Funktion (Feldname) einfärben
        const isKey = language === 'json' && /^\s*:/u.test(src.slice(j));
        push(out, src.slice(i, j), isKey ? 'function' : 'string');
        i = j;
      }
    } else if (DIGIT.test(c) || (c === '.' && DIGIT.test(src[i + 1] ?? ''))) {
      const m = NUMBER.exec(src.slice(i));
      const text = m?.[0] ?? c;
      push(out, text, 'number');
      i += text.length;
    } else if (IDENT_START.test(c) || (language === 'css' && (c === '-' || c === '@' || c === '#'))) {
      let j = i + 1;
      const identChar = language === 'css' || language === 'bash' ? IDENT : /[A-Za-z0-9_$]/u;
      while (j < src.length && identChar.test(src[j] ?? '')) j++;
      const word = src.slice(i, j);
      const bare = word.replace(/^[@#-]+/u, '');
      let k = j;
      while (src[k] === ' ') k++;
      let kind: TokenKind = 'plain';
      if (rules.keywords.has(bare) || (language === 'css' && word.startsWith('@'))) kind = 'keyword';
      else if (rules.types.has(bare)) kind = 'type';
      else if (language === 'css' && src[k] === ':' && !word.startsWith('#')) kind = 'function';
      else if (src[k] === '(' || (language === 'rust' && src[j] === '!')) kind = 'function';
      else if (rules.capitalTypes && /^[A-Z]/u.test(word)) kind = 'type';
      push(out, word, kind);
      i = j;
    } else if (/\s/u.test(c)) {
      push(out, c, 'plain');
      i++;
    } else if (/[{}()[\];,.:<>=+\-*/%!&|^~?]/u.test(c)) {
      push(out, c, 'punctuation');
      i++;
    } else {
      push(out, c, 'plain');
      i++;
    }
  }
  return out;
}
