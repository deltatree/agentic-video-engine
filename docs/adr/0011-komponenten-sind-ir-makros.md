# ADR 0011: Komponenten sind IR-Makros

- Status: angenommen
- Datum: 2026-09-28

## Kontext

Komponenten dürfen nicht nur in TSX existieren, sonst fehlen sie in der JSON-API.

## Entscheidung

Eine Komponente ist eine reine Funktion `(props, ctx) → Node[]`. Die IR speichert `{type: 'component', component, props}`; `evaluateScene` expandiert sie. Kind-IDs: `<id>/<lokal>`.

## Folgen

Agents patchen Komponenten-Props statt expandierter Nodes.
