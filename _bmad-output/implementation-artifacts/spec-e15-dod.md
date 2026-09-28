---
title: 'Definition-of-Done-Test (Story 15.2)'
type: 'feature'
created: '2026-09-28'
status: 'ready-for-dev'
route: 'dispatch'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/agent-rules.md'
  - '{project-root}/Engineering Auftrag – Open Source Agentic Video Engine.md (Abschnitt 50)'
  - '{project-root}/docs/ai/AGENTS.md'
  - '{project-root}/docs/guide/api.md'
  - '{project-root}/examples/dod/generate-assets.mjs'
---

## Intent

**Problem:** Das Produkt gilt erst als fertig, wenn ein Coding Agent nur über dokumentierte APIs ein 60-Sekunden-4K-Video mit 21 Bestandteilen erzeugt. Danach muss er es inspizieren, ändern, neu rendern und auf einem zweiten Worker bitgleich reproduzieren (A50, SM-1, SM-2).

**Nutzen:** Der Test beweist das Produktversprechen an einem echten Ablauf, nicht an Einzelteilen.

## Anforderungen

1. Ein Skript `examples/dod/run.mjs` spielt den Agenten. Es spricht **nur** die HTTP-Agent-API an (`POST /v1/<operation>`), wie in `docs/guide/api.md` beschrieben. Es importiert keine OpenVideo-Pakete außer zum Starten des Servers.
2. Das Video enthält alle 21 Bestandteile aus Abschnitt 50 des Auftrags. Jeder Bestandteil ist im Projekt als benannte Node, Spur oder Einstellung nachweisbar.
3. Ablauf in dieser Reihenfolge:
   1. `project.create`
   2. `asset.import` für alle Assets aus `examples/dod/generate-assets.mjs`
   3. Aufbau über semantische Patches
   4. `project.validate` ohne Fehler
   5. `frame.render` und `frame.inspect` an mindestens drei Stellen
   6. gezielter Patch (z. B. Farbe oder Text einer Node)
   7. erneutes `frame.render`: nur betroffene Frames ändern sich
   8. `video.render` des ganzen Videos
   9. Reproduktion mit einem zweiten Worker. Die Frame-Hashes im Manifest sind gleich.
4. Das Skript schreibt einen Bericht `out/dod-report.json` und `out/dod-report.md`. Der Bericht enthält die Liste der 21 Bestandteile mit Fundstelle, die Laufzeiten, die Hashes und das Ergebnis des Vergleichs.
5. Varianten:
   - `--short`: 1920×1080, 6 Sekunden, alle 21 Bestandteile. Läuft als Vitest-Test in der CI.
   - Voll: 3840×2160, 60 Sekunden, 30 fps. Läuft lokal. Der Bericht kommt nach `docs/dod/`.

## Grenzen

- Keine Änderungen an Paketen. Fehlt eine API, beschreibe den Bedarf im Bericht.
- Voiceover kommt aus der lokalen Sprachsynthese (espeak-ng oder Piper), wenn verfügbar. Sonst bricht der Test mit klarer Diagnose ab.

## Offene Fragen

- Keine. Der zweite Worker ist ein zweiter Worker-Prozess desselben Rechners mit eigenem, leerem Cache. Das entspricht „zweiter Worker aus demselben Projekt“.

## Verification

- `npx vitest run examples/dod/` ist grün (Variante `--short`).
- Die volle Variante läuft lokal durch, und ihr Bericht liegt in `docs/dod/`.
