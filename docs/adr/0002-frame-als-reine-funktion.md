# ADR 0002: Frame als reine Funktion

- Status: angenommen
- Datum: 2026-09-28

## Kontext

Parallele Worker, Caching und Pixel-Tests brauchen identische Frames unabhängig von Reihenfolge und Zeitpunkt.

## Entscheidung

`evaluateScene(project, compositionId, frame, seed)` ist rein. Zufall kommt nur aus zustandslosem `random(seed, …)`. Renderer halten keinen Zustand zwischen Frames außer inhaltsadressierten Caches.

## Folgen

Frames sind beliebig verteilbar. Simulationen mit Zustand (z. B. Partikel) müssen geschlossen berechnet werden.
