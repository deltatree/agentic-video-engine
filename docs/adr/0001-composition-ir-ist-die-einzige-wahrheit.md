# ADR 0001: Composition IR ist die einzige Wahrheit

- Status: angenommen
- Datum: 2026-09-28

## Kontext

Viele Bibliotheken (React, Three.js, PixiJS, Chromium, Blender) könnten das Produktmodell prägen. Dann hinge jedes Video an einer Bibliothek.

## Entscheidung

Jede Eingabe (TSX, JSON, Studio, Patch, Import) wird zur versionierten Composition IR. Renderer lesen nur Evaluated Scenes. Das JSON Schema entsteht aus einer einzigen TypeBox-Definition in `@agentic-video/schema`.

## Folgen

Renderer sind austauschbar. Agents arbeiten ohne Codeausführung mit JSON. Jede neue Fähigkeit braucht zuerst ein IR-Feld.
