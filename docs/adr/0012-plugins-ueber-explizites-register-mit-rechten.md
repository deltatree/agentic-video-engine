# ADR 0012: Plugins über explizites Register mit Rechten

- Status: angenommen
- Datum: 2026-09-28

## Kontext

Globale Singletons und unkontrollierte Erweiterungen verbieten A32 und A49.

## Entscheidung

`Registry` ist ein Objekt ohne globalen Zustand. Plugins deklarieren `permissions`; ihr Kontext enthält nur freigegebene Dienste.

## Folgen

Plugins laufen im Prozess und sind vertrauenswürdiger Code; die Rechte begrenzen die angebotenen APIs, sie sind keine Sandbox.
