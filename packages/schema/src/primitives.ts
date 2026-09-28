/**
 * Grundbausteine der Composition IR: IDs, Farben, Zeitwerte, Easings, Vektoren
 * und animierbare Werte (AD-3, AD-4).
 */
import Type, { type Static, type TSchema } from 'typebox';

/** Muster für stabile Node-, Asset- und Composition-IDs. Komponenten-Kinder nutzen `/`. */
export const ID_PATTERN = '^[A-Za-z][A-Za-z0-9_-]*(/[A-Za-z0-9_-]+)*$';

/** Stabile ID eines IR-Elements, z. B. `headline` oder `chart/bar-3`. */
export const Id = Type.String({
  pattern: ID_PATTERN,
  description: 'Stable identifier: letter first, then letters, digits, "_" or "-".',
  examples: ['headline'],
});
export type Id = Static<typeof Id>;

/** Muster für Farben: `#RGB`, `#RRGGBB`, `#RRGGBBAA` oder `transparent`. */
export const COLOR_PATTERN = '^(#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|transparent)$';

/** sRGB-Farbe, nicht vormultipliziert (AD-4). */
export const Color = Type.String({
  pattern: COLOR_PATTERN,
  description: 'sRGB color as #RRGGBB or #RRGGBBAA, or "transparent".',
  examples: ['#FFFFFF'],
});
export type Color = Static<typeof Color>;

/**
 * Muster für Zeitwerte als Text:
 * `2s`, `1.5s`, `500ms`, `48f`, `00:00:02:00` (SMPTE, auch `;` für Drop-Frame),
 * `marker:intro`, `marker:intro+10f`, `marker:intro-0.5s`.
 */
export const TIME_STRING_PATTERN =
  '^(-?[0-9]+(\\.[0-9]+)?(s|ms|f)|[0-9]{2}:[0-9]{2}:[0-9]{2}[:;][0-9]{2}|marker:[A-Za-z][A-Za-z0-9_.-]*([+-][0-9]+(\\.[0-9]+)?(s|ms|f))?)$';

/** Zeitwert: Zahl = Frames, Text = Einheit (siehe {@link TIME_STRING_PATTERN}). */
export const TimeValue = Type.Union(
  [
    Type.Number({ description: 'Time in frames.' }),
    Type.String({ pattern: TIME_STRING_PATTERN, description: 'Time with unit: "2s", "500ms", "48f", "00:00:02:00", "marker:intro+10f".' }),
  ],
  { description: 'Frames as number or a string with unit.', examples: ['2s'] },
);
export type TimeValue = Static<typeof TimeValue>;

/** Muster für Easings. */
export const EASING_PATTERN =
  '^(linear|hold|ease|easeIn|easeOut|easeInOut|(easeIn|easeOut|easeInOut)(Sine|Quad|Cubic|Quart|Quint|Expo|Circ|Back|Elastic|Bounce)|cubic-bezier\\(\\s*-?[0-9.]+\\s*,\\s*-?[0-9.]+\\s*,\\s*-?[0-9.]+\\s*,\\s*-?[0-9.]+\\s*\\)|steps\\(\\s*[0-9]+\\s*(,\\s*(start|end))?\\s*\\)|spring\\(\\s*[0-9.]+\\s*,\\s*[0-9.]+\\s*(,\\s*[0-9.]+\\s*)?\\))$';

/** Easing-Funktion als Name oder Funktionsausdruck. */
export const Easing = Type.String({
  pattern: EASING_PATTERN,
  description: 'Easing name ("easeInOutCubic"), "cubic-bezier(x1,y1,x2,y2)", "steps(n,end)" or "spring(stiffness,damping[,mass])".',
  examples: ['easeInOutCubic'],
});
export type Easing = Static<typeof Easing>;

/** 2D-Vektor als Objekt. */
export const Vec2 = Type.Object(
  { x: Type.Number(), y: Type.Number() },
  { additionalProperties: false, examples: [{ x: 1, y: 1 }] },
);
export type Vec2 = Static<typeof Vec2>;

/** 3D-Vektor als Tupel `[x, y, z]` (Meter bzw. Grad). */
export const Vec3 = Type.Tuple([Type.Number(), Type.Number(), Type.Number()], { examples: [[0, 1, 5]] });
export type Vec3 = Static<typeof Vec3>;

/** Punkt als Tupel `[x, y]` in Pixeln. */
export const Point = Type.Tuple([Type.Number(), Type.Number()]);
export type Point = Static<typeof Point>;

/** Blend Modes für Nodes und Layer. */
export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
  'add',
] as const;
export const BlendMode = Type.Enum(BLEND_MODES, { description: 'Blend mode.', examples: ['normal'] });
export type BlendMode = Static<typeof BlendMode>;

/** Farbräume (A39). */
export const ColorSpace = Type.Union([Type.Literal('srgb'), Type.Literal('linear'), Type.Literal('rec709')], {
  description: 'Color space: "srgb", "linear" (linear-light sRGB primaries) or "rec709".',
});
export type ColorSpace = Static<typeof ColorSpace>;

// ---------------------------------------------------------------------------
// Animierbare Werte (AD-3)
// ---------------------------------------------------------------------------

/** Markierung, an der der Validator animierbare Werte erkennt. */
export const ANIMATABLE_MARK = 'x-animatable';

/** Ausdruck in der sicheren Expression-Sprache. */
export const Expr = Type.Object(
  { $expr: Type.String({ minLength: 1, description: 'Safe expression, e.g. "sin(time * 2) * 40".' }) },
  { additionalProperties: false },
);
export type Expr = Static<typeof Expr>;

/** Verweis auf ein Theme-Token, z. B. `theme.colors.primary`. */
export const Ref = Type.Object(
  { $ref: Type.String({ pattern: '^theme\\.[A-Za-z]+\\.[A-Za-z0-9_.-]+$', description: 'Theme token path, e.g. "theme.colors.primary".' }) },
  { additionalProperties: false },
);
export type Ref = Static<typeof Ref>;

/** Parameter einer Feder-Animation. */
export function springOf<T extends TSchema>(value: T) {
  return Type.Object(
    {
      $spring: Type.Object(
        {
          from: value,
          to: value,
          at: Type.Optional(TimeValue),
          stiffness: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
          damping: Type.Optional(Type.Number({ minimum: 0 })),
          mass: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
          velocity: Type.Optional(Type.Number()),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  );
}

/** Pro Frame vorberechnete Werte (aus Frame-Funktionen, FR-17a). */
export function sampledOf<T extends TSchema>(value: T) {
  return Type.Object(
    {
      $sampled: Type.Object(
        {
          start: Type.Integer({ minimum: 0, description: 'First frame of the samples (composition-local).' }),
          values: Type.Array(value, { minItems: 1 }),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  );
}

/** Keyframe-Animation. */
export function keyframesOf<T extends TSchema>(value: T) {
  return Type.Object(
    {
      $keyframes: Type.Array(
        Type.Object(
          {
            t: TimeValue,
            v: value,
            ease: Type.Optional(Easing),
          },
          { additionalProperties: false },
        ),
        { minItems: 1 },
      ),
      loop: Type.Optional(Type.Union([Type.Literal('none'), Type.Literal('repeat'), Type.Literal('pingpong')])),
      repeat: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Literal('infinite')])),
      delay: Type.Optional(TimeValue),
    },
    { additionalProperties: false },
  );
}

interface AnimatableOptions {
  readonly description?: string;
  readonly examples?: readonly unknown[];
}

function markOptions(options: AnimatableOptions) {
  return {
    [ANIMATABLE_MARK]: true,
    ...(options.description !== undefined ? { description: options.description } : {}),
    ...(options.examples !== undefined ? { examples: options.examples } : {}),
  };
}

/**
 * Macht einen Werttyp animierbar: Literal, `$keyframes`, `$spring`, `$expr`, `$sampled` oder `$ref`.
 * Der erste Zweig ist immer der Literal-Typ; der Validator nutzt das.
 */
export function animatable<T extends TSchema>(value: T, options: AnimatableOptions = {}) {
  return Type.Union([value, keyframesOf(value), springOf(value), Expr, sampledOf(value), Ref], markOptions(options));
}

/** Wie {@link animatable}, aber ohne Federn (für Farben, Texte, Wahrheitswerte, Listen). */
export function animatableDiscrete<T extends TSchema>(value: T, options: AnimatableOptions = {}) {
  return Type.Union([value, keyframesOf(value), Expr, sampledOf(value), Ref], markOptions(options));
}

/** Animierbare Zahl. */
export const ANumber = (options: { minimum?: number; maximum?: number; description?: string; examples?: readonly unknown[] } = {}) =>
  animatable(
    Type.Number({
      ...(options.minimum !== undefined ? { minimum: options.minimum } : {}),
      ...(options.maximum !== undefined ? { maximum: options.maximum } : {}),
    }),
    options,
  );

/** Animierbare Farbe (Federn sind für Farben nicht erlaubt). */
export const AColor = (description?: string) =>
  animatableDiscrete(Color, { ...(description !== undefined ? { description } : {}), examples: ['#FFFFFF'] });

/** Animierbarer 2D-Vektor. */
export const AVec2 = (description?: string) => animatable(Vec2, { ...(description !== undefined ? { description } : {}), examples: [{ x: 1, y: 1 }] });

/** Animierbarer 3D-Vektor. */
export const AVec3 = (description?: string) => animatable(Vec3, { ...(description !== undefined ? { description } : {}), examples: [[0, 0, 0]] });

/** Animierbarer Text (nur Keyframes mit Halten, Expressions, Samples, Refs). */
export const AString = (description?: string) => animatableDiscrete(Type.String(), description !== undefined ? { description } : {});

/** Animierbarer Wahrheitswert. */
export const ABoolean = () => animatableDiscrete(Type.Boolean());

/** Verlaufsstopp. */
export const GradientStop = Type.Object(
  { offset: Type.Number({ minimum: 0, maximum: 1 }), color: Color },
  { additionalProperties: false },
);

/** Linearer, radialer oder konischer Verlauf in lokalen Koordinaten der Node. */
export const Gradient = Type.Object(
  {
    type: Type.Union([Type.Literal('linear'), Type.Literal('radial'), Type.Literal('conic')]),
    stops: Type.Array(GradientStop, { minItems: 2 }),
    start: Type.Optional(Vec2),
    end: Type.Optional(Vec2),
    center: Type.Optional(Vec2),
    radius: Type.Optional(Type.Number({ minimum: 0 })),
    angle: Type.Optional(Type.Number({ description: 'Start angle in degrees (conic).' })),
    units: Type.Optional(Type.Union([Type.Literal('relative'), Type.Literal('pixels')], { description: 'relative: 0..1 of node bounds (default).' })),
  },
  { additionalProperties: false },
);
export type Gradient = Static<typeof Gradient>;

/** Füllung oder Kontur: Farbe (animierbar) oder Verlauf. */
export const Paint = Type.Union([AColor(), Gradient], { description: 'Color or gradient.' });
export type Paint = Static<typeof Paint>;

/** Schlagschatten. */
export const Shadow = Type.Object(
  {
    color: AColor(),
    blur: Type.Optional(ANumber({ minimum: 0 })),
    offsetX: Type.Optional(ANumber()),
    offsetY: Type.Optional(ANumber()),
  },
  { additionalProperties: false },
);
export type Shadow = Static<typeof Shadow>;

/** Filter für 2D-Nodes und Layer. */
export const Filter = Type.Union([
  Type.Object({ type: Type.Literal('blur'), radius: ANumber({ minimum: 0 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('brightness'), amount: ANumber({ minimum: 0 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('contrast'), amount: ANumber({ minimum: 0 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('saturate'), amount: ANumber({ minimum: 0 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('grayscale'), amount: ANumber({ minimum: 0, maximum: 1 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('sepia'), amount: ANumber({ minimum: 0, maximum: 1 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('invert'), amount: ANumber({ minimum: 0, maximum: 1 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal('hue-rotate'), degrees: ANumber() }, { additionalProperties: false }),
  Type.Object(
    { type: Type.Literal('color-matrix'), matrix: Type.Array(Type.Number(), { minItems: 20, maxItems: 20, description: '4x5 row-major color matrix.' }) },
    { additionalProperties: false },
  ),
]);
export type Filter = Static<typeof Filter>;
