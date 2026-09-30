/**
 * Oberste Struktur der Composition IR (FR-1):
 * Project → metadata, settings, compositions[], assets[], fonts[], audio[], renderProfiles[].
 */
import Type, { type Static } from 'typebox';
import { NODE_ARRAY_MARK } from './nodes.js';
import { ANumber, Color, ColorSpace, Easing, Id, TimeValue } from './primitives.js';
import { SCHEMA_VERSION_PATTERN } from './version.js';

// ---------------------------------------------------------------------------
// Theme (FR-83)
// ---------------------------------------------------------------------------

const TokenName = Type.String({ pattern: '^[A-Za-z0-9_-]+$' });

export const ThemeShadow = Type.Object(
  { color: Color, blur: Type.Number({ minimum: 0 }), offsetX: Type.Number(), offsetY: Type.Number() },
  { additionalProperties: false },
);

/** Design-Tokens. Werte werden per `{"$ref": "theme.<gruppe>.<name>"}` referenziert. */
export const Theme = Type.Object(
  {
    colors: Type.Optional(Type.Record(TokenName, Color)),
    fonts: Type.Optional(Type.Record(TokenName, Type.String({ minLength: 1 }))),
    fontSizes: Type.Optional(Type.Record(TokenName, Type.Number({ minimum: 0 }))),
    spacing: Type.Optional(Type.Record(TokenName, Type.Number())),
    radii: Type.Optional(Type.Record(TokenName, Type.Number({ minimum: 0 }))),
    shadows: Type.Optional(Type.Record(TokenName, ThemeShadow)),
    motion: Type.Optional(Type.Record(TokenName, TimeValue)),
    easing: Type.Optional(Type.Record(TokenName, Easing)),
  },
  { additionalProperties: false },
);
export type Theme = Static<typeof Theme>;

// ---------------------------------------------------------------------------
// Assets, Fonts, Audio-Quellen (FR-48, FR-49, FR-58)
// ---------------------------------------------------------------------------

export const ASSET_TYPES = ['image', 'video', 'audio', 'font', 'model', 'lottie', 'svg', 'subtitle', 'lut', 'hdri', 'html', 'data'] as const;
export const AssetType = Type.Enum(ASSET_TYPES);
export type AssetType = Static<typeof AssetType>;

export const HASH_PATTERN = '^sha256:[0-9a-f]{64}$';
export const Hash = Type.String({ pattern: HASH_PATTERN, description: 'Content hash "sha256:<64 hex>".' });

export const LicenseMetadata = Type.Object(
  {
    name: Type.String({ description: 'License name or SPDX id, e.g. "CC-BY-4.0".' }),
    url: Type.Optional(Type.String()),
    attribution: Type.Optional(Type.String()),
    source: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/** Asset-Eintrag in der IR. Pipeline-Felder (hash, metadata …) füllt `assets` aus. */
export const Asset = Type.Object(
  {
    id: Id,
    type: AssetType,
    src: Type.String({ minLength: 1, description: 'Path relative to the project root, or an http(s) URL fetched before rendering.' }),
    hash: Type.Optional(Hash),
    license: Type.Optional(LicenseMetadata),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type Asset = Static<typeof Asset>;

/** Schrift-Registrierung. */
export const Font = Type.Object(
  {
    family: Type.String({ minLength: 1 }),
    asset: Type.Optional(Id),
    src: Type.Optional(Type.String({ minLength: 1 })),
    weight: Type.Optional(Type.Union([Type.Number({ minimum: 1, maximum: 1000 }), Type.String({ pattern: '^[0-9]+ [0-9]+$', description: 'Variable range, e.g. "100 900".' })])),
    style: Type.Optional(Type.Union([Type.Literal('normal'), Type.Literal('italic')])),
    hash: Type.Optional(Hash),
    faceIndex: Type.Optional(Type.Integer({ minimum: 0, description: 'Face in a font collection (.ttc, .otc, WOFF2 collection). Default 0.' })),
  },
  { additionalProperties: false, description: 'Font file: .ttf, .otf, .ttc/.otc (with faceIndex), .woff or .woff2.' },
);
export type Font = Static<typeof Font>;

/** Audio-Quelle: Datei-Asset oder erzeugte Stimme (FR-58, FR-59). */
export const AudioSource = Type.Union([
  Type.Object({ id: Id, asset: Id }, { additionalProperties: false }),
  Type.Object(
    {
      id: Id,
      voice: Type.Object(
        {
          provider: Type.String({ minLength: 1, examples: ['piper'] }),
          voice: Type.Optional(Type.String()),
          text: Type.String({ minLength: 1 }),
          language: Type.Optional(Type.String()),
          rate: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
          options: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]))),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
]);
export type AudioSource = Static<typeof AudioSource>;

// ---------------------------------------------------------------------------
// Tracks und Marker (FR-14, FR-52..FR-56)
// ---------------------------------------------------------------------------

export const Marker = Type.Object(
  {
    id: Id,
    time: TimeValue,
    label: Type.Optional(Type.String()),
    kind: Type.Optional(Type.Union([Type.Literal('marker'), Type.Literal('event')])),
    data: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]))),
  },
  { additionalProperties: false },
);
export type Marker = Static<typeof Marker>;

export const EqBand = Type.Object(
  {
    type: Type.Union([Type.Literal('peak'), Type.Literal('lowshelf'), Type.Literal('highshelf'), Type.Literal('lowpass'), Type.Literal('highpass')]),
    frequency: Type.Number({ exclusiveMinimum: 0 }),
    gain: Type.Optional(Type.Number({ description: 'dB' })),
    q: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  },
  { additionalProperties: false },
);

export const Compressor = Type.Object(
  {
    threshold: Type.Number({ maximum: 0, description: 'dBFS' }),
    ratio: Type.Number({ minimum: 1 }),
    attack: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: 'ms' })),
    release: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: 'ms' })),
    makeup: Type.Optional(Type.Number({ description: 'dB' })),
  },
  { additionalProperties: false },
);

export const Limiter = Type.Object(
  { ceiling: Type.Number({ maximum: 0, description: 'dBFS' }), release: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: 'ms' })) },
  { additionalProperties: false },
);

export const AudioClip = Type.Object(
  {
    id: Id,
    source: Id,
    start: TimeValue,
    offset: Type.Optional(TimeValue),
    duration: Type.Optional(TimeValue),
    volume: Type.Optional(ANumber({ minimum: 0, description: 'Linear gain, 1 = unchanged.' })),
    pan: Type.Optional(ANumber({ minimum: -1, maximum: 1 })),
    fadeIn: Type.Optional(TimeValue),
    fadeOut: Type.Optional(TimeValue),
    loop: Type.Optional(Type.Boolean()),
    playbackRate: Type.Optional(Type.Number({ minimum: 0.25, maximum: 4 })),
  },
  { additionalProperties: false },
);
export type AudioClip = Static<typeof AudioClip>;

export const AudioTrack = Type.Object(
  {
    id: Id,
    kind: Type.Literal('audio'),
    role: Type.Optional(Type.Union([Type.Literal('voiceover'), Type.Literal('music'), Type.Literal('sfx'), Type.Literal('other')])),
    clips: Type.Array(AudioClip),
    volume: Type.Optional(ANumber({ minimum: 0 })),
    pan: Type.Optional(ANumber({ minimum: -1, maximum: 1 })),
    muted: Type.Optional(Type.Boolean()),
    eq: Type.Optional(Type.Array(EqBand)),
    compressor: Type.Optional(Compressor),
    limiter: Type.Optional(Limiter),
    crossfade: Type.Optional(TimeValue),
    ducking: Type.Optional(
      Type.Object(
        { by: Id, amount: Type.Number({ maximum: 0, description: 'dB reduction, e.g. -12.' }), attack: Type.Optional(Type.Number()), release: Type.Optional(Type.Number()) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type AudioTrack = Static<typeof AudioTrack>;

export const SubtitleWord = Type.Object({ text: Type.String(), start: TimeValue, end: TimeValue }, { additionalProperties: false });

export const SubtitleCue = Type.Object(
  {
    start: TimeValue,
    end: TimeValue,
    text: Type.String(),
    speaker: Type.Optional(Type.String()),
    words: Type.Optional(Type.Array(SubtitleWord)),
  },
  { additionalProperties: false },
);
export type SubtitleCue = Static<typeof SubtitleCue>;

export const SubtitleTrack = Type.Object(
  {
    id: Id,
    kind: Type.Literal('subtitle'),
    asset: Type.Optional(Id),
    cues: Type.Optional(Type.Array(SubtitleCue)),
    fromAudio: Type.Optional(Type.Object({ source: Id, provider: Type.String() }, { additionalProperties: false, description: 'Transcribe with an ASR provider.' })),
    language: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type SubtitleTrack = Static<typeof SubtitleTrack>;

export const Track = Type.Union([AudioTrack, SubtitleTrack]);
export type Track = Static<typeof Track>;

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export const Composition = Type.Object(
  {
    id: Id,
    name: Type.Optional(Type.String()),
    width: Type.Integer({ minimum: 1, maximum: 16384, examples: [1920] }),
    height: Type.Integer({ minimum: 1, maximum: 16384, examples: [1080] }),
    fps: Type.Number({ exclusiveMinimum: 0, maximum: 240, examples: [30] }),
    duration: TimeValue,
    background: Type.Optional(Color),
    colorSpace: Type.Optional(ColorSpace),
    seed: Type.Optional(Type.Integer()),
    safeArea: Type.Optional(
      Type.Object(
        { action: Type.Number({ minimum: 0, maximum: 0.5 }), title: Type.Number({ minimum: 0, maximum: 0.5 }) },
        { additionalProperties: false, description: 'Margins as fraction of size. Default action 0.035, title 0.05.' },
      ),
    ),
    tracks: Type.Optional(Type.Array(Track)),
    markers: Type.Optional(Type.Array(Marker)),
    nodes: Type.Array(Type.Unknown(), { [NODE_ARRAY_MARK]: true }),
    audio: Type.Optional(
      Type.Object(
        {
          sampleRate: Type.Optional(Type.Union([Type.Literal(44100), Type.Literal(48000)])),
          loudness: Type.Optional(Type.Number({ minimum: -70, maximum: -5, description: 'Integrated loudness target in LUFS.' })),
          limiter: Type.Optional(Limiter),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type Composition = Static<typeof Composition>;

// ---------------------------------------------------------------------------
// Render-Profile (FR-60..FR-62)
// ---------------------------------------------------------------------------

export const OUTPUT_FORMATS = ['mp4', 'mov', 'webm', 'gif', 'webp', 'png-sequence', 'jpeg-sequence', 'webp-sequence'] as const;
export const OutputFormat = Type.Enum(OUTPUT_FORMATS);
export type OutputFormat = Static<typeof OutputFormat>;

export const VIDEO_CODECS = ['h264', 'h265', 'vp9', 'av1', 'prores', 'prores-4444', 'ffv1', 'png', 'gif', 'webp'] as const;
export const VideoCodec = Type.Enum(VIDEO_CODECS);
export type VideoCodec = Static<typeof VideoCodec>;

/** Verweis auf einen Exporter oder Codec aus einem Plugin (Story 21.1). */
function PluginRef(description: string) {
  return Type.String({ pattern: '^plugin:[A-Za-z][A-Za-z0-9_.-]{0,63}$', description });
}

export const RenderProfile = Type.Object(
  {
    id: Id,
    format: Type.Union([OutputFormat, PluginRef('Exporter from a plugin (settings.plugins), e.g. "plugin:hello-frames".')]),
    codec: Type.Optional(Type.Union([VideoCodec, PluginRef('Codec from a plugin (settings.plugins), e.g. "plugin:x264-film".')])),
    width: Type.Optional(Type.Integer({ minimum: 1, maximum: 16384 })),
    height: Type.Optional(Type.Integer({ minimum: 1, maximum: 16384 })),
    fps: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 240 })),
    quality: Type.Optional(Type.Integer({ minimum: 0, maximum: 100, description: '100 = best.' })),
    alpha: Type.Optional(Type.Boolean()),
    colorSpace: Type.Optional(ColorSpace),
    audioCodec: Type.Optional(Type.Union([Type.Literal('aac'), Type.Literal('opus'), Type.Literal('pcm'), Type.Literal('none')])),
    audioBitrate: Type.Optional(Type.Integer({ minimum: 32, maximum: 512, description: 'kbit/s' })),
    hardwareAcceleration: Type.Optional(
      Type.Union([Type.Literal('auto'), Type.Literal('none'), Type.Literal('nvenc'), Type.Literal('vaapi'), Type.Literal('videotoolbox'), Type.Literal('qsv')]),
    ),
  },
  { additionalProperties: false },
);
export type RenderProfile = Static<typeof RenderProfile>;

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export const Settings = Type.Object(
  {
    seed: Type.Optional(Type.Integer()),
    theme: Type.Optional(Theme),
    defaultFont: Type.Optional(Type.String()),
    renderer2d: Type.Optional(Type.Union([Type.Literal('skia'), Type.Literal('pixi')])),
    workingColorSpace: Type.Optional(ColorSpace),
    outputColorSpace: Type.Optional(ColorSpace),
    plugins: Type.Optional(
      Type.Array(Type.String({ minLength: 1 }), {
        description: 'Plugin modules: "./plugins/x.mjs" (inside the project) or an npm package name. Loaded only when the host allows plugins (--trusted or OPENVIDEO_ALLOW_PLUGINS=1); permissions via OPENVIDEO_PLUGIN_PERMISSIONS.',
      }),
    ),
  },
  { additionalProperties: false },
);
export type Settings = Static<typeof Settings>;

export const Metadata = Type.Object(
  {
    title: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    author: Type.Optional(Type.String()),
    tags: Type.Optional(Type.Array(Type.String())),
    createdWith: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type Metadata = Static<typeof Metadata>;

export const Project = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    schemaVersion: Type.String({ pattern: SCHEMA_VERSION_PATTERN, examples: ['1.0.0'] }),
    metadata: Type.Optional(Metadata),
    settings: Type.Optional(Settings),
    compositions: Type.Array(Composition, { minItems: 1 }),
    assets: Type.Optional(Type.Array(Asset)),
    fonts: Type.Optional(Type.Array(Font)),
    audio: Type.Optional(Type.Array(AudioSource)),
    renderProfiles: Type.Optional(Type.Array(RenderProfile)),
  },
  { additionalProperties: false },
);
