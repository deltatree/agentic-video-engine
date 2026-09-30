# @agentic-video/subtitles

Untertitel: SRT, WebVTT, ASS, Wort-Timing, Caption-Layout als IR-Makro.

## Makro-Node `subtitles`

Der Expander wählt den aktiven Cue und erzeugt eine `rich-text`-Node.

- **Quellen:** `tracks[].cues`, eine Datei (`tracks[].asset`: SRT, WebVTT, ASS) oder `tracks[].fromAudio`.
  `fromAudio` löst `createNodeEnvironment` (Paket `render`) vor dem Render über den ASR-Provider auf
  (`resolveFromAudioTracks` aus `@agentic-video/speech`, Cache je Audio-Hash). Fehlt ein Provider,
  meldet der Expander die Ursache (z. B. `OV_ASR_UNAVAILABLE`), sobald der Track gerendert wird.
- **ASS-Stile:** Schrift, Größe, Primärfarbe, Fett/Kursiv, Ausrichtung (Numpad 1–9), Ränder (`MarginL/R/V`),
  Kontur (`OutlineColour`, `Outline`) und `BorderStyle` 3 (Box in `BackColour`) gelten je Cue.
  Größen und Ränder werden von `PlayResX`/`PlayResY` auf die Composition skaliert.
  Vorrang: `speakerStyles` > Props der Node > ASS-Stil > Standard.
- **Umbruch:** Mit `measureText` (in `render` der Skia-Textmesser) an der echten Textbreite,
  sonst geschätzt mit 0,6 em je Zeichen.
- **Karaoke:** gesungene Wörter in `highlightColor`; das laufende Wort füllt sich von links
  (wie ASS `\kf`). Mit Textmesser als harter Verlauf an der gemessenen Stelle, sonst je Graphem.
- **`textAnimation`:** wirkt je Wort; jedes Wort beginnt zu seiner Wortzeit (`textAnimation.starts`).
