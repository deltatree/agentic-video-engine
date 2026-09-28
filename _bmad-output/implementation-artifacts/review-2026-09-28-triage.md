---
title: 'Code-Review Epics 1–13: Triage'
created: '2026-09-28'
review_range: 'd5e9e47..242be7b'
layers: ['blind-hunter', 'edge-case-hunter', 'verification-gap', 'security']
failed_layers: []
---

# Triage des Code-Reviews

Vier Ebenen haben geprüft. Keine Ebene ist ausgefallen.
Die Befunde sind nach Grundursache gruppiert.
Jede Gruppe geht an einen Fix-Agenten mit eigenen Paketen.

Regel für die Behebung:

1. Zuerst einen Test schreiben, der den Befund zeigt (rot).
2. Ist der Test nicht rot zu bekommen, gilt der Befund als `false`. Die Begründung kommt in den Bericht.
3. Dann beheben, bis der Test grün ist.

## Gruppe A: Assets und Cache (`packages/assets`, `packages/cache`)

| # | Befund | Urteil | Bucket |
|---|---|---|---|
| A1 | SSRF: IPv4-mapped in Hex (`::ffff:7f00:1`), IPv4-kompatibel, NAT64, 6to4, `fec0::/10`, `fe80::/10` per Bitmaske | high | patch |
| A2 | SSRF über DNS-Rebinding: Prüfung und Verbindung lösen getrennt auf | high | patch |
| A3 | Redirect-Test beweist nichts; Redirect ohne `Location` meldet falschen Fehler | medium | patch |
| A4 | Body wird vor der Größenprüfung ganz gepuffert (Fetcher und S3 get) | high | patch |
| A5 | Symlinks umgehen die Asset-Pfadgrenze | high | patch |
| A6 | ffmpeg/ffprobe ohne `-protocol_whitelist`; Playlist-Demuxer möglich | high | patch |
| A7 | Asset-ID-Kollision (`123.png` → `asset`) ersetzt still ein anderes Asset | medium | patch |
| A8 | `importAsset` mit URL ignoriert den Offline-Modus | medium | patch |
| A9 | Kaputter Metadaten-Eintrag im Cache blockiert dauerhaft | medium | patch |
| A10 | Abgelehntes `VideoFrameReader.open` bleibt im Cache; `close()` bricht ab | medium | patch |
| A11 | Doppelte oder fehlende Asset-IDs ohne Diagnose | low | patch |
| A12 | Gleichzeitige Importe mit gleichem Dateinamen überschreiben sich | medium | patch |
| A13 | FileStore `list()` liefert Shard-Pfade; `clear`/`prune` löschen nichts | high | patch |
| A14 | TieredStore: `list` nur remote; `delete`/`prune` löschen am gemeinsamen S3; Remote-Fehler lassen Render scheitern | high | patch |
| A15 | `utimes`-Fehler macht Cache-Treffer zum Lesefehler | medium | patch |
| A16 | S3-Liste dekodiert keine XML-Entities | medium | patch |
| A17 | Leeres `OPENVIDEO_CACHE_DIR` schreibt ins Arbeitsverzeichnis | low | patch |
| A18 | Cache-Pfade unterscheiden sich mit und ohne S3 | medium | patch |
| – | S3 403 statt 404 als Fehltreffer | maybe-false (medium) | defer: hängt von Bucket-Rechten ab; klare Diagnose reicht |

## Gruppe B: Agent API, CLI (`packages/agent`, `packages/cli`, `packages/mcp`)

| # | Befund | Urteil | Bucket |
|---|---|---|---|
| B1 | CSRF und DNS-Rebinding: kein Content-Type-, Host- und Origin-Check; `dev`/`studio` ohne Token | high | patch |
| B2 | Server ohne Token auf Nicht-Loopback-Adresse | high | patch |
| B3 | `/v1/files`: kein `nosniff`/CSP (SVG-XSS), Symlinks, Host-Pfade in Fehlern, fehlender Test für `..%2f` | high | patch |
| B4 | Pfad-Ausbruch beim Schreiben über Composition-ID, `outName` `.`/`..`, freies `profile.format` | high | patch |
| B5 | Skript-Sperre per Regex umgehbar (`<img/onerror`, `srcdoc`, `css`, `$keyframes`, Komponenten) | high | patch; die echte Grenze setzt Gruppe D (Browser), B hält die Prüfung als Hinweis und wertet die ausgewertete Szene aus |
| B6 | `allowOutsidePaths` gilt auch für HTTP und MCP | high | patch |
| B7 | JobManager: Abbruch in Queue wirkt nicht; `restore` bricht an kaputtem JSON; `persist`-Fehler unbehandelt und ungeordnet; Map wächst unbegrenzt | high | patch |
| B8 | `composition.create` scheitert immer | high | patch |
| B9 | DoS: Pixelbudget, Profilgrenzen (width/height/fps), Gesamtframes, Body-Limit, Semaphor | medium | patch |
| B10 | `composition.patch` bei TSX nicht atomar (writeBack vor Neukompilierung) | medium | patch |
| B11 | Patch-`index` nicht geprüft; `preview.render` ohne Bereichsprüfung; Kontaktbogen doppelt | low | patch |
| B12 | Workspace: ID-Race bei `create`; ungültiges JSON wird `OV_INTERNAL`; `entry` außerhalb; ein kaputtes Projekt bricht die Liste | medium | patch |
| B13 | Server: `error` nach `listen` ohne Handler; URL für `0.0.0.0` und IPv6 falsch | low | patch |
| B14 | Umgebungs-LRU entsorgt Umgebungen in laufenden Jobs; abgelehnte Umgebung bleibt; `dispose` nicht robust; `offline` nicht durchgereicht | high | patch |
| B15 | CLI `project.ts`: falscher Einstieg, `files` mit `..`, überschreibt Nutzerdateien, ID > 63 Zeichen, hängender Symlink | medium | patch |
| B16 | `.ts`-Einstieg in CLI und Agent uneinheitlich; Vorschau-Dateiname kollidiert | low | patch |
| B17 | Tests fehlen: dryRun, applyPatches „nur neue Fehler“, `/v1/health` ohne Token | medium | patch |
| B18 | Interne Fehlermeldungen verraten Pfade (`OV_INTERNAL`) | medium | patch |
| – | `wait()` ohne Timeout | low | reject: Aufrufer steuern Abbruch per `cancel` |

## Gruppe C: Compiler, Sandbox, Core (`packages/compiler`, `packages/sandbox`, `packages/core`)

| # | Befund | Urteil | Bucket |
|---|---|---|---|
| C1 | esbuild bündelt Host-Dateien außerhalb von `projectDir` | high | patch |
| C2 | `trusted-host`: vm-Ausbruch; Kindprozess erbt die ganze Umgebung; Doku falsch | high | patch |
| C3 | `pids` zwischen 0 und 1 ergibt unbegrenzt; `memoryMb` unter 6; Exit 125 falsch gemeldet | medium | patch |
| C4 | Ergebnis-Marke im JSON bricht das Parsen | low | patch |
| C5 | Kein Rückfall-Timer, wenn `docker kill` hängt; Container bleiben liegen | medium | patch |
| C6 | Image-Prüfung: Timeout unbehandelt, doppelte Pulls | low | patch |
| C7 | Diagnosen aus untrusted Code gelten als offizielle Vorschläge (Prompt-Injection) | medium | patch |
| C8 | Ungültiges `details.diagnostic`-JSON verdeckt den Fehler; Builtin-Namen blockieren echte Pakete | low | patch |
| C9 | Keine Rekursionsgrenze für Komponenten und Expander; kein Knotenbudget (exponentielle `composition-ref`) | high | patch |
| C10 | `expand` wirft und reißt die ganze Szene mit | medium | patch |
| C11 | Patches: `addKeyframe`-Umkehrung auf verschachtelten Pfaden; `null` als alter Wert; doppelte IDs im neuen Teilbaum | medium | patch |
| C12 | Out-Übergang asymmetrisch | maybe-false | prüfen gegen `docs/reference/node-semantics.md`, sonst reject |

## Gruppe D: Browser-Host (`packages/renderer-browser`)

| # | Befund | Urteil | Bucket |
|---|---|---|---|
| D1 | HTML-Skripte laufen im Host-Chromium, wenn Skripte nicht erlaubt sind | high | patch: Option `allowScripts`; ohne sie CSP `script-src 'none'` im Layer-Dokument und `css`-Ausbruch verhindern |
| D2 | iframes ohne `sandbox`; Token in `location` lesbar; Frame-Upload-IDs erratbar | high | patch |
| D3 | Netzblockade nur HTTP/WS: WebRTC, DNS-Prefetch; Chromium ohne OS-Sandbox | high | patch |
| D4 | Seiten pro Größe ohne Obergrenze; Absturz von Chromium; Timeout-Aufräumen falsch; `close` verdeckt Fehler | medium | patch |
| D5 | Virtuelle Uhr: `MAX_TIMER_RUNS` bricht still ab; `timeMs` NaN; Lücken bei `document.timeline`, `Event.timeStamp` | medium | patch |
| – | Verschachtelte Shadow Roots | low | reject: selten, Fix erfordert rekursive Suche pro Frame |

## Ergebnis der Behebung

| Gruppe | Behoben | false | Neue Tests |
|---|---|---|---|
| A | A1–A18 | – | 58 grün in assets/cache |
| C | C1–C11 | C12 (Übergang ist in stetiger Zeit spiegelsymmetrisch) | 29 neu |
| D | D1–D5 | – | security.test.ts, node-env.test.ts |

Zurückgestellt:

- **C7-Rest (medium):** SDK-Warnungen wie `OV_SDK_CLAMPED` entstehen im untrusted Code und gehen unverändert durch. Lösung: Das SDK liefert nur Code und Pfad, der Host formuliert den Text. Wieder aufnehmen, wenn das SDK-Diagnoseformat die nächste Änderung bekommt.
- **D2-Rest (medium):** HTML-Layer mit freigegebenen Skripten laufen mit `allow-same-origin`. Das ist keine Grenze; die Grenze bleibt der Container (ADR 0008).
- **S3 403 statt 404:** wie oben.
