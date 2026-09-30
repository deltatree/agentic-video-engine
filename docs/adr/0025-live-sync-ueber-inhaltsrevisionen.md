# ADR 0025: Live-Sync des Studios über Inhaltsrevisionen und Server-Sent Events

- Status: angenommen
- Datum: 2026-09-30
- Bezug: Audit 2026-09-30 (UX §1, §4, §47), Epic 20 (Story 20.1, 20.3, 20.5), ADR 0001, ADR 0009

## Kontext

Das Studio, Agents (MCP, Agent API), die CLI und der Editor des Nutzers ändern dasselbe Projekt.
Das Studio kannte nur seine eigenen Änderungen: Fremdänderungen blieben unsichtbar, und seine
Undo-Inversen bezogen sich danach auf einen Stand, den es nicht mehr gab. `openvideo dev` beobachtete
keine Dateien und ignorierte `--open`.

## Entscheidung

1. **Revision = Inhalt:** Die Revision eines Projekts ist der SHA-256 (16 Hex-Zeichen) von `project.json`.
   Sie entsteht unabhängig davon, wer schreibt, und bleibt gleich, wenn dieselbe IR nur neu geschrieben
   wird (TSX-Projekte schreiben die kompilierte IR bei jedem Laden). Keine Zähler, kein Zustand im Server.
2. **Ereignisse:** `GET /v1/events?projectId=<id>` liefert Server-Sent Events `revision` (mit Token wie alle
   `/v1/*`-Routen). Der Server beobachtet den Projektordner (`fs.watch`), nur solange jemand zuhört, und
   begrenzt gleichzeitige Streams (`maxEventStreams`, Standard 32). Die erste Nachricht ist der aktuelle Stand.
   `GET /v1/files/<projekt>/project.json` trägt dieselbe Revision als `ETag`.
3. **Studio:** Es liest den Stream mit `fetch` (`EventSource` kann keinen `Authorization`-Header senden),
   merkt sich die Revision der geladenen Datei und lädt bei einer anderen Revision neu. Eigene Schreibvorgänge
   laufen über eine serielle Warteschlange; Ereignisse währenddessen werden nur vorgemerkt und danach
   verglichen. Eine Fremdänderung verwirft Undo und Redo. Ein offener Code-Entwurf wird nie überschrieben;
   das Studio warnt stattdessen.
   **Ereignisse sind nur Hinweise (Nachtrag 2026-09-30):** Das Echo einer eigenen Speicherung kann vor oder
   nach deren Antwort eintreffen, der Anfangsstand eines neuen Stroms kann älter sein als eine gerade laufende
   Speicherung. Weicht eine gemeldete Revision von der geladenen ab, liest das Studio darum in der
   Warteschlange die Revision der Datei (`ETag`) nach und behandelt nur eine echte Abweichung als Fremdänderung;
   die Meldung gilt danach als geprüft. Vorher führte ein veralteter Anfangsstand dazu, dass Undo verloren ging
   und das Studio endlos neu lud.
   **Wiederverbinden:** mit wachsender Wartezeit (1 s … 15 s); sie fällt erst zurück, wenn eine Verbindung
   nach dem Anfangsstand ein weiteres Ereignis geliefert hat oder mindestens `maxDelayMs` offen war (Nachtrag
   unten). `dispose` beendet Strom und Wiederverbindung endgültig.
   **Ende der Beobachtung:** Wird der Projektordner gelöscht oder ersetzt (neuer Inode) oder meldet der
   Watcher einen Fehler, schließt der Server die betroffenen Ströme; der Client verbindet neu und beobachtet
   den neuen Ordner, statt stumm „live“ zu bleiben.
4. **Vorschau ohne Speichern:** `frame.render` nimmt optional `patches`, wendet sie nur für diesen Render an
   und speichert nie. Das Studio zeigt so Zwischenstände beim Ziehen (gedrosselt, höchstens ein Render
   gleichzeitig, der neueste gewinnt).
5. **`openvideo dev`:** beobachtet `src/**`, die Entry-Datei und `project.json`, kompiliert TSX neu und schreibt
   die IR nur bei Änderung. `--open` ist bei `dev`/`studio` Standard (`--no-open` schaltet ab; in CI und ohne
   grafische Sitzung wird nichts geöffnet).

## Folgen

- Agents und Menschen arbeiten gleichzeitig am selben Projekt; das Studio zeigt immer den Stand auf der Platte.
- Eine Fremdänderung, die mitten in eine eigene Speicherung fällt, landet im neu geladenen Stand, ohne dass
  Undo verworfen wird (die Revisionen sind dann gleich). Das ist bewusst einfach; die Inversen sind semantische
  Patches und bleiben meist gültig.
- Ohne Dateisystem-Ereignisse (manche Netzlaufwerke) bleiben Live-Updates aus; das Studio zeigt „Offline“
  bzw. keine Aktualisierung und funktioniert sonst unverändert.

## Nachtrag 2026-09-30 (abschließendes Review, M4/m5)

- **Backoff beim Nachlesen (M4):** Scheitert das Nachlesen von `project.json` nach einer gemeldeten Revision
  (Netzfehler, Server weg), bleibt die Meldung vorgemerkt, und das Studio prüft erneut mit wachsender
  Wartezeit: erst nach 1 s, dann verdoppelt bis höchstens 30 s (`StudioOptions.recheckDelay` mit `minMs`,
  `maxMs`). Solange ein solcher Versuch wartet, prüft nur er; weitere Ereignisse lösen kein zusätzliches
  Nachlesen aus. Ein erfolgreiches Nachlesen setzt die Wartezeit zurück, `dispose` bricht den Versuch ab.
  Vorher wiederholte ein dauerhaft scheiterndes Nachlesen sich ohne Pause (im Mikrotask-Takt).
- **Rücksetzen der Reconnect-Wartezeit (m5):** Der Server schickt bei jeder Verbindung zuerst den aktuellen
  Stand; dieses Anfangsereignis zählt nicht mehr als Beleg, dass die Verbindung trägt. Die Wartezeit fällt
  erst auf 1 s zurück, wenn die Verbindung danach ein weiteres Ereignis geliefert hat oder mindestens
  `maxDelayMs` (Standard 15 s) offen war. Ein Server, der Ströme nach dem Anfangsstand sofort schließt,
  erzeugt so keine Sekundentakt-Schleife mehr.
