# Sicherheit

[English version](SECURITY.md) (maßgeblich)

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
| HTML-Layer mit Skripten | Nur mit ausdrücklicher Freigabe (`--trusted` oder `OPENVIDEO_ALLOW_HTML_SCRIPTS=1`) **und** mit Chromium-OS-Sandbox; sonst gesperrt (`OV_BROWSER_NO_OS_SANDBOX`). Das Container-Image allein erlaubt nichts. |
| Plugins (`settings.plugins`) | Im Render-Prozess, nur mit `--trusted` oder `OPENVIDEO_ALLOW_PLUGINS=1`; Host-Dienste nur mit erteilten Rechten (`OPENVIDEO_PLUGIN_PERMISSIONS`). Rechte sind keine Sandbox. |
| JSON-Projekte | Auf dem Host; JSON enthält keinen ausführbaren Code |
| Asset-URLs | Nur öffentliche Adressen; private, Loopback- und Metadaten-Adressen sind gesperrt |

Der Modus `trusted-host` ist **keine** Isolation. Nutze ihn nur für eigenen Code.

Die HTTP-API bindet ohne Token nur an Loopback-Adressen.
Setze für jede andere Adresse ein Token mit `OPENVIDEO_API_TOKEN`.

Details stehen in `docs/adr/0008-nicht-vertrauenswuerdiger-code-nur-im-container.md`.

## Betrieb im Cluster

Die Regeln für Kubernetes stehen in `deploy/README.de.md` (Abschnitt „Sicherheit“) und in
`docs/adr/0023-remote-worker-schreiben-nur-unter-jobs-praefix.md`. Kurz:

- Der Koordinator trennt die Rollen `submit` (API), `worker` und `metrics` (KEDA) mit eigenen Tokens.
  Tokens haben mindestens 24 Zeichen; Platzhalter (`REPLACE…`) lehnt er ab. Ohne Token bindet er nur an Loopback.
- Worker haben keine S3-Admin-Rechte. Sie lesen `inputs/` und schreiben nur `jobs/<jobId>/frames/`.
  Die API übernimmt nur Frames mit dem Präfix des eigenen Jobs und prüft den SHA-256 jedes Frames.
- `complete`/`fail` gelten nur mit gültiger Lease. Anfragen sind auf 64 MiB begrenzt, fertige Jobs verfallen.
- FFmpeg liest Eingaben nur über `file`/`pipe` und nur aus einer Liste erlaubter Container (keine Playlists,
  kein `concat`). Chromium, Blender, Piper und whisper.cpp erben keine Tokens oder S3-Schlüssel.
- Das Studio setzt `Content-Security-Policy` mit `frame-ancestors 'none'` und `Referrer-Policy: no-referrer`
  und nimmt das Token nur aus `#token=` (nie aus `?token=`).
- Die Verbindungen im Cluster sind Klartext-HTTP. Für Verschlüsselung empfehlen wir ein Service Mesh mit
  mTLS oder WireGuard im CNI; NetworkPolicies brauchen ein CNI, das sie durchsetzt.

## Lieferkette

- GitHub Actions sind per Commit-SHA gepinnt; Dependabot hält Actions, npm und Basis-Images aktuell
  (`.github/dependabot.yml`).
- Jeder Workflow-Job hat nur die Rechte, die er braucht (`permissions` je Job).
- Downloads in CI und Images (FFmpeg, Blender, Chromium) werden gegen feste SHA-256-Prüfsummen geprüft.
