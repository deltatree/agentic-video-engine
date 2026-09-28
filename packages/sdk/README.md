# @agentic-video/sdk

TypeScript/JSX-SDK: composition(), JSX-Runtime, Animations-Helfer.

JSX ist nur Syntax. Jedes Element ist ein Datenobjekt `{ type, props, source? }`.
`toIR()` übersetzt die Definition in die Composition IR. Es gibt kein React.

## Beispiel

```tsx
import { composition, Scene, Rect } from '@agentic-video/sdk';

export default composition({
  width: 1920, height: 1080, fps: 30, duration: '2s',
  scene: ({ frame }) => (
    <Scene background="#101010">
      <Rect id="box" x={frame * 2} y={40} width={50} height={50} />
    </Scene>
  ),
});
```

Compiler-Einstellungen: `jsx: 'automatic'`, `jsxImportSource: '@agentic-video/sdk'`.

## Frame-Funktionen

- `toIR` ruft `scene` für jeden Frame auf.
- Ein Wert, der sich ändert, wird `$sampled`: ein Wert je lokalem Frame der Node.
- Ein Wert, der gleich bleibt, bleibt ein Literal.
- Eine Node, die nur in manchen Frames existiert, bekommt `visible` als `$sampled`.
- Wechselt eine ID ihren Typ oder ihren Elternteil, meldet `toIR` den Fehler `OV_SDK_UNSTABLE_TREE` mit Frame.
- Liegt ein Wert außerhalb der Schema-Grenzen (z. B. `opacity` über 1 bei einer Feder), klemmt `toIR` ihn wie CSS. Es meldet dann die Warnung `OV_SDK_CLAMPED`.
- Beispiel: `x={frame * 2}` ergibt `{ "$sampled": { "start": 0, "values": [0, 2, 4, …] } }`.

## Aliase

| Alias | Bedeutung |
|---|---|
| `font` | `fontFamily` (Text, RichText, Subtitles, SubtitleTrack) |
| `rotationX`, `rotationY`, `rotationZ` | `rotation` als Vektor in Grad (3D-Nodes) |
| `src` bei Image, Video, Sprite, SpriteSheet, Lottie, Svg, Model, SubtitleTrack, AudioClip | Asset wird automatisch deklariert. ID = Dateiname ohne Endung (`./assets/product.glb` → `product`). Typ = aus der Endung, sonst Standard der Komponente. |
| `Circle radius` | Ellipse mit `width = height = 2 · radius`; `x`/`y` ist die linke obere Ecke |
| `RoundedRect radius` | `cornerRadius` |
| `Box width` usw. | Geometrie des `mesh3d` |
| `ThreeScene`/`BlenderScene` ohne Maße | Breite und Höhe der Composition |
| `SubtitleTrack src` | Asset + Subtitle-Track (ID = Asset-ID oder `track`) + `subtitles`-Node |
| `Scene background` | Hintergrundfarbe der Composition |

Eine `Camera3D` außerhalb einer 3D-Szene, die per `camera="id"` referenziert wird, wandert als erstes Kind in diese Szene.

## Stabile IDs

Nodes ohne `id` erhalten eine ID aus Typ und Baumposition:

- oberste Ebene: `<typ>-<n>`, z. B. `text-2` für den zweiten Text;
- darunter: `<eltern-id>-<typ>-<n>`, z. B. `group-1-rect-1`;
- Masken: `<id>-mask`.

`n` zählt Geschwister desselben Typs ab 1. Für Studio-Änderungen im Code braucht ein Element ein eigenes `id`-Attribut.

## Animations-Helfer

`animate`, `keyframes`, `spring`, `expr`, `ref`, `stagger`, `sequence`.
`spring({ frame, from?, to?, fps?, config? })` (Remotion-Form) liefert sofort eine Zahl.
Ohne `fps` gilt die fps der Composition.

## Quellpositionen

Mit `jsxDev: true` speichert jede Node `meta.source = { file, line, column }`.
