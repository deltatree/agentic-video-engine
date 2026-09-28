# ADR 0013: Browser-Renderer mit eigener Origin, virtueller Zeit, Netzblockade

- Status: angenommen
- Datum: 2026-09-28

## Kontext

WebGPU braucht eine HTTP-Origin (Probelauf). Browser-Uhren sind nicht deterministisch.

## Entscheidung

Chromium lädt die Laufzeit von einem lokalen HTTP-Server. Andere Anfragen werden blockiert. `Date`, `performance.now`, `requestAnimationFrame`, `Math.random` sind virtualisiert. Web Animations werden pausiert und gesetzt.

## Folgen

DOM-, PixiJS- und Three.js-Frames sind reproduzierbar (Probelauf: bitgleich über zwei Starts).
