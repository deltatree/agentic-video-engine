/**
 * Makro-Node `subtitles` (FR-56): wählt den aktiven Cue eines Untertitel-Tracks und
 * erzeugt eine `rich-text`-Node mit Wörtern als Spans.
 *
 * Zeitbezug: Cue-Zeiten gelten in der lokalen Zeit der `subtitles`-Node. Ohne `timing`
 * ist das die Zeit der Composition; mit `timing.from` verschiebt sich der ganze Track.
 *
 * Layout ohne Textmessung: Der Umbruch wird mit einer konservativen Zeichenbreite von
 * {@link CHAR_WIDTH_EM} × Schriftgröße geschätzt und als Zeilenumbruch in die Spans
 * geschrieben. So kennt der Expander die Zeilenzahl und kann die Box sicher innerhalb
 * der Safe Area platzieren. `width` bleibt gesetzt, damit der Renderer bei sehr breiten
 * Glyphen zusätzlich umbricht.
 */
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_LINE_HEIGHT,
  OpenVideoError,
  SubtitleTrack,
  conforms,
  evaluateAnimated,
  findComposition,
  isRecord,
  resolveMarkers,
  type Diagnostic,
  type ExpandContext,
  type IrNode,
  type NodeExpander,
  type NodeOf,
  type Registry,
  type SubtitleCue,
  type TimeValue,
} from '@agentic-video/core';
import { parseSubtitles } from './parse.js';
import { timeToSeconds } from './time.js';
import { estimateWordTimings } from './words.js';

/** Geschätzte mittlere Zeichenbreite als Anteil der Schriftgröße (bewusst großzügig). */
export const CHAR_WIDTH_EM = 0.6;
/** Standard-Rand der Safe Area als Anteil der Bildgröße. */
export const DEFAULT_SAFE_AREA = 0.05;
/** Standard-Farbe für hervorgehobene Wörter. */
export const DEFAULT_HIGHLIGHT_COLOR = '#FFD400';
/** Vergrößerung des aktuellen Worts im Stil `pop`. */
export const POP_SCALE = 1.25;

/** Optionen für {@link subtitlesExpander}. */
export interface SubtitlesExpanderOptions {
  /**
   * Liefert den Text einer Untertitel-Datei (Asset-ID → Inhalt). Muss synchron sein;
   * der Aufrufer lädt die Dateien vor dem Rendern.
   */
  readonly loadTrackText?: (assetId: string) => string | undefined;
  /** Empfängt Parser-Diagnosen, einmal je geladenem Asset-Text. */
  readonly onDiagnostic?: (diagnostic: Diagnostic) => void;
}

interface Word {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** Harter Umbruch vor dem Wort (aus dem Cue-Text). */
  readonly breakBefore: boolean;
}

function subtitleError(code: string, problem: string, nodeId: string, suggestions: readonly string[]): OpenVideoError {
  return new OpenVideoError({ code, errorClass: 'SubtitleError', problem, nodeId, suggestions });
}

function themeRef(theme: unknown, ref: string): unknown {
  const parts = ref.split('.');
  if (parts[0] !== 'theme') return undefined;
  let value: unknown = theme;
  for (const p of parts.slice(1)) value = isRecord(value) ? value[p] : undefined;
  return value;
}

function markerList(comp: Readonly<Record<string, unknown>>): { id: string; time: TimeValue }[] {
  const raw = comp['markers'];
  if (!Array.isArray(raw)) return [];
  const out: { id: string; time: TimeValue }[] = [];
  for (const m of raw) {
    if (isRecord(m) && typeof m['id'] === 'string' && (typeof m['time'] === 'string' || typeof m['time'] === 'number')) out.push({ id: m['id'], time: m['time'] });
  }
  return out;
}

/** Ordnet Wortzeiten dem Cue-Text zu und merkt harte Umbrüche. */
function wordsOf(cue: SubtitleCue, fps: number, markers: ReadonlyMap<string, number>): Word[] {
  const withWords = estimateWordTimings(cue, fps);
  let cursor = 0;
  return (withWords.words ?? []).map((w) => {
    const at = cue.text.indexOf(w.text, cursor);
    const breakBefore = at > cursor && cue.text.slice(cursor, at).includes('\n');
    if (at >= 0) cursor = at + w.text.length;
    return { text: w.text, start: timeToSeconds(w.start, fps, markers), end: timeToSeconds(w.end, fps, markers), breakBefore };
  });
}

/** Greedy-Umbruch mit geschätzter Zeichenbreite; liefert je Wort, ob davor eine neue Zeile beginnt. */
function lineBreaks(words: readonly Word[], maxWidth: number, charWidth: number): { breaks: boolean[]; lines: number } {
  const breaks: boolean[] = [];
  let lineWidth = 0;
  let lines = words.length > 0 ? 1 : 0;
  for (const [i, w] of words.entries()) {
    const width = Array.from(w.text).length * charWidth;
    const newLine = i > 0 && (w.breakBefore || lineWidth + charWidth + width > maxWidth);
    if (newLine) {
      lines++;
      lineWidth = width;
    } else lineWidth += (i > 0 ? charWidth : 0) + width;
    breaks.push(newLine);
  }
  return { breaks, lines };
}

/**
 * Erzeugt den Expander für Nodes vom Typ `subtitles`.
 *
 * Stile: `plain`, `word-highlight` (aktuelles Wort in `highlightColor`), `karaoke`
 * (gesungene Wörter in `highlightColor`), `pop` (aktuelles Wort größer und hervorgehoben),
 * `fade` (Cue blendet ein und aus), `typewriter` (Wörter erscheinen zu ihrer Startzeit).
 *
 * @example
 * ```ts
 * const registry = new Registry();
 * registry.registerExpander(subtitlesExpander({ loadTrackText: (id) => preloaded.get(id) }));
 * ```
 */
export function subtitlesExpander(options: SubtitlesExpanderOptions = {}): NodeExpander {
  const parsed = new Map<string, { readonly text: string; readonly cues: readonly SubtitleCue[] }>();

  const cuesOf = (track: SubtitleTrack, nodeId: string): readonly SubtitleCue[] => {
    if (track.cues !== undefined) return track.cues;
    if (track.asset !== undefined) {
      const text = options.loadTrackText?.(track.asset);
      if (text === undefined) {
        throw subtitleError('OV_SUBTITLE_ASSET_TEXT', `The text of subtitle asset "${track.asset}" is not loaded.`, nodeId, [
          'Pass loadTrackText to subtitlesExpander() and preload the subtitle file before rendering.',
          'Or put the cues inline: tracks[].cues.',
        ]);
      }
      const hit = parsed.get(track.asset);
      if (hit !== undefined && hit.text === text) return hit.cues;
      const result = parseSubtitles(text);
      for (const d of result.diagnostics) options.onDiagnostic?.(d);
      parsed.set(track.asset, { text, cues: result.cues });
      return result.cues;
    }
    throw subtitleError('OV_SUBTITLE_NO_CUES', `Subtitle track "${track.id}" has no cues yet.`, nodeId, [
      'Run transcribe() from @agentic-video/speech and store the result in tracks[].cues.',
      'Or reference a subtitle file with tracks[].asset.',
    ]);
  };

  return {
    type: 'subtitles',
    expand(node: Readonly<Record<string, unknown>>, ctx: ExpandContext): IrNode[] {
      const nodeId = ctx.id;
      const comp = findComposition(ctx.project, ctx.compositionId);
      const trackId = node['track'];
      const tracks: unknown[] = Array.isArray(comp['tracks']) ? comp['tracks'] : [];
      const track = tracks.find((t): t is SubtitleTrack => conforms(SubtitleTrack, t) && t.id === trackId);
      if (track === undefined) {
        throw subtitleError('OV_SUBTITLE_TRACK', `Subtitle track "${String(trackId)}" does not exist in composition "${ctx.compositionId}".`, nodeId, [
          `Add { id: "${String(trackId)}", kind: "subtitle", cues: [...] } to composition.tracks.`,
          'Check the "track" property of the subtitles node.',
        ]);
      }

      const fps = ctx.fps;
      const markers = resolveMarkers(markerList(comp), fps);
      const t = ctx.frame / fps;
      let cue: SubtitleCue | undefined;
      let cueIndex = -1;
      let cueStart = -Infinity;
      for (const [i, c] of cuesOf(track, nodeId).entries()) {
        const s = timeToSeconds(c.start, fps, markers);
        const e = timeToSeconds(c.end, fps, markers);
        if (s <= t && t < e && s >= cueStart) {
          cue = c;
          cueIndex = i;
          cueStart = s;
        }
      }
      if (cue === undefined) return [];
      const cueEnd = timeToSeconds(cue.end, fps, markers);

      const actx = { frame: ctx.frame, fps, seed: ctx.seed, durationFrames: ctx.durationFrames, resolveRef: (ref: string) => themeRef(ctx.theme, ref) };
      const value = (key: string): unknown => evaluateAnimated(node[key], actx);
      const num = (key: string, fallback: number): number => {
        const v = value(key);
        return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
      };
      const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

      const speakerStyles = value('speakerStyles');
      const rawSpeaker = cue.speaker !== undefined && isRecord(speakerStyles) ? speakerStyles[cue.speaker] : undefined;
      const speaker = isRecord(rawSpeaker) ? rawSpeaker : {};
      const W = ctx.compositionWidth;
      const H = ctx.compositionHeight;
      const safe = Math.min(Math.max(num('safeArea', DEFAULT_SAFE_AREA), 0), 0.5);
      const fontSize = num('fontSize', DEFAULT_FONT_SIZE);
      const fontWeight = value('fontWeight');
      const color = str(speaker['color']) ?? str(value('color')) ?? '#FFFFFF';
      const highlight = str(value('highlightColor')) ?? DEFAULT_HIGHLIGHT_COLOR;
      const fontFamily = str(speaker['fontFamily']) ?? str(value('fontFamily'));
      const stroke = str(value('stroke'));
      const strokeWidth = value('strokeWidth');

      const box = value('box');
      const boxRecord = isRecord(box) ? box : undefined;
      const boxColor = str(speaker['box']) ?? str(boxRecord?.['color']);
      const pad = (key: string, factor: number): number => {
        const v = boxRecord?.[key];
        return boxColor === undefined ? 0 : typeof v === 'number' ? v : Math.round(fontSize * factor);
      };
      const padX = pad('paddingX', 0.25);
      const padY = pad('paddingY', 0.1);
      const radius = boxRecord?.['radius'];

      const safeWidth = W * (1 - 2 * safe) - 2 * padX;
      const width = Math.max(fontSize, Math.min(num('maxWidth', W * 0.8), safeWidth));
      const words = wordsOf(cue, fps, markers);
      if (words.length === 0) return [];
      const { breaks, lines } = lineBreaks(words, width, CHAR_WIDTH_EM * fontSize);
      const height = lines * fontSize * DEFAULT_LINE_HEIGHT;

      const position = str(value('position')) ?? 'bottom';
      const x = position === 'custom' ? 0 : (W - width) / 2;
      let y = H * (1 - safe) - padY - height;
      if (position === 'top') y = H * safe + padY;
      else if (position === 'center') y = (H - height) / 2;
      else if (position === 'custom') y = 0;

      const style = str(value('style')) ?? 'plain';
      let current = -1;
      for (const [i, w] of words.entries()) if (w.start <= t) current = i;
      const visible = style === 'typewriter' ? words.filter((w) => w.start <= t).length : words.length;
      if (visible === 0) return [];

      const spans: NodeOf<'rich-text'>['spans'] = [];
      for (let i = 0; i < visible; i++) {
        const w = words[i];
        if (w === undefined) continue;
        const separator = i === visible - 1 ? '' : breaks[i + 1] === true ? '\n' : ' ';
        const lit = (style === 'word-highlight' && i === current) || (style === 'karaoke' && i <= current) || (style === 'pop' && i === current);
        spans.push({
          text: w.text + separator,
          fill: lit ? highlight : color,
          ...(style === 'pop' && i === current ? { fontSize: fontSize * POP_SCALE } : {}),
        });
      }

      let opacity: number | undefined;
      if (style === 'fade') {
        const f = Math.min(0.25, (cueEnd - cueStart) / 4);
        opacity = f <= 0 ? 1 : Math.min(Math.max(Math.min((t - cueStart) / f, (cueEnd - t) / f), 0), 1);
      }

      const out: NodeOf<'rich-text'> = {
        id: `cue-${cueIndex}`,
        type: 'rich-text',
        x,
        y,
        width,
        textAlign: 'center',
        fontSize,
        lineHeight: DEFAULT_LINE_HEIGHT,
        fill: color,
        spans,
        ...(fontFamily !== undefined ? { fontFamily } : {}),
        ...(typeof fontWeight === 'number' ? { fontWeight } : {}),
        ...(stroke !== undefined ? { stroke } : {}),
        ...(typeof strokeWidth === 'number' ? { strokeWidth } : {}),
        ...(opacity !== undefined ? { opacity } : {}),
        ...(boxColor !== undefined
          ? { background: { color: boxColor, paddingX: padX, paddingY: padY, perLine: true, ...(typeof radius === 'number' ? { radius } : {}) } }
          : {}),
      };
      return [out];
    },
  };
}

/**
 * Registriert den `subtitles`-Expander in einem Register.
 *
 * @example
 * ```ts
 * registerSubtitles(registry, { loadTrackText: (id) => texts.get(id) });
 * ```
 */
export function registerSubtitles(registry: Registry, options: SubtitlesExpanderOptions = {}): void {
  registry.registerExpander(subtitlesExpander(options));
}
