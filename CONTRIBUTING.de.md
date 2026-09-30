# Mitwirken an OpenVideo

[English version](CONTRIBUTING.md) (maßgeblich)

Danke für dein Interesse. Diese Seite erklärt, wie du eine Änderung einbringst.
Sie gilt für Menschen und für Coding Agents (Kurzfassung für Agents: [AGENTS.md](AGENTS.md)).

## Voraussetzungen

- Node.js 22.13 oder neuer
- FFmpeg 6 oder neuer (CI nutzt 7.1) im `PATH` oder in `OPENVIDEO_FFMPEG`
- Chromium für Playwright: `npx playwright install chromium chromium-headless-shell`
- Optional: Blender 4.2 LTS (`OPENVIDEO_BLENDER`), Docker (Sandbox und Worker), Piper oder espeak-ng, whisper.cpp

`openvideo doctor` zeigt, was fehlt.

## Erste Schritte

1. Klone das Repository.
2. Installiere die Abhängigkeiten: `npm ci`.
3. Baue alle Pakete: `npm run build`.
4. Führe alle Prüfungen aus: `npm run check`.

`npm run check` prüft Abhängigkeitsregeln, Build, Lint (auch der Beispiele), generierte Doku und ihre Zahlen, Lizenzen und Tests.

## Eine Änderung einbringen

1. Lege ein Issue an oder kommentiere ein vorhandenes.
2. Erstelle einen Branch von `main`.
3. Schreibe zuerst einen Test, der das gewünschte Verhalten zeigt.
4. Ändere den Code, bis der Test grün ist.
5. Führe `npm run check` aus.
6. Öffne einen Pull Request. Beschreibe darin, was sich ändert und warum.

Halte Pull Requests klein. Eine Änderung soll eine Sache tun.

## Regeln für den Code

| Regel | Beispiel |
|---|---|
| Strenges TypeScript: kein `any`, kein `as` außer `as const`, kein `!` | Nutze `isRecord` und `conforms` aus `@agentic-video/core`. |
| Fehler sind `OpenVideoError` mit Code und Vorschlägen | `code: 'OV_ASSET_MISSING'`, `suggestions: ['Run asset.import …']` |
| Jede exportierte Funktion hat TSDoc mit `@example` | siehe `packages/core/src/patches.ts` |
| Kein `Date.now()` und kein `Math.random()` in Render-Pfaden | Zufall nur über `random(seed, …)` |
| Pakete importieren nur erlaubte Pakete | Regeln in `scripts/dependency-rules.json` |
| Node-Module mit Präfix | `import { readFile } from 'node:fs/promises'` |

Die verbindliche Render-Semantik steht in `docs/reference/node-semantics.md`.
Architektur-Entscheidungen stehen in `docs/adr/`.

## Tests

- Tests liegen in `packages/<paket>/test/*.test.ts` oder `*.test.tsx` (Vitest), auch neben dem Code unter `src/`.
- Golden Images liegen in `packages/<paket>/test/golden/`.
  Erzeuge sie neu mit `UPDATE_GOLDENS=1`. Sieh dir jedes neue Bild an, bevor du es eincheckst.
- Ein Test, der ein fehlendes Programm braucht, wird mit Begründung übersprungen:
  `it.skipIf(skipUnless(verfuegbar, 'Grund und Abhilfe'))` aus `@agentic-video/testing`.
  CI setzt `OPENVIDEO_REQUIRE_ALL=1`; dort ist jeder solche Skip ein Fehler (Ausnahme: GPU, `allowInCi`).
- Keine festen Pausen: warte auf Promises oder `expect.poll`, nutze injizierbare Uhren. Harte Zeitgrenzen
  nur mit `it.skipIf(!perfStrict())` (laufen nightly mit `OV_PERF_STRICT=1`).
- `npm run test:coverage` misst die Coverage; die Mindestwerte je Paket stehen in `vitest.config.ts`
  und werden nur angehoben.
- Ein Test läuft einzeln so: `npx vitest run packages/core/`.
  Achte auf den Schrägstrich am Ende. Sonst trifft `packages/render` auch `renderer-*`.

## Dokumentation

- Englisch zuerst: `README.md`, `AGENTS.md`, `llms.txt`, `docs/ai/`, `docs/guide/`, `docs/reference/`, READMEs der Beispiele,
  diese Datei, `SECURITY.md` und `deploy/README.md`. Wo es eine deutsche Fassung gibt, liegt sie als `*.de.md` daneben;
  beide verlinken einander und haben identische JSON-, JSONC- und TSX-Blöcke (`packages/render/test/docs.test.ts`).
  Ändere beide Fassungen im selben Pull Request.
- `docs/ai/capabilities.json`, `docs/guide/api.md`, `docs/guide/cli.md`, die Beispiele in
  `docs/reference/node-semantics*.md` und `packages/mcp/src/agents-doc.ts` sind generiert:
  `npm run build && node scripts/generate-docs.mjs`. `node scripts/generate-docs.mjs --check` schlägt fehl, wenn sie veraltet sind.
- `node scripts/check-doc-numbers.mjs` schlägt fehl, wenn README, AGENTS oder llms.txt andere Anzahlen von Operationen,
  Node-Typen, Komponenten, Templates oder Blend Modes nennen als `docs/ai/capabilities.json`.
- Die TypeDoc-API-Referenz veröffentlicht `.github/workflows/docs.yml`; `npm run docs` schreibt sie lokal nach `docs/api/`.

## Sprache

- Kommentare, TSDoc und ADRs sind auf Deutsch.
- Bezeichner, Code und Fehlermeldungen für Nutzer sind auf Englisch.
- Nutzer-Doku ist Englisch zuerst (siehe oben).

## Sicherheitslücken

Melde Sicherheitslücken nicht als öffentliches Issue. Lies [SECURITY.de.md](SECURITY.de.md).

## Lizenz

Mit deinem Beitrag stimmst du zu, dass er unter Apache-2.0 steht.
Neue Laufzeit-Abhängigkeiten brauchen eine OSI-Lizenz. `npm run licenses` prüft das und erzeugt `licenses.json`, `THIRD_PARTY_NOTICES.md` und `sbom.cdx.json` neu; checke sie mit ein. Änderst du Abhängigkeiten oder `deploy/docker/Dockerfile`, schlägt `node scripts/licenses.mjs --check` (Teil von `npm run check` und CI) sonst fehl.
