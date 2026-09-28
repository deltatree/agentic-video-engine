# ADR 0017: Eigener Schema-Interpreter für Fehlermeldungen

- Status: angenommen
- Datum: 2026-09-28

## Kontext

Standard-Validatoren melden bei Unions jeden verworfenen Zweig.

## Entscheidung

`validateValue` interpretiert die TypeBox-Ausgabe und wählt den passenden Union-Zweig (Animationsschlüssel, Diskriminator `type`, Werttyp). Ein Property-Test vergleicht ihn mit TypeBox `Value.Check`.

## Folgen

Agents bekommen genau eine präzise Meldung mit Vorschlag.
