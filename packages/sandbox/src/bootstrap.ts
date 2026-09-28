/**
 * Startskript im Kindprozess (Container oder `trusted-host`).
 *
 * Es liest `{ code, input, isolated, timeoutMs, filename }` als JSON von stdin,
 * führt `code` als Skript aus und schreibt den Abschlusswert als JSON nach stdout.
 * Das Ergebnis steht in der letzten Zeile hinter {@link RESULT_MARK}.
 *
 * - `isolated: false` (Docker): Der Code läuft wie normales Node. Die Grenze ist der Container.
 * - `isolated: true` (`trusted-host`): Der Code läuft in einem leeren `node:vm`-Kontext ohne
 *   `require`, `process`, `fetch` und Netz-Module. Nur `input` ist gesetzt. Das schützt vor
 *   Versehen, ist aber **keine Sicherheitsgrenze**: `node:vm` lässt sich verlassen. Deshalb
 *   startet der Host den Prozess mit leerer Umgebung und nur für eigenen Code.
 *
 * Kommt {@link RESULT_MARK} im Ergebnis vor, wird es im JSON als `\u005f…` maskiert,
 * damit die letzte Marke auf stdout immer die echte ist.
 */

/** Markierung vor der Ergebniszeile auf stdout. */
export const RESULT_MARK = '__OPENVIDEO_SANDBOX_RESULT__';

/** Die Marke mit JSON-Escape für das erste Zeichen; nur innerhalb von JSON-Strings gültig. */
const ESCAPED_MARK = `\\u005f${RESULT_MARK.slice(1)}`;

/**
 * Vorspann im leeren VM-Kontext (`trusted-host`): reine JavaScript-Fassungen von
 * `TextEncoder`/`TextDecoder` (UTF-8) und ein `console`, das nach stderr sammelt.
 * Es gelangt kein Objekt des Host-Realms in den Kontext.
 */
const PRELUDE_SOURCE = `
globalThis.__logs = [];
globalThis.console = Object.freeze(Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map((k) => [k, (...a) => { __logs.push(a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')); }])));
globalThis.TextEncoder = class TextEncoder {
  get encoding() { return 'utf-8'; }
  encode(input = '') {
    const out = [];
    for (const ch of String(input)) {
      let c = ch.codePointAt(0);
      if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }
};
globalThis.TextDecoder = class TextDecoder {
  get encoding() { return 'utf-8'; }
  decode(input) {
    const b = input === undefined ? new Uint8Array(0) : input instanceof Uint8Array ? input : new Uint8Array(input.buffer ?? input);
    let s = '';
    for (let i = 0; i < b.length; ) {
      const x = b[i];
      const n = x < 0x80 ? 1 : x >= 0xf0 ? 4 : x >= 0xe0 ? 3 : x >= 0xc0 ? 2 : 0;
      if (n === 0 || i + n > b.length) { s += '\\ufffd'; i += 1; continue; }
      let c = n === 1 ? x : x & (0xff >> (n + 1));
      for (let k = 1; k < n; k++) c = (c << 6) | (b[i + k] & 63);
      s += String.fromCodePoint(c);
      i += n;
    }
    return s;
  }
};
`;

/** Quelltext des Startskripts (CommonJS, ohne Abhängigkeiten). */
export const BOOTSTRAP_SOURCE = `'use strict';
const vm = require('node:vm');
const PRELUDE = ${JSON.stringify(PRELUDE_SOURCE)};
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const MARK = ${JSON.stringify(RESULT_MARK)};
  const send = (text) => process.stdout.write('\\n' + MARK + text.split(MARK).join(${JSON.stringify(ESCAPED_MARK)}) + '\\n');
  const fail = (e) => {
    const err = e !== null && typeof e === 'object' ? e : { message: String(e) };
    let diagnostic;
    try { diagnostic = err.diagnostic !== null && typeof err.diagnostic === 'object' ? JSON.parse(JSON.stringify(err.diagnostic)) : undefined; } catch { diagnostic = undefined; }
    send(JSON.stringify({ ok: false, error: { name: String(err.name), message: String(err.message), stack: String(err.stack), code: err.code === undefined ? undefined : String(err.code), diagnostic } }));
  };
  const finish = (value) => {
    try { send('{"ok":true,"output":' + (value === undefined ? 'null' : JSON.stringify(value)) + '}'); } catch (e) { fail(e); }
  };
  let req;
  try { req = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { fail(e); return; }
  try {
    let value;
    if (req.isolated) {
      // Objekt ohne Prototyp: kein Weg über this.constructor zum Function-Konstruktor des Hosts.
      const ctx = vm.createContext(Object.assign(Object.create(null), { __input: JSON.stringify(req.input === undefined ? null : req.input) }));
      vm.runInContext(PRELUDE + 'globalThis.input = JSON.parse(__input); delete globalThis.__input;', ctx);
      try {
        value = vm.runInContext(req.code, ctx, { filename: req.filename, timeout: req.timeoutMs });
      } finally {
        const logs = vm.runInContext('__logs.splice(0).join(String.fromCharCode(10))', ctx);
        if (logs) process.stderr.write(logs + '\\n');
      }
    } else {
      globalThis.input = req.input;
      value = vm.runInThisContext(req.code, { filename: req.filename });
    }
    if (value !== null && typeof value === 'object' && typeof value.then === 'function') value.then(finish, fail);
    else finish(value);
  } catch (e) { fail(e); }
});
`;
