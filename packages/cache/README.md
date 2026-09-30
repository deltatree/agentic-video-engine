# @agentic-video/cache

Inhaltsadressierter Speicher und Cache-Ebenen (Dateisystem, S3-kompatibel).

## Ebenen (ADR 0021)

| Ebene | Inhalt | Nutzer |
|---|---|---|
| `asset` | Asset-Dateien und Metadaten (auch Fonts) | `@agentic-video/assets` |
| `compiled` | Compiler-Output (IR) nach Hash des Bündels und der Compiler-Version | `@agentic-video/compiler` (`compileTsx({ cache })`) |
| `frame` | fertige Frames (Rohformat) | `renderFrame` |
| `layer` | Layer eines Backends | `renderFrame` |
| `audio` | Mischung, Stimmen, Transkripte | Audio-Engine, `@agentic-video/speech` |
| `encoding` | ganze Ausgabedateien wiederholter identischer Renders | `renderVideo` |

`cache.observe((tier, outcome) => …)` meldet jeden Treffer und Fehlgriff (`get`, `getOrCreate`; `has` zählt nicht).
`createNodeEnvironment` leitet die Meldungen an die Telemetrie weiter (`cache_hits`/`cache_misses`, Attribut `tier`).
