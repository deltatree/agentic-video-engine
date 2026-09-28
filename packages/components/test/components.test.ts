import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Registry, SCHEMA_VERSION, evaluateScene, validateProject, validateValue, walkEvaluated, type EvaluatedNode, type ExpandContext, type Theme } from '@agentic-video/core';
import {
  COMPONENTS,
  COMPONENT_NAMES,
  DEFAULT_THEME,
  LANGUAGES,
  THEMES,
  arcPath,
  formatNumber,
  niceScale,
  registerComponents,
  resolveTheme,
  tokenize,
} from '@agentic-video/components';

const FPS = 30;
const DURATION = 90;

function project(component: string, props: Record<string, unknown>, theme?: Theme): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA_VERSION,
    ...(theme !== undefined ? { settings: { theme } } : {}),
    compositions: [{ id: 'main', width: 1280, height: 720, fps: FPS, duration: DURATION, nodes: [{ id: 'c', type: 'component', component, props, x: 40, y: 40 }] }],
  };
}

function registry(): Registry {
  const r = new Registry();
  registerComponents(r);
  return r;
}

function ctxAt(frame: number, theme: Theme = {}): ExpandContext {
  return { id: 'c', frame, fps: FPS, seed: 7, durationFrames: DURATION, compositionWidth: 1280, compositionHeight: 720, theme, project: {}, compositionId: 'main' };
}

function root(scene: ReturnType<typeof evaluateScene>): EvaluatedNode {
  const c = scene.nodes[0];
  const r = c?.children[0];
  if (r === undefined) throw new Error('component did not expand');
  return r;
}

/** Sammelt alle Farbwerte aus den ausgewerteten Props (rekursiv). */
function colors(nodes: readonly EvaluatedNode[]): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === 'string' && /^#[0-9A-Fa-f]{3,8}$/u.test(v)) out.push(v.toUpperCase());
    else if (Array.isArray(v)) v.forEach(visit);
    else if (typeof v === 'object' && v !== null) Object.values(v).forEach(visit);
  };
  walkEvaluated(nodes, (n) => {
    visit(n.props);
    if (n.mask !== undefined) visit(n.mask.node.props);
  });
  return out.sort();
}

function hasNaN(nodes: readonly EvaluatedNode[]): string | undefined {
  let bad: string | undefined;
  const visit = (v: unknown, where: string): void => {
    if (typeof v === 'number' && !Number.isFinite(v)) bad = where;
    else if (Array.isArray(v)) v.forEach((x, i) => { visit(x, `${where}[${String(i)}]`); });
    else if (typeof v === 'object' && v !== null) Object.entries(v).forEach(([k, x]) => { visit(x, `${where}.${k}`); });
  };
  walkEvaluated(nodes, (n) => { visit(n.props, n.id); });
  return bad;
}

describe('Komponentenbibliothek (FR-82)', () => {
  it('enthält die 29 Komponenten aus A30', () => {
    expect(COMPONENT_NAMES).toEqual([
      'Title', 'Subtitle', 'LowerThird', 'Callout', 'Badge', 'Card', 'BrowserWindow', 'CodeEditor', 'Terminal', 'Chart', 'BarChart', 'LineChart', 'PieChart', 'Table',
      'Logo', 'DeviceFrame', 'Phone', 'Laptop', 'Cursor', 'Arrow', 'Connector', 'Grid', 'ParticleField', 'GradientBackground', 'Spotlight', 'GlassPanel', 'ProgressBar', 'Counter', 'Typewriter',
    ]);
    expect(registry().components.size).toBe(29);
  });

  describe.each(COMPONENTS.map((c) => [c.name, c] as const))('%s', (name, def) => {
    it('hat Beschreibung, Props-Schema und ein Beispiel, das zum Schema passt', () => {
      expect(def.description.length).toBeGreaterThan(20);
      expect(def.propsSchema).toBeDefined();
      expect(validateValue(def.propsSchema ?? {}, def.example)).toEqual([]);
    });

    it('expandiert das Beispiel zu gültigen Nodes ohne Diagnosen', () => {
      expect(validateProject(project(name, { ...def.example }), { components: COMPONENT_NAMES }).diagnostics).toEqual([]);
      for (const frame of [0, 7, 15, 45, 80, 89]) {
        const expanded = def.expand({ ...def.example }, ctxAt(frame));
        const check = validateProject({
          schemaVersion: SCHEMA_VERSION,
          compositions: [{ id: 'main', width: 1280, height: 720, fps: FPS, duration: DURATION, nodes: [{ id: 'wrap', type: 'group', children: expanded }] }],
        });
        expect(check.diagnostics, `frame ${String(frame)}`).toEqual([]);
        const scene = evaluateScene(project(name, { ...def.example }), 'main', frame, { registry: registry() });
        expect(scene.diagnostics, `frame ${String(frame)}`).toEqual([]);
        expect(scene.nodes[0]?.children.length).toBeGreaterThan(0);
        expect(hasNaN(scene.nodes)).toBeUndefined();
      }
    });

    it('übernimmt Farben aus dem Theme', () => {
      const dark = colors(evaluateScene(project(name, { ...def.example }, THEMES.dark), 'main', 45, { registry: registry() }).nodes);
      const light = colors(evaluateScene(project(name, { ...def.example }, THEMES.light), 'main', 45, { registry: registry() }).nodes);
      const neon = colors(evaluateScene(project(name, { ...def.example }, THEMES.neon), 'main', 45, { registry: registry() }).nodes);
      expect(dark.length).toBeGreaterThan(0);
      expect(dark).not.toEqual(light);
      expect(dark).not.toEqual(neon);
    });

    it('blendet ein und aus (enter/exit)', () => {
      const props = { ...def.example, enter: { type: 'slide-up', duration: 10 }, exit: { type: 'fade', duration: 10 } };
      const at = (f: number) => root(evaluateScene(project(name, props), 'main', f, { registry: registry() })).props;
      expect(at(0)['opacity']).toBe(0);
      expect(at(0)['y']).toBe(DEFAULT_THEME.spacing.xl);
      expect(at(5)['opacity']).toBeGreaterThan(0);
      expect(at(10)['opacity']).toBe(1);
      expect(at(10)['y']).toBe(0);
      expect(at(84)['opacity']).toBeLessThan(1);
      expect(at(89)['opacity']).toBe(0);
    });

    it('ist deterministisch', () => {
      const a = evaluateScene(project(name, { ...def.example }), 'main', 33, { registry: registry() });
      const b = evaluateScene(project(name, { ...def.example }), 'main', 33, { registry: registry() });
      expect(JSON.stringify(a.nodes)).toBe(JSON.stringify(b.nodes));
    });
  });

  it('nutzt Standard-Einblendung aus dem Theme (Dauer theme.motion.normal)', () => {
    const at = (f: number) => root(evaluateScene(project('Card', { title: 'x' }), 'main', f, { registry: registry() })).props;
    // Card: slide-up, 0.5 s = 15 Frames
    expect(at(0)['opacity']).toBe(0);
    expect(at(0)['y']).toBeGreaterThan(0);
    expect(at(15)['opacity']).toBe(1);
    expect(at(15)['y']).toBe(0);
    const none = root(evaluateScene(project('Card', { title: 'x', enter: 'none', exit: 'none' }), 'main', 0, { registry: registry() })).props;
    expect(none['opacity']).toBeUndefined();
  });

  it('kürzt Ein- und Ausblendung anteilig, wenn die Dauer nicht reicht', () => {
    const def = COMPONENTS.find((c) => c.name === 'Badge');
    const nodes = def?.expand({ label: 'x', enter: { type: 'fade', duration: 60 }, exit: { type: 'fade', duration: 60 } }, ctxAt(0)) ?? [];
    expect(JSON.stringify(nodes[0])).toContain('"t":44.5');
  });

  it('wertet animierte Props pro Frame aus (ProgressBar.progress)', () => {
    const props = { progress: { $keyframes: [{ t: 0, v: 0 }, { t: 60, v: 1 }] }, enter: 'none', exit: 'none' };
    const fill = (f: number) => root(evaluateScene(project('ProgressBar', props), 'main', f, { registry: registry() })).children.find((n) => n.id === 'c/fill')?.props['width'];
    expect(fill(0)).toBe(0);
    expect(fill(30)).toBe(300);
    expect(fill(60)).toBe(600);
  });

  it('Counter zählt mit Format, Typewriter tippt mit Cursor', () => {
    const counter = (f: number) => root(evaluateScene(project('Counter', { from: 0, to: 1234.5, decimals: 1, prefix: '€ ', duration: 30, ease: 'linear' }), 'main', f, { registry: registry() })).children[0]?.props['text'];
    expect(counter(0)).toBe('€ 0.0');
    expect(counter(15)).toBe('€ 617.3');
    expect(counter(40)).toBe('€ 1,234.5');
    const typed = root(evaluateScene(project('Typewriter', { text: 'Hello', speed: 10 }), 'main', 9, { registry: registry() })).children[0]?.props['spans'];
    expect(typed).toEqual([{ text: 'Hel' }, { text: '|', fill: DEFAULT_THEME.colors.accent }]);
  });

  it('CodeEditor tippt Code und nummeriert Zeilen', () => {
    const def = COMPONENTS.find((c) => c.name === 'CodeEditor');
    const nodes = def?.expand({ code: 'let a = 1;\nlet b = 2;', language: 'js', typing: 10 }, ctxAt(45)) ?? [];
    const json = JSON.stringify(nodes);
    expect(json).toContain('"text":"let"');
    expect(json).toContain('"text":"1\\n2"');
    expect(json).not.toContain('b = 2');
  });

  it('Terminal zeigt Ausgabe erst nach dem Tippen', () => {
    const def = COMPONENTS.find((c) => c.name === 'Terminal');
    const early = JSON.stringify(def?.expand({ commands: [{ command: 'ls', output: 'file.txt' }], typing: 10 }, ctxAt(3)));
    const late = JSON.stringify(def?.expand({ commands: [{ command: 'ls', output: 'file.txt' }], typing: 10 }, ctxAt(30)));
    expect(early).not.toContain('file.txt');
    expect(late).toContain('file.txt');
  });

  it('Chart wählt den Typ und Charts wachsen mit progress', () => {
    const def = COMPONENTS.find((c) => c.name === 'Chart');
    const pie = JSON.stringify(def?.expand({ type: 'pie', data: [{ label: 'a', value: 1 }], progress: 1 }, ctxAt(0)));
    expect(pie).toContain('"type":"path"');
    const bar = (progress: number) => (def?.expand({ type: 'bar', data: [{ label: 'a', value: 10 }], progress }, ctxAt(0)) ?? [])[0];
    const barHeight = (progress: number) => JSON.stringify(bar(progress)).match(/"id":"bar-0"[^}]*"height":([0-9.]+)/u)?.[1];
    expect(barHeight(0)).toBe('0');
    expect(Number(barHeight(1))).toBeGreaterThan(100);
  });
});

describe('Theme-Tokens (FR-83)', () => {
  it('ergänzt Teil-Themes mit Standardwerten', () => {
    const t = resolveTheme({ colors: { primary: '#FF0000' } });
    expect(t.colors.primary).toBe('#FF0000');
    expect(t.colors.surface).toBe(DEFAULT_THEME.colors.surface);
    expect(t.motion).toEqual(DEFAULT_THEME.motion);
    expect(resolveTheme(undefined)).toEqual(DEFAULT_THEME);
  });

  it('liefert vollständige, gültige Themes', () => {
    for (const [name, theme] of Object.entries(THEMES)) {
      const result = validateProject({ ...project('Badge', { label: 'x' }, theme) });
      expect(result.diagnostics, name).toEqual([]);
      for (const key of ['background', 'surface', 'primary', 'secondary', 'accent', 'text', 'muted', 'success', 'warning', 'danger']) expect(theme.colors[key], `${name}.${key}`).toMatch(/^#/u);
    }
  });

  it('färbt ein ganzes Video über settings.theme um', () => {
    const custom = colors(evaluateScene(project('Badge', { label: 'x' }, { colors: { primary: '#123456' } }), 'main', 45, { registry: registry() }).nodes);
    expect(custom).toContain('#123456');
  });
});

describe('Tokenizer', () => {
  it('ergibt zusammengesetzt immer den Quelltext', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), fc.constantFrom(...LANGUAGES), (src, lang) => {
        expect(tokenize(src, lang).map((t) => t.text).join('')).toBe(src);
      }),
    );
  });

  it('erkennt Schlüsselwörter, Strings, Zahlen, Kommentare, Typen und Funktionen', () => {
    const kinds = (src: string, lang: (typeof LANGUAGES)[number]) => tokenize(src, lang).filter((t) => t.kind !== 'plain' && t.kind !== 'punctuation').map((t) => `${t.kind}:${t.text.trim()}`);
    expect(kinds('const x: Foo = run("a", 42); // hi', 'ts')).toEqual(['keyword:const', 'type:Foo', 'function:run', 'string:"a"', 'number:42', 'comment:// hi']);
    expect(kinds('def f(n: int):\n    return None  # x', 'python')).toEqual(['keyword:def', 'function:f', 'type:int', 'keyword:return', 'keyword:None', 'comment:# x']);
    expect(kinds('{"a": true, "b": 1.5}', 'json')).toEqual(['function:"a"', 'keyword:true', 'function:"b"', 'number:1.5']);
    expect(kinds('echo "hi" # c', 'bash')).toEqual(['keyword:echo', 'string:"hi"', 'comment:# c']);
    expect(kinds('fn main() { let v: Vec<i32> = vec![]; }', 'rust')).toEqual(['keyword:fn', 'function:main', 'keyword:let', 'type:Vec', 'type:i32', 'function:vec']);
    expect(kinds('func main() { var s string = "x" }', 'go')).toEqual(['keyword:func', 'function:main', 'keyword:var', 'type:string', 'string:"x"']);
    expect(kinds('.a { color: #fff; } /* c */', 'css')).toEqual(['function:color', 'comment:/* c */']);
    expect(kinds('<div class="x"><!-- c --></div>', 'html')).toEqual(['keyword:div', 'function:class', 'string:"x"', 'comment:<!-- c -->', 'keyword:div']);
  });
});

describe('Hilfsfunktionen', () => {
  it('formatiert Zahlen', () => {
    expect(formatNumber(1234567.891, 2, ',', '.')).toBe('1,234,567.89');
    expect(formatNumber(-0.004, 2, ',', '.')).toBe('0.00');
    expect(formatNumber(999, 0, '.', ',')).toBe('999');
  });

  it('wählt runde Achsen', () => {
    expect(niceScale(87)).toEqual({ max: 100, step: 25 });
    expect(niceScale(0)).toEqual({ max: 1, step: 0.25 });
  });

  it('zeichnet volle Ringe als zwei Bögen', () => {
    expect(arcPath(10, 10, 10, 5, 0, 360).match(/M /gu)).toHaveLength(2);
  });
});
