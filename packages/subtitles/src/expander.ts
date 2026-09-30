/**
 * Makro-Node `subtitles` (FR-56): wählt den aktiven Cue eines Untertitel-Tracks und
 * erzeugt eine `rich-text`-Node mit Wörtern als Spans.
 *
 * Zeitbezug: Cue-Zeiten gelten in der lokalen Zeit der `subtitles`-Node. Ohne `timing`
 * ist das die Zeit der Composition; mit `timing.from` verschiebt sich der ganze Track.
 *
 * Umbruch (Story 17.8): Mit `measureText` (Textmesser des Renderers) bricht der Expander an der
 * echten Textbreite um und kennt die Position jedes Worts (für Karaoke-Fill). Ohne Messer schätzt
 * er konservativ {@link CHAR_WIDTH_EM} × Schriftgröße je Zeichen. Die Umbrüche stehen als `\n` in
 * den Spans, damit Zeilenzahl und Safe Area feststehen; `width` bleibt gesetzt.
 *
 * Quellen der Cues: `tracks[].cues`, eine Untertitel-Datei (`tracks[].asset`, ASS mit Stilen)
 * oder eine Transkription (`tracks[].fromAudio`, vor dem Render über `transcript` geliefert).
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
import { parseSubtitles, type AssStyle, type CueInfo } from './parse.js';
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

/** Schriftstil für {@link SubtitlesExpanderOptions.measureText}. */
export interface SubtitleTextStyle {
  readonly fontSize: number;
  readonly fontFamily?: string;
  readonly fontWeight?: number;
  readonly fontStyle?: 'normal' | 'italic';
}

/** Ergebnis einer Transkription für einen Track mit `fromAudio`. */
export type SubtitleTranscript = { readonly cues: readonly SubtitleCue[] } | { readonly error: Diagnostic };

/** Optionen für {@link subtitlesExpander}. */
export interface SubtitlesExpanderOptions {
  /**
   * Liefert den Text einer Untertitel-Datei (Asset-ID → Inhalt). Muss synchron sein;
   * der Aufrufer lädt die Dateien vor dem Rendern.
   */
  readonly loadTrackText?: (assetId: string) => string | undefined;
  /** Empfängt Parser-Diagnosen, einmal je geladenem Asset-Text. */
  readonly onDiagnostic?: (diagnostic: Diagnostic) => void;
  /**
   * Misst die Breite eines einzeiligen Textes in Pixeln (z. B. über den `TextMeasurer` des
   * Renderers). Ohne Messer wird die Breite mit {@link CHAR_WIDTH_EM} geschätzt.
   */
  readonly measureText?: (text: string, style: SubtitleTextStyle) => number;
  /**
   * Transkript eines Tracks mit `fromAudio` (vor dem Render aufgelöst, z. B. über
   * `resolveFromAudioTracks` aus `@agentic-video/speech`). Muss synchron sein.
   */
  readonly transcript?: (compositionId: string, trackId: string) => SubtitleTranscript | undefined;
}

/** Cues eines Tracks mit ASS-Zusatzangaben. */
interface TrackCues {
  readonly cues: readonly SubtitleCue[];
  readonly info?: readonly CueInfo[];
  readonly styles?: readonly AssStyle[];
  readonly playRes?: { readonly x?: number; readonly y?: number };
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

/** Greedy-Umbruch; liefert je Wort, ob davor eine neue Zeile beginnt. `measure` misst eine Zeile. */
function lineBreaks(words: readonly Word[], maxWidth: number, measure: (text: string) => number): { breaks: boolean[]; lines: number } {
  const breaks: boolean[] = [];
  let line = '';
  let lines = words.length > 0 ? 1 : 0;
  for (const [i, w] of words.entries()) {
    const candidate = line === '' ? w.text : `${line} ${w.text}`;
    const newLine = i > 0 && (w.breakBefore || measure(candidate) > maxWidth);
    if (newLine) {
      lines++;
      line = w.text;
    } else line = candidate;
    breaks.push(newLine);
  }
  return { breaks, lines };
}

/** Zeile und horizontale Lage eines Worts (für Karaoke-Fill). */
function wordPlacement(words: readonly Word[], breaks: readonly boolean[], index: number, width: number, align: 'left' | 'center' | 'right', measure: (text: string) => number): { x: number; width: number } {
  let start = index;
  while (start > 0 && breaks[start] !== true) start--;
  let end = index;
  while (end + 1 < words.length && breaks[end + 1] !== true) end++;
  const lineText = words.slice(start, end + 1).map((w) => w.text).join(' ');
  const lineWidth = measure(lineText);
  const offset = align === 'center' ? (width - lineWidth) / 2 : align === 'right' ? width - lineWidth : 0;
  const word = words[index]?.text ?? '';
  const prefix = words.slice(start, index).map((w) => w.text).join(' ');
  const wordWidth = measure(word);
  // Breite vor dem Wort über die Differenz, damit Leerzeichen und Kerning mitzählen.
  const before = prefix === '' ? 0 : measure(`${prefix} ${word}`) - wordWidth;
  return { x: offset + before, width: wordWidth };
}

/** ASS-Ausrichtung (Numpad 1..9) → vertikale Lage und Textausrichtung. */
function assAlignment(alignment: number | undefined): { position: 'bottom' | 'center' | 'top'; align: 'left' | 'center' | 'right' } {
  const a = alignment ?? 2;
  const position = a >= 7 ? 'top' : a >= 4 ? 'center' : 'bottom';
  const column = (a - 1) % 3;
  return { position, align: column === 0 ? 'left' : column === 2 ? 'right' : 'center' };
}

/**
 * Erzeugt den Expander für Nodes vom Typ `subtitles`.
 *
 * Stile: `plain`, `word-highlight` (aktuelles Wort in `highlightColor`), `karaoke`
 * (gesungene Wörter in `highlightColor`, das laufende Wort füllt sich von links wie ASS `\kf`),
 * `pop` (aktuelles Wort größer und hervorgehoben), `fade` (Cue blendet ein und aus),
 * `typewriter` (Wörter erscheinen zu ihrer Startzeit). `textAnimation` animiert jedes Wort ab
 * seiner Startzeit.
 *
 * ASS-Stile (Schrift, Größe, Farbe, Fett/Kursiv, Ausrichtung, Ränder, Kontur, `BorderStyle` 3 als
 * Box) gelten für Cues aus ASS-Dateien, soweit die Node oder `speakerStyles` nichts anderes setzen.
 * Größen und Ränder werden von `PlayResX`/`PlayResY` auf die Composition skaliert.
 *
 * @example
 * ```ts
 * const registry = new Registry();
 * registry.registerExpander(subtitlesExpander({ loadTrackText: (id) => preloaded.get(id) }));
 * ```
 */
export function subtitlesExpander(options: SubtitlesExpanderOptions = {}): NodeExpander {
  const parsed = new Map<string, { readonly text: string; readonly result: TrackCues }>();
  const widths = new Map<string, number>();

  const cuesOf = (track: SubtitleTrack, nodeId: string, compositionId: string): TrackCues => {
    if (track.cues !== undefined) return { cues: track.cues };
    if (track.asset !== undefined) {
      const text = options.loadTrackText?.(track.asset);
      if (text === undefined) {
        throw subtitleError('OV_SUBTITLE_ASSET_TEXT', `The text of subtitle asset "${track.asset}" is not loaded.`, nodeId, [
          'Pass loadTrackText to subtitlesExpander() and preload the subtitle file before rendering.',
          'Or put the cues inline: tracks[].cues.',
        ]);
      }
      const hit = parsed.get(track.asset);
      if (hit !== undefined && hit.text === text) return hit.result;
      const result = parseSubtitles(text);
      for (const d of result.diagnostics) options.onDiagnostic?.(d);
      const cues: TrackCues = { cues: result.cues, info: result.info, styles: result.styles, ...(result.playRes !== undefined ? { playRes: result.playRes } : {}) };
      parsed.set(track.asset, { text, result: cues });
      return cues;
    }
    if (track.fromAudio !== undefined) {
      const transcript = options.transcript?.(compositionId, track.id);
      if (transcript !== undefined && 'cues' in transcript) return { cues: transcript.cues };
      if (transcript !== undefined) throw new OpenVideoError({ ...transcript.error, nodeId });
      throw subtitleError('OV_SUBTITLE_NO_CUES', `Subtitle track "${track.id}" has fromAudio, but it was not transcribed before rendering.`, nodeId, [
        'Render through createNodeEnvironment() from @agentic-video/render; it transcribes fromAudio tracks with the ASR provider first.',
        'Or run the operation subtitles.transcribe to store the cues in tracks[].cues.',
      ]);
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
      const source = cuesOf(track, nodeId, ctx.compositionId);
      let cue: SubtitleCue | undefined;
      let cueIndex = -1;
      let cueStart = -Infinity;
      for (const [i, c] of source.cues.entries()) {
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
      const explicit = (key: string): boolean => node[key] !== undefined;
      const num = (key: string, fallback: number): number => {
        const v = value(key);
        return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
      };
      const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

      // ASS-Stil des Cues (Story 17.8): Vorgabe für alles, was die Node nicht selbst setzt.
      const styleName = source.info?.[cueIndex]?.style;
      const ass = source.styles === undefined ? undefined : (source.styles.find((st) => st.name === styleName) ?? source.styles.find((st) => st.name.toLowerCase() === 'default'));
      const W = ctx.compositionWidth;
      const H = ctx.compositionHeight;
      // Skript-Pixel → Composition-Pixel (libass-Standard 384 × 288, wenn nichts gesetzt ist).
      const playY = source.playRes?.y ?? (source.playRes?.x !== undefined ? (source.playRes.x * 3) / 4 : 288);
      const playX = source.playRes?.x ?? (playY * 4) / 3;
      const ky = H / playY;
      const kx = W / playX;

      const speakerStyles = value('speakerStyles');
      const rawSpeaker = cue.speaker !== undefined && isRecord(speakerStyles) ? speakerStyles[cue.speaker] : undefined;
      const speaker = isRecord(rawSpeaker) ? rawSpeaker : {};
      const safe = Math.min(Math.max(num('safeArea', DEFAULT_SAFE_AREA), 0), 0.5);
      const fontSize = explicit('fontSize') ? num('fontSize', DEFAULT_FONT_SIZE) : ass?.fontSize !== undefined ? ass.fontSize * ky : DEFAULT_FONT_SIZE;
      const weightValue = value('fontWeight');
      const fontWeight = typeof weightValue === 'number' ? weightValue : ass?.bold === true ? 700 : undefined;
      const fontStyle = ass?.italic === true ? 'italic' : undefined;
      const color = str(speaker['color']) ?? str(value('color')) ?? ass?.color ?? '#FFFFFF';
      const highlight = str(value('highlightColor')) ?? DEFAULT_HIGHLIGHT_COLOR;
      const fontFamily = str(speaker['fontFamily']) ?? str(value('fontFamily')) ?? ass?.fontFamily;
      const assOutline = ass !== undefined && ass.borderStyle !== 3 && (ass.outline ?? 0) > 0 && ass.outlineColor !== undefined;
      const stroke = str(value('stroke')) ?? (assOutline ? ass.outlineColor : undefined);
      const strokeValue = value('strokeWidth');
      const strokeWidth = typeof strokeValue === 'number' ? strokeValue : assOutline ? (ass.outline ?? 0) * ky : undefined;

      const box = value('box');
      const boxRecord = isRecord(box) ? box : undefined;
      const boxColor = str(speaker['box']) ?? str(boxRecord?.['color']) ?? (ass?.borderStyle === 3 ? ass.backColor : undefined);
      const pad = (key: string, factor: number): number => {
        const v = boxRecord?.[key];
        return boxColor === undefined ? 0 : typeof v === 'number' ? v : Math.round(fontSize * factor);
      };
      const padX = pad('paddingX', 0.25);
      const padY = pad('paddingY', 0.1);
      const radius = boxRecord?.['radius'];

      // Ränder: Safe Area, bei ASS-Stilen ohne eigene safeArea die Ränder des Stils.
      const useAssMargins = ass !== undefined && !explicit('safeArea');
      const marginLeft = useAssMargins ? (ass.marginL ?? 0) * kx : W * safe;
      const marginRight = useAssMargins ? (ass.marginR ?? 0) * kx : W * safe;
      const marginV = useAssMargins ? (ass.marginV ?? 0) * ky : H * safe;
      const available = W - marginLeft - marginRight - 2 * padX;
      const width = Math.max(fontSize, explicit('maxWidth') ? Math.min(num('maxWidth', W * 0.8), available) : Math.min(useAssMargins ? available : W * 0.8, available));
      const words = wordsOf(cue, fps, markers);
      if (words.length === 0) return [];
      const textStyle: SubtitleTextStyle = { fontSize, ...(fontFamily !== undefined ? { fontFamily } : {}), ...(fontWeight !== undefined ? { fontWeight } : {}), ...(fontStyle !== undefined ? { fontStyle } : {}) };
      const measureText = options.measureText;
      const measure = (text: string): number => {
        if (measureText === undefined) return Array.from(text).length * CHAR_WIDTH_EM * fontSize;
        const key = `${JSON.stringify(textStyle)}|${text}`;
        let w = widths.get(key);
        if (w === undefined) {
          w = measureText(text, textStyle);
          if (widths.size > 4096) widths.clear();
          widths.set(key, w);
        }
        return w;
      };
      const { breaks, lines } = lineBreaks(words, width, measure);
      const height = lines * fontSize * DEFAULT_LINE_HEIGHT;

      const assPlace = assAlignment(ass?.alignment);
      const position = str(value('position')) ?? (ass !== undefined ? assPlace.position : 'bottom');
      const align = explicit('position') || ass === undefined ? 'center' : assPlace.align;
      let x = position === 'custom' ? 0 : (W - width) / 2;
      if (position !== 'custom' && align === 'left') x = marginLeft + padX;
      else if (position !== 'custom' && align === 'right') x = W - marginRight - padX - width;
      let y = H - marginV - padY - height;
      if (position === 'top') y = marginV + padY;
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
        // Karaoke: gesungene Wörter ganz, das laufende Wort anteilig (wie ASS \kf).
        const singing = style === 'karaoke' && i === current && t < w.end && w.end > w.start;
        if (singing) {
          const progress = Math.min(Math.max((t - w.start) / (w.end - w.start), 0), 1);
          if (measureText !== undefined) {
            const place = wordPlacement(words, breaks, i, width, align, measure);
            const fillX = padX + place.x + progress * place.width;
            spans.push({
              text: w.text + separator,
              fill: { type: 'linear', units: 'pixels', start: { x: fillX - 0.5, y: 0 }, end: { x: fillX + 0.5, y: 0 }, stops: [{ offset: 0, color: highlight }, { offset: 1, color }] },
            });
          } else {
            const graphemes = Array.from(new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(w.text), (g) => g.segment);
            const lit = Math.round(progress * graphemes.length);
            if (lit > 0) spans.push({ text: graphemes.slice(0, lit).join(''), fill: highlight });
            spans.push({ text: graphemes.slice(lit).join('') + separator, fill: color });
          }
          continue;
        }
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

      // textAnimation je Wort: jede Einheit beginnt zur Startzeit ihres Worts (Story 17.8).
      const anim = value('textAnimation');
      const textAnimation = isRecord(anim) && isRecord(anim['from'])
        ? { ...anim, unit: 'word' as const, starts: words.slice(0, visible).map((w) => w.start * fps), from: anim['from'] }
        : undefined;

      const out: NodeOf<'rich-text'> = {
        id: `cue-${cueIndex}`,
        type: 'rich-text',
        x,
        y,
        width,
        textAlign: align,
        fontSize,
        lineHeight: DEFAULT_LINE_HEIGHT,
        fill: color,
        spans,
        ...(fontFamily !== undefined ? { fontFamily } : {}),
        ...(fontWeight !== undefined ? { fontWeight } : {}),
        ...(fontStyle !== undefined ? { fontStyle } : {}),
        ...(stroke !== undefined ? { stroke } : {}),
        ...(strokeWidth !== undefined ? { strokeWidth } : {}),
        ...(opacity !== undefined ? { opacity } : {}),
        ...(textAnimation !== undefined ? { textAnimation } : {}),
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
