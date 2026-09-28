# Rezepte

Jedes Rezept ist ein kleines, vollständiges Stück IR. Ein Test prüft jeden JSON-Block dieser Datei gegen das Schema.
Blöcke mit einer Node lassen sich per `addNode` einfügen; Blöcke mit `patches` per `composition.patch`.

## Headline erzeugen und zwischen Frame 20 und 45 einblenden

```json
{ "id": "headline", "type": "text", "text": "The future is programmable.", "fontSize": 92, "fontWeight": 700,
  "x": 120, "y": 760, "width": 1680,
  "opacity": { "$keyframes": [{ "t": 20, "v": 0 }, { "t": 45, "v": 1, "ease": "easeOutCubic" }] } }
```

## Headline auf 82 px verkleinern und 40 px nach oben schieben

```json
{ "patches": [
  { "op": "setProperty", "nodeId": "headline", "property": "fontSize", "value": 82 },
  { "op": "setProperty", "nodeId": "headline", "property": "y", "value": 720 }
] }
```

## Kamera langsam auf das Produkt zufahren

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

## Ab Sekunde 4 links eine Feature-Liste zeigen

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

## Punkte mit dem Voiceover synchronisieren

Marker an den Stellen im Voiceover setzen und Keyframes auf die Marker beziehen.
Nach einer Sprachsynthese liefert OpenVideo Marker-Vorschläge `voice-<id>-word-<n>`.

```json
{ "patches": [
  { "op": "setCompositionProperty", "compositionId": "main", "property": "markers", "value": [
    { "id": "point1", "time": "4.2s" }, { "id": "point2", "time": "5.1s" }, { "id": "point3", "time": "6.3s" }
  ] },
  { "op": "setProperty", "nodeId": "f1", "property": "opacity", "value": { "$keyframes": [{ "t": "marker:point1-6f", "v": 0 }, { "t": "marker:point1", "v": 1 }] } }
] }
```

## Bei Sekunde 8 zur Diagramm-Szene überblenden

```json
{ "id": "chart-scene", "type": "component", "component": "BarChart",
  "timing": { "from": "8s" },
  "transition": { "in": { "type": "slide-left", "duration": "0.6s", "ease": "easeOutCubic" } },
  "props": { "data": [{ "label": "Q1", "value": 12 }, { "label": "Q2", "value": 19 }, { "label": "Q3", "value": 27 }] },
  "x": 240, "y": 180 }
```

## Code-Tutorial mit Tipp-Animation

```json
{ "id": "code", "type": "component", "component": "CodeEditor", "x": 160, "y": 120,
  "props": { "language": "ts", "code": "const frame = render(composition, assets, f, seed);", "typing": true } }
```

## Transparentes Lower Third (mit Alpha exportieren)

```json
{ "id": "lt", "type": "component", "component": "LowerThird", "x": 96, "y": 860,
  "props": { "name": "Ada Lovelace", "role": "Chief Engine Officer" } }
```

Render mit Alpha: `openvideo render --format mov --codec prores-4444 --alpha` (Composition ohne `background`).

## Wort für Wort hervorgehobene Untertitel

```json
{ "id": "captions", "type": "subtitles", "track": "subs", "style": "word-highlight",
  "fontSize": 44, "highlightColor": "#FFD23F", "box": { "color": "#000000B0", "paddingX": 18, "paddingY": 10, "radius": 12 } }
```

## Farbkorrektur für die ganze Szene

```json
{ "id": "graded", "type": "layer",
  "effects": [{ "type": "color-grade", "exposure": 0.2, "contrast": 1.1, "saturation": 1.15, "temperature": 0.1 }, { "type": "vignette", "amount": 0.35 }],
  "children": [] }
```
