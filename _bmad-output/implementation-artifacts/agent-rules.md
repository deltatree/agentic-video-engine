# Regeln für Entwicklungs-Agenten (verbindlich)

Diese Regeln gelten für jede Story in diesem Repository.

## Umgebung

- Führe vor jedem Befehl aus: `export PATH=~/.local/opt/node22/bin:$HOME/.local/bin:$PATH` (Node 22, FFmpeg 7).
- Arbeitsverzeichnis: `/home/deltatree/git/agentic-video-engine`.
- Chromium für Playwright liegt in `~/.cache/ms-playwright` (Version 1243, Chrome 153).
- Keine GPU. WebGL2 und WebGPU laufen über SwiftShader (`--use-angle=swiftshader --enable-unsafe-swiftshader --enable-unsafe-webgpu`). WebGPU braucht eine HTTP-Origin (nicht `about:blank`).

## Grenzen

- Ändere nur Dateien in den Paketordnern deiner Story.
- Führe **kein** `npm install` aus. Ändere nicht `package.json` im Root, `package-lock.json`, `tsconfig*.json` im Root oder fremde Pakete.
- Brauchst du eine neue Abhängigkeit oder eine Änderung an `core`, `schema` oder `timeline`: arbeite ohne sie weiter, wo möglich, und nenne den Bedarf in deinem Abschlussbericht.
- Lies zuerst: `packages/core/src/contracts.ts`, `packages/core/src/semantics.ts`, `packages/core/src/props.ts`, `packages/core/src/matrix.ts`, `docs/reference/node-semantics.md`.

## Code

- Sprache: Kommentare, TSDoc und Doku auf **Deutsch**. Bezeichner, Code und Fehlermeldungen an Nutzer (Diagnose-Texte) auf Englisch.
- Strengstes TypeScript: kein `any`, kein `as` (außer `as const`), kein `!`, kein `@ts-ignore`, kein leerer `catch`. Nutze Type Guards (`isRecord`, `conforms` aus `@agentic-video/core`).
- Fehler immer als `OpenVideoError` mit `code` (`OV_<BEREICH>_<NAME>`), `errorClass`, `problem`, `suggestions` (konkret, umsetzbar).
- Jede exportierte Funktion/Klasse hat TSDoc mit `@example`.
- Keine TODO-Platzhalter, keine Fake- oder Mock-Implementierungen im Produktcode, keine unimplementierten Methoden. Was nicht geht, wird als Capability-Einschränkung mit Diagnose gemeldet.
- Determinismus: kein `Date.now()`, kein `Math.random()`, keine Wall Clock in Render-Pfaden. Zufall nur über `random(seed, …)` aus `@agentic-video/core`.
- Imports zwischen Paketen nur über `@agentic-video/<name>`; Node-Module mit `node:`-Präfix.
- Keine `console.log` in Bibliotheken.

## Tests

- Tests liegen in `packages/<paket>/test/*.test.ts` (Vitest, `fast-check` für Property-Tests).
- Golden Images liegen in `packages/<paket>/test/golden/*.png`. Erzeuge sie mit `UPDATE_GOLDENS=1` und prüfe jedes Bild **visuell** (Read-Werkzeug auf die PNG-Datei), bevor du es behältst.
- Ein Test, der eine fehlende Umgebung braucht (z. B. Blender), wird mit `it.skipIf(!verfuegbar)` und einer benannten Begründung übersprungen, nie still.

## Prüfung vor dem Abschluss

Alle Befehle müssen grün sein:

```bash
npx tsc -b packages/<paket>
npx vitest run packages/<paket>
npx eslint packages/<paket> --max-warnings 0
npx tsc -p tsconfig.eslint.json   # prüft auch die Testdateien mit strengem TypeScript
node scripts/check-deps.mjs
```

## Abschlussbericht

Antworte am Ende nur mit: was gebaut wurde (Dateien), welche Akzeptanzkriterien erfüllt sind, welche Tests laufen (Anzahl), bekannte Einschränkungen, benötigte Änderungen außerhalb deines Pakets.
