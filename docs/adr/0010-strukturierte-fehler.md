# ADR 0010: Strukturierte Fehler

- Status: angenommen
- Datum: 2026-09-28

## Kontext

Rohe Fehler wie „WebGL error 1282“ helfen weder Menschen noch Agents (A40).

## Entscheidung

Alle Fehler sind `OpenVideoError` mit Diagnose (code, errorClass, problem, Ort, details, suggestions). Kein leerer catch.

## Folgen

Fehler sind maschinenlesbar und nennen Lösungen.
