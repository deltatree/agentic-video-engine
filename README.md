# OpenVideo – Agentic Video Engine

OpenVideo ist eine Open-Source-Plattform für **Video-as-Code**, gebaut für Coding Agents.
Ein Agent beschreibt ein Video als JSON oder TSX. OpenVideo rendert Frames, zeigt das Ergebnis und nimmt gezielte Änderungen an.

> Status: in aktiver Entwicklung. Die Kernpakete `schema`, `timeline` und `core` stehen.

## Grundprinzip

```text
frame = render(composition, assets, frame, seed)
```

Jeder Frame ist eine reine Funktion seiner Eingaben. Frame 471 ist bitgleich, egal ob Frame 470 vorher gerendert wurde.

## Pakete

| Paket | Aufgabe |
|---|---|
| `@agentic-video/schema` | Composition IR, JSON Schema, Validierung, Migration |
| `@agentic-video/timeline` | Zeiteinheiten, Easing, Keyframes, Springs, Expressions |
| `@agentic-video/core` | Frame Evaluation, Frame Plan, Patches, Registry, Plugins |

## Entwicklung

Voraussetzung: Node.js 22.13 oder neuer.

```bash
npm ci
npm run check   # Abhängigkeiten, Build, Lint, Tests
```

## Lizenz

Apache-2.0. Siehe [LICENSE](LICENSE).
