/**
 * Node-Typen der Composition IR.
 *
 * Properties liegen flach auf der Node (z. B. `nodes.logo.scale.x`).
 * Positionen folgen CSS: `x`/`y` ist die linke obere Ecke der Box; Rotation und
 * Skalierung wirken um `origin` (relativ zur Box, Standard Mitte). Winkel in Grad (AD-4).
 */
import Type, { type Static, type TObject, type TProperties } from 'typebox';
import {
  ABoolean,
  AColor,
  ANumber,
  AString,
  AVec2,
  AVec3,
  BlendMode,
  Color,
  ColorSpace,
  Easing,
  Filter,
  Id,
  Paint,
  Point,
  Shadow,
  TimeValue,
  Vec3,
  animatable,
  animatableDiscrete,
} from './primitives.js';

/** Markierung: Feld enthält eine einzelne Node (rekursiv). */
export const NODE_MARK = 'x-node';
/** Markierung: Feld enthält ein Array von Nodes (rekursiv). */
export const NODE_ARRAY_MARK = 'x-node-array';

/** Platzhalter-Schema für eine eingebettete Node; der Validator steigt hier rekursiv ab. */
const NodeSlot = Type.Unknown({ [NODE_MARK]: true, description: 'An embedded node.' });
/** Platzhalter-Schema für Kinder; der Validator steigt hier rekursiv ab. */
const NodeList = Type.Array(Type.Unknown(), { [NODE_ARRAY_MARK]: true, description: 'Child nodes.' });

// ---------------------------------------------------------------------------
// Gemeinsame Bausteine
// ---------------------------------------------------------------------------

/** Zeitliche Einbettung einer Node in die Zeit ihres Elternteils (FR-13, FR-16). */
export const Timing = Type.Object(
  {
    from: Type.Optional(TimeValue),
    duration: Type.Optional(TimeValue),
    speed: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: 'Time stretch factor. 2 = twice as fast.' })),
    reverse: Type.Optional(Type.Boolean()),
    loop: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Literal('infinite')], { description: 'Repeat the local range of `loopDuration`.' })),
    loopDuration: Type.Optional(TimeValue),
    pingPong: Type.Optional(Type.Boolean()),
    remap: Type.Optional(ANumber({ description: 'Local time in seconds as a function of the node time (time remapping).' })),
    hold: Type.Optional(TimeValue),
  },
  { additionalProperties: false, description: 'Where the node lives on its parent timeline.' },
);
export type Timing = Static<typeof Timing>;

/** Arten von Übergängen (FR-15). */
export const TRANSITION_TYPES = ['fade', 'slide-left', 'slide-right', 'slide-up', 'slide-down', 'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down', 'zoom-in', 'zoom-out', 'blur', 'iris'] as const;
export const TransitionType = Type.Enum(TRANSITION_TYPES);

/** Ein- oder Ausblendung am Rand des Zeitfensters einer Node. */
export const TransitionSpec = Type.Object(
  { type: TransitionType, duration: TimeValue, ease: Type.Optional(Easing) },
  { additionalProperties: false },
);

export const Transition = Type.Object(
  { in: Type.Optional(TransitionSpec), out: Type.Optional(TransitionSpec) },
  { additionalProperties: false },
);
export type Transition = Static<typeof Transition>;

/** Effekte, die der Compositor auf einen ganzen Layer anwendet (FR-46). */
export const LayerEffect = Type.Union([
  Type.Object({ type: Type.Literal('blur'), radius: ANumber({ minimum: 0 }) }, { additionalProperties: false }),
  Type.Object(
    {
      type: Type.Literal('color-grade'),
      exposure: Type.Optional(ANumber({ description: 'Stops.' })),
      contrast: Type.Optional(ANumber({ minimum: 0 })),
      saturation: Type.Optional(ANumber({ minimum: 0 })),
      temperature: Type.Optional(ANumber({ minimum: -1, maximum: 1 })),
      tint: Type.Optional(ANumber({ minimum: -1, maximum: 1 })),
      lift: Type.Optional(ANumber()),
      gamma: Type.Optional(ANumber({ minimum: 0.01 })),
      gain: Type.Optional(ANumber({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
  Type.Object({ type: Type.Literal('lut'), asset: Id, intensity: Type.Optional(ANumber({ minimum: 0, maximum: 1 })) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('glow'), radius: ANumber({ minimum: 0 }), intensity: ANumber({ minimum: 0 }), threshold: Type.Optional(ANumber({ minimum: 0, maximum: 1 })) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('vignette'), amount: ANumber({ minimum: 0, maximum: 1 }), softness: Type.Optional(ANumber({ minimum: 0, maximum: 1 })) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('grain'), amount: ANumber({ minimum: 0, maximum: 1 }), seed: Type.Optional(Type.Integer()) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('chromatic-aberration'), amount: ANumber({ minimum: 0 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('color-matrix'), matrix: Type.Array(Type.Number(), { minItems: 20, maxItems: 20 }) }, { additionalProperties: false }),
]);
export type LayerEffect = Static<typeof LayerEffect>;

/** Maske aus einer eingebetteten Node. */
export const Mask = Type.Object(
  {
    node: NodeSlot,
    mode: Type.Optional(Type.Union([Type.Literal('alpha'), Type.Literal('luminance')])),
    invert: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Pfad, dem eine Node folgt. */
export const MotionPath = Type.Object(
  {
    d: Type.String({ minLength: 1, description: 'SVG path data.' }),
    progress: ANumber({ minimum: 0, maximum: 1 }),
    autoRotate: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** Felder, die jede Node besitzt. */
const BaseFields = {
  id: Id,
  name: Type.Optional(Type.String()),
  comment: Type.Optional(Type.String()),
  visible: Type.Optional(ABoolean()),
  locked: Type.Optional(Type.Boolean()),
  timing: Type.Optional(Timing),
  transition: Type.Optional(Transition),
  renderer: Type.Optional(Type.String({ description: 'Explicit backend id, e.g. "skia" or "pixi".' })),
  meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
} satisfies TProperties;

/** 2D-Transform und Darstellung. */
const VisualFields = {
  x: Type.Optional(ANumber({ description: 'Left edge in pixels.' })),
  y: Type.Optional(ANumber({ description: 'Top edge in pixels.' })),
  rotation: Type.Optional(ANumber({ description: 'Rotation in degrees around `origin`.' })),
  scale: Type.Optional(AVec2('Scale factors around `origin`.')),
  skew: Type.Optional(AVec2('Skew angles in degrees.')),
  origin: Type.Optional(AVec2('Transform origin relative to the box (0..1). Default { x: 0.5, y: 0.5 }.')),
  opacity: Type.Optional(ANumber({ minimum: 0, maximum: 1 })),
  zIndex: Type.Optional(ANumber({ description: 'Draw order among siblings (animatable). Higher values draw on top; equal values keep document order. Default 0.' })),
  blendMode: Type.Optional(BlendMode),
  filters: Type.Optional(Type.Array(Filter)),
  shadow: Type.Optional(Shadow),
  mask: Type.Optional(Mask),
  motionPath: Type.Optional(MotionPath),
} satisfies TProperties;

/** Füllung und Kontur für Formen. */
const PaintFields = {
  fill: Type.Optional(Paint),
  stroke: Type.Optional(Paint),
  strokeWidth: Type.Optional(ANumber({ minimum: 0 })),
  strokeCap: Type.Optional(Type.Union([Type.Literal('butt'), Type.Literal('round'), Type.Literal('square')])),
  strokeJoin: Type.Optional(Type.Union([Type.Literal('miter'), Type.Literal('round'), Type.Literal('bevel')])),
  strokeDash: Type.Optional(Type.Array(Type.Number({ minimum: 0 }))),
  trimStart: Type.Optional(ANumber({ minimum: 0, maximum: 1 })),
  trimEnd: Type.Optional(ANumber({ minimum: 0, maximum: 1 })),
  trimOffset: Type.Optional(ANumber()),
} satisfies TProperties;

const Size = {
  width: Type.Optional(ANumber({ minimum: 0 })),
  height: Type.Optional(ANumber({ minimum: 0 })),
} satisfies TProperties;

const RequiredSize = {
  width: ANumber({ minimum: 0 }),
  height: ANumber({ minimum: 0 }),
} satisfies TProperties;

const Fit = Type.Union([Type.Literal('fill'), Type.Literal('contain'), Type.Literal('cover'), Type.Literal('none')]);

function node<T extends string, P extends TProperties>(type: T, props: P, description: string) {
  return Type.Object({ ...BaseFields, type: Type.Literal(type), ...props }, { additionalProperties: false, description });
}

// ---------------------------------------------------------------------------
// Struktur
// ---------------------------------------------------------------------------

export const GroupNode = node(
  'group',
  { ...VisualFields, ...Size, clip: Type.Optional(Type.Boolean({ description: 'Clip children to width x height.' })), children: Type.Optional(NodeList) },
  'Groups children with a shared transform.',
);

export const LayerNode = node(
  'layer',
  {
    ...VisualFields,
    ...Size,
    colorSpace: Type.Optional(ColorSpace),
    crop: Type.Optional(
      Type.Object(
        { x: ANumber(), y: ANumber(), width: ANumber({ minimum: 0 }), height: ANumber({ minimum: 0 }) },
        { additionalProperties: false },
      ),
    ),
    effects: Type.Optional(Type.Array(LayerEffect)),
    motionBlur: Type.Optional(
      Type.Object(
        { samples: Type.Integer({ minimum: 2, maximum: 64 }), shutter: Type.Number({ exclusiveMinimum: 0, maximum: 1 }) },
        { additionalProperties: false, description: 'Temporal supersampling. shutter = fraction of a frame.' },
      ),
    ),
    children: Type.Optional(NodeList),
  },
  'Compositing boundary: always rendered as its own layer.',
);

export const CompositionRefNode = node(
  'composition-ref',
  { ...VisualFields, ...Size, composition: Id },
  'Nested composition, evaluated at the remapped local time.',
);

/** Übergang zwischen zwei aufeinanderfolgenden Kindern einer `sequence` (T9). */
export const SequenceTransition = Type.Union(
  [
    Type.Object({ type: Type.Literal('cut') }, { additionalProperties: false, description: 'Hard cut: no overlap.' }),
    Type.Object({ type: TransitionType, duration: TimeValue, ease: Type.Optional(Easing) }, { additionalProperties: false }),
  ],
  { description: 'Transition between two consecutive children. The next child starts `duration` before the previous one ends.' },
);
export type SequenceTransition = Static<typeof SequenceTransition>;

export const SequenceNode = node(
  'sequence',
  {
    ...VisualFields,
    ...Size,
    between: Type.Optional(SequenceTransition),
    transitions: Type.Optional(Type.Array(SequenceTransition, { description: 'Per gap: item i sits between child i and child i + 1 and overrides `between`.' })),
    children: Type.Optional(NodeList),
  },
  'Plays its children one after another (each needs timing.duration, or is a composition-ref). Consecutive children overlap by the transition duration and cross over automatically.',
);

export const ComponentNode = node(
  'component',
  {
    ...VisualFields,
    component: Type.String({ pattern: '^[A-Z][A-Za-z0-9]*$', description: 'Registered component name, e.g. "LowerThird".' }),
    props: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: 'Component props (validated by the component).' })),
    children: Type.Optional(NodeList),
  },
  'Reusable component expanded at evaluation time.',
);

// ---------------------------------------------------------------------------
// 2D-Formen
// ---------------------------------------------------------------------------

export const RectNode = node(
  'rect',
  {
    ...VisualFields,
    ...PaintFields,
    ...RequiredSize,
    cornerRadius: Type.Optional(
      Type.Union([ANumber({ minimum: 0 }), Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()])], {
        description: 'Uniform radius or [topLeft, topRight, bottomRight, bottomLeft].',
      }),
    ),
  },
  'Rectangle, optionally rounded.',
);

export const EllipseNode = node('ellipse', { ...VisualFields, ...PaintFields, ...RequiredSize }, 'Ellipse inside the box. Equal width and height = circle.');

export const LineNode = node(
  'line',
  { ...VisualFields, ...PaintFields, from: AVec2('Start point.'), to: AVec2('End point.') },
  'Straight line between two points.',
);

export const PolylineNode = node(
  'polyline',
  { ...VisualFields, ...PaintFields, points: animatableDiscrete(Type.Array(Point, { minItems: 2 })) },
  'Open line through points.',
);

export const PolygonNode = node(
  'polygon',
  { ...VisualFields, ...PaintFields, points: animatableDiscrete(Type.Array(Point, { minItems: 3 })) },
  'Closed shape through points.',
);

export const PathNode = node(
  'path',
  {
    ...VisualFields,
    ...PaintFields,
    d: AString('SVG path data. Keyframes morph when command structure matches.'),
    fillRule: Type.Optional(Type.Union([Type.Literal('nonzero'), Type.Literal('evenodd')])),
  },
  'Vector path from SVG path data.',
);

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Animation pro Zeichen, Wort oder Zeile (FR-35). */
export const TextAnimation = Type.Object(
  {
    unit: Type.Union([Type.Literal('char'), Type.Literal('word'), Type.Literal('line')]),
    start: Type.Optional(TimeValue),
    stagger: Type.Optional(TimeValue),
    duration: Type.Optional(TimeValue),
    ease: Type.Optional(Easing),
    from: Type.Object(
      {
        opacity: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        x: Type.Optional(Type.Number()),
        y: Type.Optional(Type.Number()),
        scale: Type.Optional(Type.Number()),
        rotation: Type.Optional(Type.Number()),
        blur: Type.Optional(Type.Number({ minimum: 0 })),
        color: Type.Optional(Color),
      },
      { additionalProperties: false },
    ),
    order: Type.Optional(Type.Union([Type.Literal('forward'), Type.Literal('backward'), Type.Literal('center'), Type.Literal('random')])),
    starts: Type.Optional(Type.Array(TimeValue, { description: 'Start of each unit in local time; replaces start + stagger · position for the units listed (e.g. word timings of captions).' })),
  },
  { additionalProperties: false },
);

const TextStyleFields = {
  fontFamily: Type.Optional(Type.String({ minLength: 1, examples: ['Inter'] })),
  fontSize: Type.Optional(ANumber({ minimum: 0, examples: [64] })),
  fontWeight: Type.Optional(ANumber({ minimum: 1, maximum: 1000 })),
  fontStyle: Type.Optional(Type.Union([Type.Literal('normal'), Type.Literal('italic')])),
  fontStretch: Type.Optional(ANumber({ minimum: 1, description: 'Percent, 100 = normal.' })),
  fontFeatures: Type.Optional(Type.Record(Type.String({ pattern: '^[a-zA-Z0-9]{4}$' }), Type.Integer({ minimum: 0 }))),
  fontVariations: Type.Optional(Type.Record(Type.String({ pattern: '^[a-zA-Z0-9]{4}$' }), ANumber())),
  letterSpacing: Type.Optional(ANumber({ description: 'Tracking in pixels.' })),
  lineHeight: Type.Optional(ANumber({ minimum: 0, description: 'Multiple of font size.' })),
  fill: Type.Optional(Paint),
  stroke: Type.Optional(Paint),
  strokeWidth: Type.Optional(ANumber({ minimum: 0 })),
  decoration: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('underline'), Type.Literal('line-through'), Type.Literal('overline')])),
} satisfies TProperties;

/** Hintergrundbox hinter gemessenem Text (z. B. für Untertitel und Labels). */
export const TextBackground = Type.Object(
  {
    color: AColor(),
    paddingX: Type.Optional(ANumber({ minimum: 0 })),
    paddingY: Type.Optional(ANumber({ minimum: 0 })),
    radius: Type.Optional(ANumber({ minimum: 0 })),
    perLine: Type.Optional(Type.Boolean({ description: 'One box per line instead of one box around the paragraph.' })),
  },
  { additionalProperties: false },
);

const ParagraphFields = {
  background: Type.Optional(TextBackground),
  textAlign: Type.Optional(
    Type.Union([Type.Literal('left'), Type.Literal('center'), Type.Literal('right'), Type.Literal('justify'), Type.Literal('start'), Type.Literal('end')]),
  ),
  direction: Type.Optional(Type.Union([Type.Literal('ltr'), Type.Literal('rtl'), Type.Literal('auto')])),
  width: Type.Optional(ANumber({ minimum: 0, description: 'Wrap width. Without width the text does not wrap.' })),
  maxLines: Type.Optional(Type.Integer({ minimum: 1 })),
  ellipsis: Type.Optional(Type.String()),
  textPath: Type.Optional(
    Type.Object({ d: Type.String({ minLength: 1 }), offset: Type.Optional(ANumber()) }, { additionalProperties: false, description: 'Lay text along an SVG path.' }),
  ),
  textAnimation: Type.Optional(TextAnimation),
} satisfies TProperties;

export const TextNode = node(
  'text',
  { ...VisualFields, ...TextStyleFields, ...ParagraphFields, text: AString('The text content.') },
  'Single-style text with wrapping, shaping and per-unit animation.',
);

export const TextSpan = Type.Object({ text: Type.String(), ...TextStyleFields }, { additionalProperties: false });

export const RichTextNode = node(
  'rich-text',
  { ...VisualFields, ...TextStyleFields, ...ParagraphFields, spans: Type.Array(TextSpan, { minItems: 1 }) },
  'Text with differently styled spans.',
);

// ---------------------------------------------------------------------------
// Bilder und Medien
// ---------------------------------------------------------------------------

export const ImageNode = node(
  'image',
  { ...VisualFields, ...Size, asset: Id, fit: Type.Optional(Fit), smoothing: Type.Optional(Type.Union([Type.Literal('linear'), Type.Literal('nearest'), Type.Literal('cubic')])) },
  'Raster image from an asset.',
);

export const VideoNode = node(
  'video',
  {
    ...VisualFields,
    ...Size,
    asset: Id,
    fit: Type.Optional(Fit),
    startFrom: Type.Optional(TimeValue),
    playbackRate: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    loop: Type.Optional(Type.Boolean()),
    volume: Type.Optional(ANumber({ minimum: 0 })),
    muted: Type.Optional(Type.Boolean()),
  },
  'Video from an asset; its audio joins the mix unless muted.',
);

export const SvgNode = node(
  'svg',
  {
    ...VisualFields,
    ...Size,
    asset: Type.Optional(Id),
    markup: Type.Optional(Type.String({ minLength: 1, description: 'Inline SVG markup.' })),
    fit: Type.Optional(Fit),
  },
  'SVG from an asset or inline markup.',
);

export const SpriteNode = node(
  'sprite',
  {
    ...VisualFields,
    ...Size,
    asset: Id,
    columns: Type.Integer({ minimum: 1 }),
    rows: Type.Integer({ minimum: 1 }),
    frameCount: Type.Optional(Type.Integer({ minimum: 1 })),
    frameRate: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: 'Sprite frames per second.' })),
    frame: Type.Optional(ANumber({ minimum: 0, description: 'Explicit sprite frame; overrides frameRate.' })),
    loop: Type.Optional(Type.Boolean()),
  },
  'Frame from a sprite sheet grid.',
);

export const LottieNode = node(
  'lottie',
  {
    ...VisualFields,
    ...RequiredSize,
    asset: Id,
    speed: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    frameOffset: Type.Optional(Type.Number()),
    loop: Type.Optional(Type.Boolean()),
    fit: Type.Optional(Fit),
  },
  'Lottie animation, frame-exact.',
);

export const ShaderNode = node(
  'shader',
  {
    ...VisualFields,
    ...RequiredSize,
    sksl: Type.Optional(Type.String({ minLength: 1, description: 'SkSL source with `half4 main(float2 coord)`.' })),
    glsl: Type.Optional(Type.String({ minLength: 1, description: 'GLSL fragment source for the PixiJS backend.' })),
    uniforms: Type.Optional(Type.Record(Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }), animatable(Type.Union([Type.Number(), Type.Array(Type.Number())])))),
  },
  'Custom shader filling the box. Uniforms `time`, `frame`, `resolution` are provided.',
);

const RangeNumber = Type.Object({ min: Type.Number(), max: Type.Number() }, { additionalProperties: false });
const StartEndNumber = Type.Object({ start: Type.Number(), end: Type.Number() }, { additionalProperties: false });
const StartEndColor = Type.Object({ start: Color, end: Color }, { additionalProperties: false });

export const ParticlesNode = node(
  'particles',
  {
    ...VisualFields,
    ...RequiredSize,
    count: Type.Integer({ minimum: 1, maximum: 100000 }),
    seed: Type.Optional(Type.Integer()),
    emitter: Type.Optional(
      Type.Object(
        { x: Type.Number(), y: Type.Number(), radius: Type.Optional(Type.Number({ minimum: 0 })), shape: Type.Optional(Type.Union([Type.Literal('point'), Type.Literal('circle'), Type.Literal('rect'), Type.Literal('box')])) },
        { additionalProperties: false },
      ),
    ),
    lifetime: Type.Optional(RangeNumber),
    speed: Type.Optional(RangeNumber),
    angle: Type.Optional(RangeNumber),
    gravity: Type.Optional(Type.Object({ x: Type.Number(), y: Type.Number() }, { additionalProperties: false })),
    size: Type.Optional(StartEndNumber),
    color: Type.Optional(StartEndColor),
    opacity: Type.Optional(ANumber({ minimum: 0, maximum: 1 })),
    fade: Type.Optional(StartEndNumber),
    shape: Type.Optional(Type.Union([Type.Literal('circle'), Type.Literal('square'), Type.Literal('spark')])),
    emitDuration: Type.Optional(TimeValue),
  },
  'Stateless 2D particle system: particle state is a pure function of time and seed.',
);

export const HtmlNode = node(
  'html',
  {
    ...VisualFields,
    ...RequiredSize,
    html: Type.String({ description: 'HTML body content. Scripts run in the sandboxed browser with virtual time.' }),
    css: Type.Optional(Type.String()),
    assets: Type.Optional(Type.Array(Id, { description: 'Assets served to the page under /assets/<id>.' })),
    background: Type.Optional(Color),
  },
  'HTML/CSS/SVG/Canvas/WebGL content rendered by Chromium.',
);

export const SubtitlesNode = node(
  'subtitles',
  {
    ...VisualFields,
    track: Id,
    fontFamily: Type.Optional(Type.String()),
    fontSize: Type.Optional(ANumber({ minimum: 1 })),
    fontWeight: Type.Optional(Type.Number({ minimum: 1, maximum: 1000 })),
    color: Type.Optional(AColor()),
    highlightColor: Type.Optional(AColor()),
    box: Type.Optional(
      Type.Object(
        { color: Color, paddingX: Type.Optional(Type.Number({ minimum: 0 })), paddingY: Type.Optional(Type.Number({ minimum: 0 })), radius: Type.Optional(Type.Number({ minimum: 0 })) },
        { additionalProperties: false },
      ),
    ),
    position: Type.Optional(Type.Union([Type.Literal('bottom'), Type.Literal('top'), Type.Literal('center'), Type.Literal('custom')])),
    maxWidth: Type.Optional(Type.Number({ minimum: 1 })),
    style: Type.Optional(
      Type.Union([Type.Literal('plain'), Type.Literal('word-highlight'), Type.Literal('karaoke'), Type.Literal('pop'), Type.Literal('fade'), Type.Literal('typewriter')]),
    ),
    speakerStyles: Type.Optional(Type.Record(Type.String(), Type.Object({ color: Type.Optional(Color), fontFamily: Type.Optional(Type.String()), box: Type.Optional(Color) }, { additionalProperties: false }))),
    safeArea: Type.Optional(Type.Number({ minimum: 0, maximum: 0.5, description: 'Margin as fraction of frame size. Default 0.05.' })),
    stroke: Type.Optional(Color),
    strokeWidth: Type.Optional(Type.Number({ minimum: 0 })),
    textAnimation: Type.Optional(TextAnimation),
  },
  'Animated captions from a subtitle track. textAnimation animates each word from its own start time.',
);

// ---------------------------------------------------------------------------
// 3D
// ---------------------------------------------------------------------------

const Transform3DFields = {
  position: Type.Optional(AVec3('Position in meters.')),
  rotation: Type.Optional(AVec3('Euler rotation XYZ in degrees.')),
  scale: Type.Optional(AVec3('Scale per axis.')),
  visible: Type.Optional(ABoolean()),
} satisfies TProperties;

export const Geometry = Type.Union([
  Type.Object({ type: Type.Literal('box'), width: Type.Optional(Type.Number()), height: Type.Optional(Type.Number()), depth: Type.Optional(Type.Number()) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('sphere'), radius: Type.Optional(Type.Number()), segments: Type.Optional(Type.Integer({ minimum: 3 })) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('plane'), width: Type.Optional(Type.Number()), height: Type.Optional(Type.Number()) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('cylinder'), radiusTop: Type.Optional(Type.Number()), radiusBottom: Type.Optional(Type.Number()), height: Type.Optional(Type.Number()), segments: Type.Optional(Type.Integer({ minimum: 3 })) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('cone'), radius: Type.Optional(Type.Number()), height: Type.Optional(Type.Number()), segments: Type.Optional(Type.Integer({ minimum: 3 })) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('torus'), radius: Type.Optional(Type.Number()), tube: Type.Optional(Type.Number()) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('torus-knot'), radius: Type.Optional(Type.Number()), tube: Type.Optional(Type.Number()), p: Type.Optional(Type.Integer()), q: Type.Optional(Type.Integer()) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('capsule'), radius: Type.Optional(Type.Number()), length: Type.Optional(Type.Number()) }, { additionalProperties: false }),
]);
export type Geometry = Static<typeof Geometry>;

export const Material = Type.Object(
  {
    type: Type.Optional(Type.Union([Type.Literal('standard'), Type.Literal('physical'), Type.Literal('basic'), Type.Literal('shader')])),
    color: Type.Optional(AColor()),
    metalness: Type.Optional(ANumber({ minimum: 0, maximum: 1 })),
    roughness: Type.Optional(ANumber({ minimum: 0, maximum: 1 })),
    emissive: Type.Optional(AColor()),
    emissiveIntensity: Type.Optional(ANumber({ minimum: 0 })),
    opacity: Type.Optional(ANumber({ minimum: 0, maximum: 1 })),
    transmission: Type.Optional(ANumber({ minimum: 0, maximum: 1 })),
    clearcoat: Type.Optional(ANumber({ minimum: 0, maximum: 1 })),
    envMapIntensity: Type.Optional(ANumber({ minimum: 0 })),
    wireframe: Type.Optional(Type.Boolean()),
    map: Type.Optional(Id),
    normalMap: Type.Optional(Id),
    roughnessMap: Type.Optional(Id),
    vertexShader: Type.Optional(Type.String()),
    fragmentShader: Type.Optional(Type.String()),
    uniforms: Type.Optional(Type.Record(Type.String(), animatable(Type.Union([Type.Number(), Type.Array(Type.Number())])))),
  },
  { additionalProperties: false },
);
export type Material = Static<typeof Material>;

export const Camera3DNode = node(
  'camera3d',
  {
    ...Transform3DFields,
    projection: Type.Optional(Type.Union([Type.Literal('perspective'), Type.Literal('orthographic')])),
    fov: Type.Optional(ANumber({ minimum: 1, maximum: 179 })),
    near: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    far: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    zoom: Type.Optional(ANumber({ minimum: 0 })),
    target: Type.Optional(AVec3('Point the camera looks at.')),
    focusDistance: Type.Optional(ANumber({ minimum: 0 })),
  },
  '3D camera.',
);

export const Light3DNode = node(
  'light3d',
  {
    ...Transform3DFields,
    kind: Type.Union([Type.Literal('ambient'), Type.Literal('directional'), Type.Literal('point'), Type.Literal('spot'), Type.Literal('hemisphere')]),
    color: Type.Optional(AColor()),
    groundColor: Type.Optional(AColor()),
    intensity: Type.Optional(ANumber({ minimum: 0 })),
    target: Type.Optional(AVec3()),
    castShadow: Type.Optional(Type.Boolean()),
    angle: Type.Optional(ANumber({ minimum: 0, maximum: 90 })),
    penumbra: Type.Optional(ANumber({ minimum: 0, maximum: 1 })),
    distance: Type.Optional(ANumber({ minimum: 0 })),
  },
  '3D light.',
);

export const Mesh3DNode = node(
  'mesh3d',
  { ...Transform3DFields, geometry: Geometry, material: Type.Optional(Material), castShadow: Type.Optional(Type.Boolean()), receiveShadow: Type.Optional(Type.Boolean()) },
  '3D mesh with built-in geometry.',
);

export const Model3DNode = node(
  'model3d',
  {
    ...Transform3DFields,
    asset: Id,
    animation: Type.Optional(
      Type.Object(
        { clip: Type.String(), offset: Type.Optional(TimeValue), speed: Type.Optional(Type.Number()), loop: Type.Optional(Type.Boolean()) },
        { additionalProperties: false },
      ),
    ),
    morphTargets: Type.Optional(Type.Record(Type.String(), ANumber({ minimum: 0, maximum: 1 }))),
    material: Type.Optional(Material),
    castShadow: Type.Optional(Type.Boolean()),
    receiveShadow: Type.Optional(Type.Boolean()),
  },
  'glTF, GLB or OBJ model.',
);

export const Instances3DNode = node(
  'instances3d',
  {
    ...Transform3DFields,
    geometry: Geometry,
    material: Type.Optional(Material),
    count: Type.Integer({ minimum: 1, maximum: 1000000 }),
    seed: Type.Optional(Type.Integer()),
    layout: Type.Union([
      Type.Object({ type: Type.Literal('grid'), columns: Type.Integer({ minimum: 1 }), spacing: Type.Number() }, { additionalProperties: false }),
      Type.Object({ type: Type.Literal('random-box'), size: Vec3, scale: Type.Optional(Type.Object({ min: Type.Number(), max: Type.Number() }, { additionalProperties: false })) }, { additionalProperties: false }),
      Type.Object({ type: Type.Literal('random-sphere'), radius: Type.Number(), scale: Type.Optional(Type.Object({ min: Type.Number(), max: Type.Number() }, { additionalProperties: false })) }, { additionalProperties: false }),
      Type.Object({ type: Type.Literal('explicit'), transforms: Type.Array(Type.Object({ position: Vec3, rotation: Type.Optional(Vec3), scale: Type.Optional(Vec3) }, { additionalProperties: false })) }, { additionalProperties: false }),
    ]),
    spin: Type.Optional(ANumber({ description: 'Rotation speed per instance in degrees per second.' })),
  },
  'Many instances of one mesh.',
);

export const Particles3DNode = node(
  'particles3d',
  {
    ...Transform3DFields,
    count: Type.Integer({ minimum: 1, maximum: 1000000 }),
    seed: Type.Optional(Type.Integer()),
    emitter: Type.Optional(Type.Object({ shape: Type.Union([Type.Literal('point'), Type.Literal('sphere'), Type.Literal('box')]), size: Type.Optional(Type.Number({ minimum: 0 })) }, { additionalProperties: false })),
    lifetime: Type.Optional(RangeNumber),
    speed: Type.Optional(RangeNumber),
    gravity: Type.Optional(Vec3),
    size: Type.Optional(StartEndNumber),
    color: Type.Optional(StartEndColor),
    additive: Type.Optional(Type.Boolean()),
  },
  'Stateless 3D particle system.',
);

export const Group3DNode = node('group3d', { ...Transform3DFields, children: Type.Optional(NodeList) }, 'Groups 3D nodes.');

const PostProcessing = Type.Object(
  {
    bloom: Type.Optional(Type.Object({ strength: ANumber({ minimum: 0 }), radius: Type.Optional(ANumber({ minimum: 0 })), threshold: Type.Optional(ANumber({ minimum: 0 })) }, { additionalProperties: false })),
    depthOfField: Type.Optional(Type.Object({ focus: ANumber({ minimum: 0 }), aperture: ANumber({ minimum: 0 }), maxBlur: Type.Optional(ANumber({ minimum: 0 })) }, { additionalProperties: false })),
    colorGrading: Type.Optional(
      Type.Object(
        { exposure: Type.Optional(ANumber()), contrast: Type.Optional(ANumber()), saturation: Type.Optional(ANumber()), lut: Type.Optional(Id) },
        { additionalProperties: false },
      ),
    ),
    vignette: Type.Optional(Type.Object({ offset: ANumber(), darkness: ANumber() }, { additionalProperties: false })),
  },
  { additionalProperties: false },
);

const Scene3DFields = {
  ...VisualFields,
  ...RequiredSize,
  camera: Type.Optional(Id),
  background: Type.Optional(AColor()),
  environment: Type.Optional(
    Type.Object(
      { hdri: Type.Optional(Id), preset: Type.Optional(Type.Union([Type.Literal('studio'), Type.Literal('neutral'), Type.Literal('sunset')])), intensity: Type.Optional(Type.Number({ minimum: 0 })), showBackground: Type.Optional(Type.Boolean()) },
      { additionalProperties: false },
    ),
  ),
  fog: Type.Optional(Type.Object({ color: Color, near: Type.Number({ minimum: 0 }), far: Type.Number({ minimum: 0 }) }, { additionalProperties: false })),
  shadows: Type.Optional(Type.Boolean()),
  toneMapping: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('aces'), Type.Literal('agx'), Type.Literal('neutral')])),
  children: Type.Optional(NodeList),
} satisfies TProperties;

export const Scene3DNode = node(
  'scene3d',
  {
    ...Scene3DFields,
    backend: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('webgpu'), Type.Literal('webgl2')], { description: 'auto = WebGPU preferred, WebGL2 fallback.' })),
    antialias: Type.Optional(Type.Boolean()),
    textureDownscale: Type.Optional(Type.Boolean({ description: 'Downscale image textures larger than the GPU maximum texture size instead of failing with OV_THREE_TEXTURE_TOO_LARGE.' })),
    postprocessing: Type.Optional(PostProcessing),
  },
  'Real-time 3D scene rendered with Three.js.',
);

export const BlenderNode = node(
  'blender',
  {
    ...Scene3DFields,
    engine: Type.Optional(Type.Union([Type.Literal('cycles'), Type.Literal('eevee')])),
    samples: Type.Optional(Type.Integer({ minimum: 1, maximum: 65536 })),
    pass: Type.Optional(Type.Union([Type.Literal('combined'), Type.Literal('depth'), Type.Literal('normal'), Type.Literal('object-mask')])),
    maskObject: Type.Optional(Id),
    motionBlur: Type.Optional(Type.Boolean()),
    volume: Type.Optional(Type.Object({ density: Type.Number({ minimum: 0 }), color: Type.Optional(Color), anisotropy: Type.Optional(Type.Number()) }, { additionalProperties: false })),
  },
  'Offline 3D scene rendered with Blender (Cycles or Eevee).',
);

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

/**
 * Typ des Registers {@link NODE_SCHEMAS}. Explizit, weil der abgeleitete Typ für die
 * Deklarationsausgabe von TypeScript zu groß wird.
 */
export interface NodeSchemas {
  readonly group: typeof GroupNode;
  readonly layer: typeof LayerNode;
  readonly 'composition-ref': typeof CompositionRefNode;
  readonly sequence: typeof SequenceNode;
  readonly component: typeof ComponentNode;
  readonly rect: typeof RectNode;
  readonly ellipse: typeof EllipseNode;
  readonly line: typeof LineNode;
  readonly polyline: typeof PolylineNode;
  readonly polygon: typeof PolygonNode;
  readonly path: typeof PathNode;
  readonly text: typeof TextNode;
  readonly 'rich-text': typeof RichTextNode;
  readonly image: typeof ImageNode;
  readonly video: typeof VideoNode;
  readonly svg: typeof SvgNode;
  readonly sprite: typeof SpriteNode;
  readonly lottie: typeof LottieNode;
  readonly shader: typeof ShaderNode;
  readonly particles: typeof ParticlesNode;
  readonly html: typeof HtmlNode;
  readonly subtitles: typeof SubtitlesNode;
  readonly scene3d: typeof Scene3DNode;
  readonly blender: typeof BlenderNode;
  readonly camera3d: typeof Camera3DNode;
  readonly light3d: typeof Light3DNode;
  readonly mesh3d: typeof Mesh3DNode;
  readonly model3d: typeof Model3DNode;
  readonly instances3d: typeof Instances3DNode;
  readonly particles3d: typeof Particles3DNode;
  readonly group3d: typeof Group3DNode;
}

/** Alle eingebauten Node-Schemas nach Typ. */
export const NODE_SCHEMAS: NodeSchemas = {
  group: GroupNode,
  layer: LayerNode,
  'composition-ref': CompositionRefNode,
  sequence: SequenceNode,
  component: ComponentNode,
  rect: RectNode,
  ellipse: EllipseNode,
  line: LineNode,
  polyline: PolylineNode,
  polygon: PolygonNode,
  path: PathNode,
  text: TextNode,
  'rich-text': RichTextNode,
  image: ImageNode,
  video: VideoNode,
  svg: SvgNode,
  sprite: SpriteNode,
  lottie: LottieNode,
  shader: ShaderNode,
  particles: ParticlesNode,
  html: HtmlNode,
  subtitles: SubtitlesNode,
  scene3d: Scene3DNode,
  blender: BlenderNode,
  camera3d: Camera3DNode,
  light3d: Light3DNode,
  mesh3d: Mesh3DNode,
  model3d: Model3DNode,
  instances3d: Instances3DNode,
  particles3d: Particles3DNode,
  group3d: Group3DNode,
} satisfies Record<string, TObject>;

/** Name eines eingebauten Node-Typs. */
export type BuiltinNodeType = keyof typeof NODE_SCHEMAS;

/** Node-Typen, die nur innerhalb von `scene3d`, `blender` oder `group3d` stehen dürfen. */
export const NODE_TYPES_3D: readonly BuiltinNodeType[] = ['camera3d', 'light3d', 'mesh3d', 'model3d', 'instances3d', 'particles3d', 'group3d'];

/** Node-Typen, die 3D-Kinder aufnehmen. */
export const NODE_TYPES_3D_CONTAINER: readonly BuiltinNodeType[] = ['scene3d', 'blender', 'group3d'];

type RawNode<K extends BuiltinNodeType> = Static<(typeof NODE_SCHEMAS)[K]>;

/** Maske mit typisierter Node. */
export interface IrMask {
  node: IrNode;
  mode?: 'alpha' | 'luminance';
  invert?: boolean;
}

/** Statischer Typ einer Node eines bestimmten eingebauten Typs. */
export type NodeOf<K extends BuiltinNodeType> = Omit<RawNode<K>, 'children' | 'mask'> &
  ('children' extends keyof RawNode<K> ? { children?: IrNode[] } : unknown) &
  ('mask' extends keyof RawNode<K> ? { mask?: IrMask } : unknown);

/** Eine beliebige eingebaute Node. */
export type IrNode =
  | NodeOf<'group'>
  | NodeOf<'layer'>
  | NodeOf<'composition-ref'>
  | NodeOf<'sequence'>
  | NodeOf<'component'>
  | NodeOf<'rect'>
  | NodeOf<'ellipse'>
  | NodeOf<'line'>
  | NodeOf<'polyline'>
  | NodeOf<'polygon'>
  | NodeOf<'path'>
  | NodeOf<'text'>
  | NodeOf<'rich-text'>
  | NodeOf<'image'>
  | NodeOf<'video'>
  | NodeOf<'svg'>
  | NodeOf<'sprite'>
  | NodeOf<'lottie'>
  | NodeOf<'shader'>
  | NodeOf<'particles'>
  | NodeOf<'html'>
  | NodeOf<'subtitles'>
  | NodeOf<'scene3d'>
  | NodeOf<'blender'>
  | NodeOf<'camera3d'>
  | NodeOf<'light3d'>
  | NodeOf<'mesh3d'>
  | NodeOf<'model3d'>
  | NodeOf<'instances3d'>
  | NodeOf<'particles3d'>
  | NodeOf<'group3d'>;
