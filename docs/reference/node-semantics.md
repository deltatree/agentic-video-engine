# Render semantics of the node types

[Deutsche Fassung](node-semantics.de.md)

This document is the binding contract for all renderers (Skia, PixiJS, browser, Three.js, Blender).
Shared calculation rules live as pure functions in `@agentic-video/core` (`semantics.ts`, `props.ts`, `matrix.ts`, `path.ts`).
A renderer that deviates reports it as a capability limitation.

## 1. General rules

### 1.1 Output of a renderer

- A renderer returns an `RgbaImage` in output size `request.width × request.height`.
- Format: 8 bits per channel, **premultiplied alpha**, sRGB-encoded, rows from top to bottom.
- The background is transparent. The compositor applies the composition background color.
- Preview scaling: the renderer prepends `scale(request.scale)` to all transformations.

### 1.2 Coordinates and transform (ADR 0004)

- The 2D unit is the pixel of the composition. Origin top left, y down.
- `x`, `y` is the top left corner of the node's **local box**.
- Rotation, skew and scale act around `origin` (relative to the box, default `{ x: 0.5, y: 0.5 }`).
- `localMatrix(node, measured)` from `@agentic-video/core` computes the local matrix.
- A motion path (`motionPath`) adds its point to `x`/`y` (see `getTransform`).
- Children draw in the coordinate system of their parent: `world = parent matrix × local matrix`.
- Angles are always degrees.

### 1.3 Local box per type

| Type | Box |
|---|---|
| `rect`, `ellipse`, `image`, `video`, `svg`, `sprite`, `lottie`, `shader`, `particles`, `html`, `scene3d`, `blender` | `(0, 0, width, height)` |
| `group`, `layer`, `sequence` | `(0, 0, width ?? 0, height ?? 0)` |
| `line` | Hull of `from` and `to` |
| `polyline`, `polygon` | Hull of the points |
| `path` | Hull of all coordinates (`pathBounds`) |
| `text`, `rich-text` | `(0, 0, measured width, measured height)`; with `width` the width is fixed |

If `image`, `video`, `svg`, `sprite` have no size, the intrinsic size of the asset applies.

### 1.4 Appearance

| Property | Meaning | Default |
|---|---|---|
| `opacity` | Multiplies the opacity of the node and all its children (as a group). | 1 |
| `zIndex` | Drawing order among siblings (animatable). Higher values lie on top; equal values keep the document order (stable sort). The evaluated scene, the planner and the scene tree use the sorted order. | 0 |
| `blendMode` | Blends the node with everything below it, including layers of other backends and the composition background color (in the working color space). Groups and `layer` are isolated: their children blend only with content of the same group. See 1.6. | `normal` |
| `filters` | List, applied in order. `blur.radius` is the standard deviation in pixels (like CSS `blur()`). `brightness`, `contrast`, `saturate`, `grayscale`, `sepia`, `invert`, `hue-rotate` as in CSS. | – |
| `shadow` | Drop shadow of the whole node. `blur` is the standard deviation. | – |
| `mask` | The mask node lives in the **local coordinate system of the masked node** (it moves with it). `alpha`: opacity of the mask; `luminance`: brightness × alpha. `invert` inverts. Mask and masked node may use different backends (1.6). | `alpha` |
| `clip` (only `group`) | Clips children to the box of the group. | `false` |
| `reveal` (from transitions) | Clips the node to `revealShape(reveal, box)` in local box coordinates. For groups without a size, `box` is the hull of the children. Applies to all node types, including `layer`, `scene3d`, `html`, `blender` (1.6). | – |

### 1.5 Fill and stroke

- `fill` and `stroke` are a color or a gradient.
- Without `fill` and `stroke` the shape fills with `#FFFFFF` (`effectiveFill`).
- Gradients use relative coordinates by default (`units: 'relative'`): 0..1 of the box; `units: 'pixels'` uses local pixels.
  - `linear`: `start` default `{0, 0}`, `end` default `{1, 0}`.
  - `radial`: `center` default `{0.5, 0.5}`, `radius` default 0.5, relative to the larger box side.
  - `conic`: `center` default `{0.5, 0.5}`, `angle` in degrees, 0 = right, clockwise.
- `strokeWidth` defaults to 1 when `stroke` is set. The stroke is centered on the edge.
- `strokeCap` default `butt`, `strokeJoin` default `miter`.
- `strokeDash`: dash and gap lengths in pixels.
- `trimStart`, `trimEnd` (0..1) and `trimOffset` (0..1, cyclic) cut the stroke along the path length.

### 1.6 Compositing across backend boundaries (frame plan)

The planner (`planFrame`) splits the scene into layers; every backend renders its layers, the compositor puts them together.
So that no property gets lost at a backend boundary, these rules apply:

- **Groups** with descendants from several backends, and groups whose children need a backend without its own group support (`scene3d`, `html`, `blender`), are composited by the compositor. It applies in this order: children → `colorSpace` (only `layer`) → `effects` → `crop` → `clip` → mask → `filters` → `shadow` → reveal → transform → `opacity` → `blendMode`. The compositor computes `filters` and `shadow` like the Skia backend (story 17.11): color filters on unpremultiplied, sRGB-encoded values, `blur` and shadows on premultiplied sRGB values, lengths in local units (converted to pixels with the preview scale or the node matrix).
- **Isolated nodes:** a node is isolated when its backend cannot apply a property across the layer boundary:
  - `scene3d`, `html`, `blender` with `blendMode ≠ normal`, `mask` or a reveal;
  - 2D nodes (Skia, PixiJS) with `blendMode ≠ normal` when content outside their layer lies below them (another layer or the composition background color);
  - 2D nodes whose mask node needs another backend.

  The backend then renders the node without these properties (with transform and opacity); the compositor applies reveal, mask (transformed with the node matrix) and blend mode to the finished layer. Reveal edges are smoothed with 4 × 4 samples.
- **`filters` and `shadow` on `scene3d` and `blender`:** Three.js and Blender do not draw them. The compositor applies them to the finished layer (order mask → `filters` → `shadow` → reveal), isolated or not; blur radii scale with √|det| of the node matrix, shadow offsets with its linear part. 2D backends and `html` (CSS) draw them themselves.
- Blend modes inside a 2D layer without a background color are computed by the backend itself (Skia/PixiJS).
- **2D backend (`settings.renderer2d`):** the default is Skia. With `renderer2d: 'pixi'` PixiJS renders every 2D node whose own properties it can draw; Skia renders all others (per-node fallback, info `OV_PIXI_FALLBACK`, ADR 0018). If Pixi cannot draw the properties of a group, Skia renders the whole group. An explicit `renderer` on the node takes precedence.

### 1.7 Color spaces

- Backends deliver sRGB-encoded pixels (1.1). The compositor blends in the **working color space**: `composition.colorSpace`, otherwise `settings.workingColorSpace`, otherwise `srgb`. Effects always compute in linear light.
- `layer.colorSpace` declares how the pixels of the children are encoded: `linear` (linear light) or `rec709` (BT.709 OETF). The compositor reads them with this encoding instead of sRGB and converts them into the working color space. `srgb` is the default and changes nothing.
- `settings.outputColorSpace` encodes the output pixels: `srgb` (default), `rec709` or `linear` (linear light in 8 bits; for further processing, visibly coarser steps in dark tones). The value is part of the frame key. The video tag (`color_trc`) is set by `renderProfile.colorSpace` (default `srgb`); if the two differ, the validator warns with `OV_COLORSPACE_MISMATCH`.

## 2. Node types

### Structure

- **group**: draws children in order. Transform, opacity, filters and mask act on the group image.
- **layer**: like `group`, but always forms its own compositor layer. Additionally `colorSpace` (1.7), `crop`, `effects`, `motionBlur`.
- **sequence**: plays its children one after another and becomes a `group` before rendering (T9). Every child needs `timing.duration` (a `composition-ref` without a duration takes the duration of its composition); without it the child is skipped with `OV_SEQUENCE_DURATION`. `timing.from` of the children is replaced (`OV_SEQUENCE_FROM_IGNORED`). Between child i and i + 1 applies `transitions[i] ?? between ?? { type: 'cut' }`:
  - `cut`: child i + 1 starts at the end of child i.
  - A transition with `type` (like `transition`: `fade`, `slide-*`, `wipe-*`, `zoom-in`, `zoom-out`, `blur`, `iris`) and `duration` d: child i + 1 starts d before the end of child i (d is limited to the shorter of the two durations). Child i + 1 gets the transition as `in` and lies above child i, which stays until the end of the overlap (cross-fade; for opaque clips exactly a crossfade). With `slide-*` child i gets the same transition as `out` (push: both clips move in the same direction).
  - Own `transition` entries of the children apply where there is no sequence transition (for example `in` of the first and `out` of the last child).
  - The total duration is the sum of the child durations minus the overlaps.
- **composition-ref**, **component**, **subtitles**: are expanded before rendering. Renderers never see them.
  A `composition-ref` brings the audio of its composition (tracks, video audio, further refs, recursively), shifted and mapped with the local time of the ref (`from`, `speed`, `reverse`, `remap` act as for video audio). Loudness and limiter of the nested composition do not apply; only the outer one is mastered.

### Shapes

- **rect**: rectangle `width × height`. `cornerRadius` as a number or `[top left, top right, bottom right, bottom left]`.
- **ellipse**: ellipse in the box.
- **line**: segment `from` → `to`. Without `stroke` it draws with the `fill` color as a stroke of width `strokeWidth ?? 1`.
- **polyline**: open line; by default only a stroke with color `#FFFFFF`, width 1, when neither `fill` nor `stroke` is set.
- **polygon**: closed area.
- **path**: SVG path data `d`, `fillRule` default `nonzero`.

### Text

- `fontFamily` default: `settings.defaultFont`, otherwise `Inter`. Emoji fall back to `Noto Color Emoji`.
- `fontSize` 48, `fontWeight` 400, `fontStyle` normal, `lineHeight` 1.2, `letterSpacing` 0, `textAlign` `left`, `direction` `auto`.
- Without `width` the text breaks only at `\n`; the box is as wide as the longest line.
- With `width` the text breaks at word boundaries. `textAlign` aligns within `width`.
- `maxLines` limits the lines; with `ellipsis` the last line is shortened. More text than space is **overflow** (diagnostic `OV_TEXT_OVERFLOW`).
- `fontFeatures` (for example `{ liga: 0, tnum: 1 }`) and `fontVariations` (for example `{ wght: 650 }`) go straight to text shaping.
- `textPath`: glyphs follow the path from `offset` pixels. `background` then becomes a band along the path (line height plus `paddingY`, `paddingX` before and after the text, `radius > 0` rounds the ends); `textAnimation` acts per unit around its center on the path.
- `fill` as a gradient fills the text box; `stroke` draws glyph outlines.
- `textAnimation`: every unit (character, word, line) goes from `from` to the normal state. `textUnitState(node, i, count, localFrame, fps)` computes the state; `splitTextUnits` the split. Offset and scale act around the center of the unit. Unit i starts at `starts[i]`, otherwise at `start + position · stagger`.
- **subtitles** (macro): see `packages/subtitles/README.md` – ASS styles, line breaking with real text measurement, karaoke fill in the current word, `textAnimation` per word from its word time, `fromAudio` transcribed before rendering.
- `background`: box behind the measured text (`color`, `paddingX`, `paddingY`, `radius`); with `perLine: true` one box per line. The box belongs to the node (opacity, transform, mask apply).
- `rich-text`: `spans` with their own styles; style properties of the node are the default for all spans.

### Media

- **image**: `fit` default `fill` when a size is set. `contain`/`cover` center. `smoothing` default `linear`. Animated images (GIF, APNG, animated WebP) are normalized by the asset pipeline into a lossless video; the node then shows the frame at the local time, looping over the duration of the image (video frame path as for `video`, `loop: true`, muted). Animated WebP needs an FFmpeg that decodes animated WebP (FFmpeg 6.1 cannot; the import then reports an error).
- **video**: source time = `startFrom + localTime · playbackRate`; with `loop` modulo duration, otherwise clamped. `AssetResolver.videoFrame(asset, seconds)` delivers the image.
  Audio (without `muted`): in simple embedding (only `timing.from`/`duration` on the node and all ancestors, not inside `sequence` or components) it is a clip; `playbackRate` changes the tempo at the same pitch. Otherwise (`speed`, `reverse`, `remap`, `loop`, `pingPong`, `hold` on the node or an ancestor) the audio follows the source time of the image, sampled per frame and linearly interpolated, and runs like tape (pitch follows speed, `reverse` plays backwards).
- **svg**: asset or `markup` scaled into the box (`fit` default `contain`). Drawn are shapes, `g`, `use`, gradients, `pattern`, `clipPath` (`clipPathUnits`, `clip-rule`), `mask` (luminance × alpha, `mask-type: alpha`, mask region), `image` and `text` with `tspan` (`x`, `y`, `dx`, `dy`, own style). `<image>` loads only data URIs (PNG, JPEG, WebP, GIF, BMP) and image assets of the project (`asset:<id>` or a path relative to the SVG file inside the project); the check reports other sources as `OV_SVG_IMAGE_BLOCKED`. It reports unsupported elements (for example `filter`, `foreignObject`) as `OV_SVG_UNSUPPORTED`, also for SVG assets (`checkProject`).
- **sprite**: raster image with `columns × rows` cells, numbered row by row. Index = `frame`, otherwise `floor(localTime · frameRate)`; with `loop` modulo `frameCount`, otherwise clamped.
- **lottie**: time = `localTime · speed + frameOffset / lottieFps`; with `loop` modulo duration.

### Effects

- **shader**: fills the box. SkSL signature `half4 main(float2 coord)`, `coord` in local pixels. Uniforms `time` (seconds), `frame`, `resolution` (float2) plus your own. `sksl` (Skia) and `glsl` (PixiJS, `mainImage(out vec4, in vec2)`) may be present at the same time; every backend takes its own source (ADR 0020).
- **particles**: state from `particles2d(node, localTimeSeconds, fps)`. Shape `circle` (default), `square`, `spark` (stroke in the direction of motion, length = 3 × size). Coordinates relative to the box.

### Browser

- **html**: Chromium renders `html` + `css` into a box `width × height`; the box is placed with the node matrix. The page receives the time per frame via `window.openvideo` (see the browser renderer docs). CSS animations are paused and set to the local time; for the capture their values are committed as inline styles and the animations released, so the pixels never depend on previously rendered frames or on Chromium's compositor layers (they are restored before the next frame). Scripts run only when explicitly allowed (`--trusted`, ADR 0008); without scripts `<canvas>` (2D, WebGL, WebGPU) and custom elements without declarative shadow DOM stay empty – `openvideo validate` warns with `OV_HTML_CANVAS_NO_SCRIPTS` or `OV_HTML_WEB_COMPONENTS_NO_SCRIPTS`.

### 3D

- **scene3d**: renders children with Three.js into a box `width × height`, placed with the node matrix. `backend`: `auto` (default; WebGPU when a test render in Chromium succeeds, otherwise WebGL2, always WebGL2 for GLSL `ShaderMaterial`), `webgpu` or `webgl2`. Image textures above the GPU maximum are an error `OV_THREE_TEXTURE_TOO_LARGE`; with `textureDownscale: true` they are downscaled. `background` default transparent. `camera` default: first `camera3d`; without a camera a perspective camera at `[0, 0, 5]` looking at the origin.
- **camera3d**: `fov` 50, `near` 0.1, `far` 1000, `projection` `perspective`. `target` sets the viewing direction, otherwise `rotation` applies.
- **light3d**: `intensity` 1, `color` `#FFFFFF`.
- **mesh3d**, **model3d**, **instances3d**, **particles3d**, **group3d**: position in meters, rotation XYZ in degrees.
- **blender**: like `scene3d`, rendered with Blender. `particles3d` is transferred as instances (one unlit sphere per living particle, same formula as Three.js). `motionBlur: true`: the frame render passes the states at ±0.25 frames (shutter ½ frame); Blender interpolates position, rotation and scale linearly in between.

## 3. Examples per node type

One small, valid JSON example per node type. `capabilities.get` (field `example`), `docs/ai/capabilities.json` and the JSON Schema (`examples` per `Node_<type>`) return the same examples.
Complete example projects live in [`examples/`](../../examples/README.md).

<!-- node-examples:start -->

Generated by `scripts/generate-docs.mjs` from `NODE_EXAMPLES` (`@agentic-video/schema`). Every example is valid; `exampleProject(type)` embeds it in a project with the composition `main` (640 × 360, 30 fps, 2 s). 3D nodes sit there in a `scene3d` with camera and light. References: assets `logo` (image, `assets/logo.png`), `clip` (video, `assets/clip.mp4`), `walk-sheet` (image, `assets/walk-sheet.png`), `spinner` (lottie, `assets/spinner.json`), `robot` (model, `assets/robot.glb`); subtitle track `captions`; composition `intro`.

### `group`

Groups children with a shared transform.

```json
{
  "id": "badge",
  "type": "group",
  "x": 220,
  "y": 148,
  "children": [
    { "id": "badge-bg", "type": "rect", "width": 200, "height": 64, "cornerRadius": 32, "fill": "#FF5A1F" },
    {
      "id": "badge-label",
      "type": "text",
      "text": "NEW",
      "y": 12,
      "width": 200,
      "textAlign": "center",
      "fontSize": 32,
      "fontWeight": 700,
      "fill": "#FFFFFF"
    }
  ]
}
```

### `layer`

Compositing boundary: always rendered as its own layer.

```json
{
  "id": "glow-layer",
  "type": "layer",
  "blendMode": "screen",
  "effects": [{ "type": "glow", "radius": 16, "intensity": 0.8 }],
  "children": [{ "id": "orb", "type": "ellipse", "x": 220, "y": 80, "width": 200, "height": 200, "fill": "#4F8CFF" }]
}
```

### `composition-ref`

Nested composition, evaluated at the remapped local time.

```json
{
  "id": "intro-ref",
  "type": "composition-ref",
  "composition": "intro",
  "timing": { "from": 0, "duration": "2s", "speed": 1 }
}
```

### `sequence`

Plays its children one after another (each needs timing.duration, or is a composition-ref). Consecutive children overlap by the transition duration and cross over automatically.

```json
{
  "id": "slides",
  "type": "sequence",
  "between": { "type": "fade", "duration": "0.5s" },
  "children": [
    {
      "id": "slide-1",
      "type": "rect",
      "width": 640,
      "height": 360,
      "fill": "#1B2A4A",
      "timing": { "duration": "1.25s" }
    },
    {
      "id": "slide-2",
      "type": "rect",
      "width": 640,
      "height": 360,
      "fill": "#FF5A1F",
      "timing": { "duration": "1.25s" }
    }
  ]
}
```

### `component`

Reusable component expanded at evaluation time.

```json
{
  "id": "name-tag",
  "type": "component",
  "component": "LowerThird",
  "props": { "name": "Ada Lovelace", "role": "Engineer" },
  "x": 40,
  "y": 250
}
```

### `rect`

Rectangle, optionally rounded.

```json
{
  "id": "card",
  "type": "rect",
  "x": 120,
  "y": 80,
  "width": 400,
  "height": 200,
  "cornerRadius": 24,
  "fill": {
    "type": "linear",
    "stops": [{ "offset": 0, "color": "#FF5A1F" }, { "offset": 1, "color": "#8A2BE2" }],
    "start": { "x": 0, "y": 0 },
    "end": { "x": 1, "y": 1 }
  },
  "stroke": "#FFFFFF",
  "strokeWidth": 4
}
```

### `ellipse`

Ellipse inside the box. Equal width and height = circle.

```json
{
  "id": "dot",
  "type": "ellipse",
  "x": { "$keyframes": [{ "t": 0, "v": 40 }, { "t": "1s", "v": 520, "ease": "easeInOutCubic" }] },
  "y": 140,
  "width": 80,
  "height": 80,
  "fill": "#FF5A1F"
}
```

### `line`

Straight line between two points.

```json
{
  "id": "underline",
  "type": "line",
  "from": { "x": 80, "y": 180 },
  "to": { "x": 560, "y": 180 },
  "stroke": "#FFFFFF",
  "strokeWidth": 8,
  "strokeCap": "round",
  "trimEnd": { "$keyframes": [{ "t": 0, "v": 0 }, { "t": "1s", "v": 1, "ease": "easeOutCubic" }] }
}
```

### `polyline`

Open line through points.

```json
{
  "id": "trend",
  "type": "polyline",
  "points": [[40, 300], [200, 220], [360, 260], [600, 80]],
  "stroke": "#4F8CFF",
  "strokeWidth": 6,
  "strokeJoin": "round"
}
```

### `polygon`

Closed shape through points.

```json
{ "id": "triangle", "type": "polygon", "points": [[320, 60], [520, 300], [120, 300]], "fill": "#FFC857" }
```

### `path`

Vector path from SVG path data.

```json
{
  "id": "check",
  "type": "path",
  "d": "M 200 180 L 280 260 L 440 100",
  "stroke": "#3DDC97",
  "strokeWidth": 16,
  "strokeCap": "round",
  "strokeJoin": "round"
}
```

### `text`

Single-style text with wrapping, shaping and per-unit animation.

```json
{
  "id": "headline",
  "type": "text",
  "text": "Hello OpenVideo",
  "x": 40,
  "y": 140,
  "width": 560,
  "textAlign": "center",
  "fontSize": 56,
  "fontWeight": 700,
  "fill": "#F5F7FF",
  "textAnimation": { "unit": "char", "stagger": 2, "duration": 12, "from": { "opacity": 0, "y": 20 } }
}
```

### `rich-text`

Text with differently styled spans.

```json
{
  "id": "tagline",
  "type": "rich-text",
  "x": 40,
  "y": 150,
  "width": 560,
  "textAlign": "center",
  "fontSize": 44,
  "fill": "#F5F7FF",
  "spans": [{ "text": "Video as " }, { "text": "code", "fill": "#FF5A1F", "fontWeight": 800 }]
}
```

### `image`

Raster image from an asset.

```json
{
  "id": "logo-image",
  "type": "image",
  "asset": "logo",
  "x": 220,
  "y": 80,
  "width": 200,
  "height": 200,
  "fit": "contain"
}
```

### `video`

Video from an asset; its audio joins the mix unless muted.

```json
{
  "id": "clip-video",
  "type": "video",
  "asset": "clip",
  "width": 640,
  "height": 360,
  "fit": "cover",
  "muted": true
}
```

### `svg`

SVG from an asset or inline markup.

```json
{
  "id": "star",
  "type": "svg",
  "x": 270,
  "y": 130,
  "width": 100,
  "height": 100,
  "markup": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\"><path d=\"M12 2l3 7h7l-5.5 4 2 7-6.5-4.5L5.5 20l2-7L2 9h7z\" fill=\"#FFC857\"/></svg>"
}
```

### `sprite`

Frame from a sprite sheet grid.

```json
{
  "id": "walker",
  "type": "sprite",
  "asset": "walk-sheet",
  "columns": 4,
  "rows": 1,
  "frameRate": 8,
  "loop": true,
  "x": 270,
  "y": 130,
  "width": 100,
  "height": 100
}
```

### `lottie`

Lottie animation, frame-exact.

```json
{
  "id": "spinner-anim",
  "type": "lottie",
  "asset": "spinner",
  "x": 220,
  "y": 80,
  "width": 200,
  "height": 200,
  "loop": true
}
```

### `shader`

Custom shader filling the box. Uniforms `time`, `frame`, `resolution` are provided.

```json
{
  "id": "plasma",
  "type": "shader",
  "width": 640,
  "height": 360,
  "sksl": "uniform float time;\nuniform float2 resolution;\nhalf4 main(float2 coord) {\n  float2 uv = coord / resolution;\n  return half4(half(uv.x), half(uv.y), half(0.5 + 0.5 * sin(time * 3.0)), 1.0);\n}"
}
```

### `particles`

Stateless 2D particle system: particle state is a pure function of time and seed.

```json
{
  "id": "sparks",
  "type": "particles",
  "width": 640,
  "height": 360,
  "count": 200,
  "seed": 7,
  "emitter": { "x": 320, "y": 180, "radius": 10, "shape": "circle" },
  "lifetime": { "min": 0.5, "max": 1.5 },
  "speed": { "min": 60, "max": 180 },
  "angle": { "min": 0, "max": 360 },
  "size": { "start": 6, "end": 1 },
  "color": { "start": "#FFC857", "end": "#FF5A1F" }
}
```

### `html`

HTML/CSS/SVG/Canvas/WebGL content rendered by Chromium.

```json
{
  "id": "html-card",
  "type": "html",
  "x": 120,
  "y": 80,
  "width": 400,
  "height": 200,
  "html": "<div class=\"card\">Hello from HTML</div>",
  "css": ".card { font: 600 40px sans-serif; color: #FFFFFF; padding: 72px 40px; }",
  "background": "#1B2A4A"
}
```

### `subtitles`

Animated captions from a subtitle track. textAnimation animates each word from its own start time.

```json
{
  "id": "captions-view",
  "type": "subtitles",
  "track": "captions",
  "fontSize": 36,
  "style": "karaoke",
  "color": "#FFFFFF",
  "highlightColor": "#FFC857",
  "position": "bottom"
}
```

### `scene3d`

Real-time 3D scene rendered with Three.js.

```json
{
  "id": "stage",
  "type": "scene3d",
  "width": 640,
  "height": 360,
  "camera": "cam",
  "background": "#0B0D12",
  "children": [
    { "id": "cam", "type": "camera3d", "position": [0, 1.5, 5], "target": [0, 0, 0], "fov": 45 },
    {
      "id": "key",
      "type": "light3d",
      "kind": "directional",
      "position": [3, 5, 4],
      "intensity": 2.5,
      "castShadow": true
    },
    {
      "id": "cube",
      "type": "mesh3d",
      "geometry": { "type": "box" },
      "material": { "color": "#FF5A1F", "roughness": 0.4 },
      "rotation": [20, 35, 0]
    }
  ]
}
```

### `blender`

Offline 3D scene rendered with Blender (Cycles or Eevee).

```json
{
  "id": "hero-shot",
  "type": "blender",
  "width": 640,
  "height": 360,
  "engine": "eevee",
  "samples": 16,
  "camera": "cam",
  "children": [
    { "id": "cam", "type": "camera3d", "position": [0, 1.5, 5], "target": [0, 0, 0], "fov": 45 },
    {
      "id": "key",
      "type": "light3d",
      "kind": "directional",
      "position": [3, 5, 4],
      "intensity": 2.5,
      "castShadow": true
    },
    {
      "id": "ball",
      "type": "mesh3d",
      "geometry": { "type": "sphere", "radius": 1 },
      "material": { "color": "#4F8CFF", "metalness": 0.2, "roughness": 0.3 }
    }
  ]
}
```

### `camera3d`

3D camera.

```json
{ "id": "cam", "type": "camera3d", "position": [0, 1.5, 5], "target": [0, 0, 0], "fov": 45 }
```

### `light3d`

3D light.

```json
{
  "id": "key",
  "type": "light3d",
  "kind": "directional",
  "position": [3, 5, 4],
  "intensity": 2.5,
  "castShadow": true
}
```

### `mesh3d`

3D mesh with built-in geometry.

```json
{
  "id": "spinning-cube",
  "type": "mesh3d",
  "geometry": { "type": "box", "width": 1, "height": 1, "depth": 1 },
  "material": { "color": "#FF5A1F", "roughness": 0.4 },
  "rotation": { "$keyframes": [{ "t": 0, "v": [0, 0, 0] }, { "t": "2s", "v": [0, 180, 0] }] }
}
```

### `model3d`

glTF, GLB or OBJ model.

```json
{ "id": "robot-model", "type": "model3d", "asset": "robot", "position": [0, -1, 0], "scale": [1, 1, 1] }
```

### `instances3d`

Many instances of one mesh.

```json
{
  "id": "dot-field",
  "type": "instances3d",
  "geometry": { "type": "sphere", "radius": 0.08 },
  "material": { "color": "#4F8CFF" },
  "count": 100,
  "seed": 3,
  "layout": { "type": "grid", "columns": 10, "spacing": 0.3 },
  "position": [-1.35, -1.35, 0]
}
```

### `particles3d`

Stateless 3D particle system.

```json
{
  "id": "dust",
  "type": "particles3d",
  "count": 500,
  "seed": 1,
  "emitter": { "shape": "sphere", "size": 2 },
  "lifetime": { "min": 1, "max": 3 },
  "speed": { "min": 0.1, "max": 0.5 },
  "size": { "start": 0.05, "end": 0 },
  "color": { "start": "#FFFFFF", "end": "#4F8CFF" },
  "additive": true
}
```

### `group3d`

Groups 3D nodes.

```json
{
  "id": "rig",
  "type": "group3d",
  "rotation": { "$keyframes": [{ "t": 0, "v": [0, 0, 0] }, { "t": "2s", "v": [0, 90, 0] }] },
  "children": [
    {
      "id": "rig-left",
      "type": "mesh3d",
      "geometry": { "type": "sphere", "radius": 0.4 },
      "position": [-1, 0, 0],
      "material": { "color": "#FF5A1F" }
    },
    {
      "id": "rig-right",
      "type": "mesh3d",
      "geometry": { "type": "sphere", "radius": 0.4 },
      "position": [1, 0, 0],
      "material": { "color": "#4F8CFF" }
    }
  ]
}
```

<!-- node-examples:end -->
