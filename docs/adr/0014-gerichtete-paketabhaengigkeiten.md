# ADR 0014: Gerichtete Paketabhängigkeiten

- Status: angenommen
- Datum: 2026-09-28

## Kontext

`core` darf nie von Renderern abhängen (A34).

## Entscheidung

Erlaubte Kanten stehen in `scripts/dependency-rules.json`; `scripts/check-deps.mjs` prüft sie und sucht Zyklen.

## Folgen

Verstöße brechen den Build.
