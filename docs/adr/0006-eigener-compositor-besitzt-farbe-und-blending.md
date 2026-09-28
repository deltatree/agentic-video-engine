# ADR 0006: Eigener Compositor besitzt Farbe und Blending

- Status: angenommen
- Datum: 2026-09-28

## Kontext

Browser- und Renderer-Farbverhalten weicht ab (A39).

## Entscheidung

Layer-Blending, Masken, Crop, Effekte und Farbraum-Umwandlung laufen im eigenen TypeScript-Compositor. Arbeitsraum `srgb` (Standard) oder `linear`.

## Folgen

Farbe ist reproduzierbar und testbar. Rechenzeit liegt auf der CPU.
