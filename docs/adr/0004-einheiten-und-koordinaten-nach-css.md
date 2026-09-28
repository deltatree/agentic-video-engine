# ADR 0004: Einheiten und Koordinaten nach CSS

- Status: angenommen
- Datum: 2026-09-28

## Kontext

Agents kennen CSS. Gemischte Konventionen (Grad/Radiant, Ursprung) erzeugen Fehler.

## Entscheidung

2D: Pixel, Ursprung oben links, y nach unten, `x`/`y` ist die linke obere Ecke der Box, Rotation und Skalierung um `origin` (Standard Mitte). Winkel immer in Grad. 3D: rechtshändig, y nach oben, Meter. Farben sRGB `#RRGGBB[AA]`.

## Folgen

Eine einzige Transform-Funktion (`nodeMatrix`) gilt für alle Renderer und den Compositor.
