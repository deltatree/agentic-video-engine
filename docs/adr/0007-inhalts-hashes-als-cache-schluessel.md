# ADR 0007: Inhalts-Hashes als Cache-Schlüssel

- Status: angenommen
- Datum: 2026-09-28

## Kontext

Teil-Neurender (A23) braucht verlässliche Schlüssel.

## Entscheidung

SHA-256 über kanonisches JSON plus Backend-Versionen. Der Frame-Schlüssel entsteht aus der Evaluated Scene; Zeit fließt nur für zeitabhängige Node-Typen ein.

## Folgen

Unveränderte Frames kommen aus dem Cache. Ein Backend-Update erneuert alle betroffenen Frames.
