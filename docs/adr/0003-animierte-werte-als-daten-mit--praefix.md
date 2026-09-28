# ADR 0003: Animierte Werte als Daten mit $-Präfix

- Status: angenommen
- Datum: 2026-09-28

## Kontext

Werte können Objekte sein (z. B. `scale: {x, y}`). Animationen dürfen nicht mit Objektwerten kollidieren.

## Entscheidung

Eine Property ist ein Literal oder genau eines von `$keyframes`, `$spring`, `$expr`, `$sampled`, `$ref`. Das Easing eines Keyframes gilt für das Segment, das auf ihn zuläuft. Standard-Easing ist `linear`.

## Folgen

Validierung erkennt Animationen eindeutig. Patches können Keyframes gezielt ändern.
