# Sicherheit

## Eine Lücke melden

Melde Sicherheitslücken bitte nicht als öffentliches Issue.
Nutze stattdessen die private Meldung von GitHub:
**Security → Report a vulnerability** in diesem Repository.

Beschreibe in der Meldung:

1. Die betroffene Version oder den Commit.
2. Die Schritte, mit denen sich die Lücke zeigen lässt.
3. Die Wirkung, zum Beispiel Datei-Lesen oder Codeausführung.

Wir bestätigen den Eingang innerhalb von 7 Tagen.
Eine Korrektur veröffentlichen wir mit einem Hinweis im Changelog.

## Unterstützte Versionen

Sicherheitskorrekturen gibt es für die neueste Minor-Version.

## Sicherheitsmodell in Kürze

OpenVideo führt Code aus, den Agenten schreiben. Dieser Code gilt als nicht vertrauenswürdig.

| Eingabe | Wo sie läuft |
|---|---|
| TSX-Projekte | Im Docker-Container ohne Netz, ohne Capabilities, mit Speicher- und Prozessgrenze (Standard `container`) |
| HTML-Layer mit Skripten | Nur mit ausdrücklicher Freigabe oder im Container; sonst sind Skripte gesperrt |
| JSON-Projekte | Auf dem Host; JSON enthält keinen ausführbaren Code |
| Asset-URLs | Nur öffentliche Adressen; private, Loopback- und Metadaten-Adressen sind gesperrt |

Der Modus `trusted-host` ist **keine** Isolation. Nutze ihn nur für eigenen Code.

Die HTTP-API bindet ohne Token nur an Loopback-Adressen.
Setze für jede andere Adresse ein Token mit `OPENVIDEO_API_TOKEN`.

Details stehen in `docs/adr/0008-nicht-vertrauenswuerdiger-code-nur-im-container.md`.
