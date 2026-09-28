/**
 * Frühe Prüfungen der Agent API: Skript-Hinweis (ADR 0008) und Grenzen gegen Überlast.
 *
 * Die harte Grenze für Skripte setzt der Browser-Host (Sandbox und CSP). Diese Prüfung ist
 * nur eine frühe, freundliche Diagnose. Sie prüft darum großzügig alle Strings von HTML-Nodes,
 * auch animierte Werte, und zusätzlich die ausgewertete Szene (HTML-Nodes aus Komponenten).
 */
import { OpenVideoError, evaluateScene, isRecord, walkEvaluated, type Registry } from '@agentic-video/core';

/**
 * Muster für aktive Inhalte: `<script>`, Event-Handler (auch `<img/onerror=`), `javascript:`,
 * `srcdoc`, eingebettete Dokumente und ein Ausbruch aus `<style>` (Feld `css`).
 */
const SCRIPT_PATTERN = /<\s*script\b|[\s"'/]on[a-z]+\s*=|javascript\s*:|\bsrcdoc\s*=|<\s*(?:iframe|object|embed|frame|base|meta)\b|<\/\s*style\b/iu;

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (isRecord(value)) for (const v of Object.values(value)) collectStrings(v, out);
}

function hasScript(value: unknown): boolean {
  const strings: string[] = [];
  collectStrings(value, strings);
  return strings.some((s) => SCRIPT_PATTERN.test(s));
}

/**
 * Findet HTML-Nodes der IR, deren Strings (HTML, CSS, animierte Werte) nach Skript aussehen.
 *
 * @example
 * ```ts
 * containsScripts({ compositions: [{ nodes: [{ id: 'h', type: 'html', html: '<img/onerror=x>' }] }] }); // ['h']
 * ```
 */
export function containsScripts(project: Readonly<Record<string, unknown>>): string[] {
  const hits: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (isRecord(value)) {
      if (value['type'] === 'html') {
        const { children: _children, ...own } = value;
        if (hasScript(own)) hits.push(String(value['id']));
      }
      for (const v of Object.values(value)) visit(v);
    }
  };
  visit(project['compositions']);
  return hits;
}

/** Ein Frame einer Composition, der ausgewertet werden soll. */
export interface SceneSample {
  readonly compositionId?: string | undefined;
  readonly frame: number;
}

/**
 * Wertet die Szene an den gegebenen Frames aus und meldet HTML-Nodes mit Skript-Mustern.
 * So fallen auch HTML-Nodes auf, die erst Komponenten oder Expander erzeugen.
 *
 * @example
 * ```ts
 * scriptsInScene(project, [{ frame: 0 }], env.registry); // ['embed/inner']
 * ```
 */
export function scriptsInScene(project: Readonly<Record<string, unknown>>, samples: readonly SceneSample[], registry: Registry): string[] {
  const hits = new Set<string>();
  for (const sample of samples) {
    const scene = evaluateScene(project, sample.compositionId, sample.frame, { registry });
    walkEvaluated(scene.nodes, (node) => {
      if (node.type === 'html' && hasScript(node.props)) hits.add(node.id);
    });
  }
  return [...hits];
}

/**
 * Wählt bis zu `count` gleichmäßig verteilte Frames aus `[start, end)`.
 *
 * @example
 * ```ts
 * sampleFrames(0, 100, 3); // [0, 50, 99]
 * ```
 */
export function sampleFrames(start: number, end: number, count: number): number[] {
  const last = Math.max(start, end - 1);
  if (count <= 1 || last === start) return [start];
  const out = new Set<number>();
  for (let i = 0; i < count; i++) out.add(Math.round(start + ((last - start) * i) / (count - 1)));
  return [...out];
}

/** Grenzen der Agent API gegen Überlast (B9). */
export const AGENT_LIMITS = {
  /** Größte Kantenlänge eines Ausgabebildes in Pixeln. */
  maxDimension: 8192,
  /** Größte Pixelzahl eines Ausgabebildes (8K UHD). */
  maxPixels: 7680 * 4320,
  /** Größte Bildrate eines Profils. */
  maxFps: 240,
  /** Größte Zahl an Ausgabe-Frames eines Render-Jobs (1 h bei 60 fps). */
  maxFrames: 216_000,
} as const;

function limitError(problem: string, suggestion: string): OpenVideoError {
  return new OpenVideoError({ code: 'OV_LIMIT_EXCEEDED', errorClass: 'ApiError', problem, suggestions: [suggestion] });
}

/**
 * Prüft Maße eines Ausgabebildes gegen {@link AGENT_LIMITS}.
 *
 * @example
 * ```ts
 * assertImageSize(1920, 1080, 'frame.render'); // ok
 * ```
 */
export function assertImageSize(width: number, height: number, what: string): void {
  const w = Math.round(width);
  const h = Math.round(height);
  if (w > AGENT_LIMITS.maxDimension || h > AGENT_LIMITS.maxDimension || w * h > AGENT_LIMITS.maxPixels) {
    throw limitError(
      `${what}: the output image ${String(w)}×${String(h)} exceeds the limit (${String(AGENT_LIMITS.maxDimension)} px per side, ${String(AGENT_LIMITS.maxPixels)} pixels).`,
      'Use a smaller scale or a smaller output width/height.',
    );
  }
}

/**
 * Prüft die Bildrate eines Profils.
 *
 * @example
 * ```ts
 * assertFps(60, 'video.render'); // ok
 * ```
 */
export function assertFps(fps: number, what: string): void {
  if (!Number.isFinite(fps) || fps <= 0 || fps > AGENT_LIMITS.maxFps) throw limitError(`${what}: fps ${String(fps)} is outside 0–${String(AGENT_LIMITS.maxFps)}.`, `Use at most ${String(AGENT_LIMITS.maxFps)} fps.`);
}

/**
 * Prüft die Zahl der Ausgabe-Frames eines Jobs.
 *
 * @example
 * ```ts
 * assertFrameCount(300, 'video.render'); // ok
 * ```
 */
export function assertFrameCount(frames: number, what: string): void {
  if (!Number.isFinite(frames) || frames > AGENT_LIMITS.maxFrames) {
    throw limitError(`${what}: ${String(frames)} output frames exceed the limit of ${String(AGENT_LIMITS.maxFrames)}.`, 'Render a shorter range (start/end) or split the video.');
  }
}
