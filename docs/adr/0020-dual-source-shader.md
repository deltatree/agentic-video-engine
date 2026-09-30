# ADR 0020: Dual-Source-Shader statt Transpiler

- Status: angenommen
- Datum: 2026-09-30

## Kontext

`shader`-Nodes brauchen eine Shader-Sprache. Skia (CanvasKit) kompiliert **SkSL** (`half4 main(float2 coord)`), PixiJS in WebGL **GLSL ES 3.0** (`mainImage(out vec4, in vec2)` im Shadertoy-Stil). Eine portable Sprache fehlte (Audit 2026-09-30, §9). Ein Transpiler GLSL → SkSL (oder umgekehrt) wäre groß, fehleranfällig und müsste Unterschiede in Präzision, Koordinatenursprung und eingebauten Funktionen verbergen.

## Entscheidung

- **Kein Transpiler.** Eine `shader`-Node darf `sksl` **und** `glsl` gleichzeitig tragen; mindestens eine Quelle ist Pflicht (`OV_SCHEMA_REQUIRED`).
- **Jedes Backend nimmt seine Quelle:** Skia nutzt `sksl`, PixiJS nutzt `glsl`. Beide erhalten dieselben Uniforms (`time`, `frame`, `resolution` und `uniforms`).
- Fehlt dem gewählten Backend seine Quelle:
  - Skia (Standard): Fehler `OV_SKIA_UNSUPPORTED` mit Vorschlag, `sksl` zu ergänzen oder `renderer: 'pixi'` zu setzen.
  - Pixi über `renderer2d: 'pixi'`: Rückfall der Node auf Skia (ADR 0018, `OV_PIXI_FALLBACK`), sofern `sksl` vorhanden ist.
  - Pixi über explizites `renderer: 'pixi'`: Fehler `OV_PIXI_UNSUPPORTED` (`shader.sksl`).
- Beide Quellen sollen dasselbe Bild beschreiben; ein bitgleiches Ergebnis ist nicht zugesagt (unterschiedliche Rasterung und Präzision).

## Folgen

Autoren und Agents schreiben einen Shader bei Bedarf zweimal, dafür ist das Verhalten explizit und prüfbar: `openvideo check` zeigt, welches Backend welche Quelle nutzt. Ein Projekt mit beiden Quellen rendert mit Skia und mit Pixi ohne Rückfall.
