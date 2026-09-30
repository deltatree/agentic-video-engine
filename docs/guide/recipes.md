# Recipes

[Deutsche Fassung](recipes.de.md)

Every recipe is a small, complete piece of IR. A test checks every JSON block of this file against the schema.
Blocks with one node can be inserted with `addNode`; blocks with `patches` with `composition.patch`.

## Create a headline and fade it in between frame 20 and 45

```json
{ "id": "headline", "type": "text", "text": "The future is programmable.", "fontSize": 92, "fontWeight": 700,
  "x": 120, "y": 760, "width": 1680,
  "opacity": { "$keyframes": [{ "t": 20, "v": 0 }, { "t": 45, "v": 1, "ease": "easeOutCubic" }] } }
```

## Shrink the headline to 82 px and move it up by 40 px

```json
{ "patches": [
  { "op": "setProperty", "nodeId": "headline", "property": "fontSize", "value": 82 },
  { "op": "setProperty", "nodeId": "headline", "property": "y", "value": 720 }
] }
```

## Move the camera slowly towards the product

```json
{ "id": "stage", "type": "scene3d", "width": 1920, "height": 1080, "camera": "cam",
  "children": [
    { "id": "cam", "type": "camera3d", "fov": 40, "target": [0, 0.5, 0],
      "position": { "$keyframes": [{ "t": 0, "v": [0, 2, 8] }, { "t": "4s", "v": [0, 1, 5], "ease": "easeInOutCubic" }] } },
    { "id": "key", "type": "light3d", "kind": "directional", "position": [5, 8, 3], "intensity": 3 },
    { "id": "fill", "type": "light3d", "kind": "ambient", "intensity": 0.3 },
    { "id": "product", "type": "mesh3d", "geometry": { "type": "torus-knot" },
      "material": { "color": "#FF5A1F", "metalness": 0.4, "roughness": 0.3 },
      "rotation": { "$expr": "[0, time * 23, 0]" } }
  ] }
```

## Show a feature list on the left from second 4

```json
{ "id": "features", "type": "group", "x": 120, "y": 320, "timing": { "from": "4s" },
  "children": [
    { "id": "f1", "type": "text", "text": "• Deterministic frames", "fontSize": 48, "y": 0,
      "opacity": { "$keyframes": [{ "t": 0, "v": 0 }, { "t": "0.4s", "v": 1 }] } },
    { "id": "f2", "type": "text", "text": "• Semantic patches", "fontSize": 48, "y": 80,
      "opacity": { "$keyframes": [{ "t": "0.3s", "v": 0 }, { "t": "0.7s", "v": 1 }] } },
    { "id": "f3", "type": "text", "text": "• Agent-first API", "fontSize": 48, "y": 160,
      "opacity": { "$keyframes": [{ "t": "0.6s", "v": 0 }, { "t": "1s", "v": 1 }] } }
  ] }
```

## Sync points with the voiceover

Set markers at the moments in the voiceover and refer to the markers in keyframes.
After speech synthesis OpenVideo suggests markers `voice-<id>-word-<n>`.

```json
{ "patches": [
  { "op": "setCompositionProperty", "compositionId": "main", "property": "markers", "value": [
    { "id": "point1", "time": "4.2s" }, { "id": "point2", "time": "5.1s" }, { "id": "point3", "time": "6.3s" }
  ] },
  { "op": "setProperty", "nodeId": "f1", "property": "opacity", "value": { "$keyframes": [{ "t": "marker:point1-6f", "v": 0 }, { "t": "marker:point1", "v": 1 }] } }
] }
```

## Transition to the chart scene at second 8

```json
{ "id": "chart-scene", "type": "component", "component": "BarChart",
  "timing": { "from": "8s" },
  "transition": { "in": { "type": "slide-left", "duration": "0.6s", "ease": "easeOutCubic" } },
  "props": { "data": [{ "label": "Q1", "value": 12 }, { "label": "Q2", "value": 19 }, { "label": "Q3", "value": 27 }] },
  "x": 240, "y": 180 }
```

## Code tutorial with typing animation

```json
{ "id": "code", "type": "component", "component": "CodeEditor", "x": 160, "y": 120,
  "props": { "language": "ts", "code": "const frame = render(composition, assets, f, seed);", "typing": true } }
```

## Transparent lower third (export with alpha)

```json
{ "id": "lt", "type": "component", "component": "LowerThird", "x": 96, "y": 860,
  "props": { "name": "Ada Lovelace", "role": "Chief Engine Officer" } }
```

Render with alpha: `openvideo render --format mov --codec prores-4444 --alpha` (composition without `background`).

## Subtitles highlighted word by word

```json
{ "id": "captions", "type": "subtitles", "track": "subs", "style": "word-highlight",
  "fontSize": 44, "highlightColor": "#FFD23F", "box": { "color": "#000000B0", "paddingX": 18, "paddingY": 10, "radius": 12 } }
```

## Color correction for the whole scene

```json
{ "id": "graded", "type": "layer",
  "effects": [{ "type": "color-grade", "exposure": 0.2, "contrast": 1.1, "saturation": 1.15, "temperature": 0.1 }, { "type": "vignette", "amount": 0.35 }],
  "children": [] }
```
