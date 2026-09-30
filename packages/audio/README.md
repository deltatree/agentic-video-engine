# @agentic-video/audio

Offline-Audio-Mix und Mastering über FFmpeg.

FFmpeg dekodiert die Quellen zu Float32. Mix, EQ, Dynamik und Lautheit rechnet das Paket in TypeScript.
Gleiche Eingabe ergibt bitgleiche Ausgabe.

| Funktion | Zweck |
|---|---|
| `decodeAudio(path, options)` | Quelle zu Float32 je Kanal, Tempo über `atempo` |
| `mixComposition(input)` | Spuren einer Composition zu Stereo mischen; dazu Quellen mit Zeitabbildung (`mapped`) |
| `masterAudio(buffer, options)` | Lautheit normalisieren (BS.1770-4), danach Limiter |
| `measureLoudness(buffer)` | Integrierte Lautheit in LUFS |
| `writeWav(buffer, path, options)` | WAV mit 16, 24 oder 32 Bit (Float) |

Regeln:

- Pan-Gesetz mit konstanter Leistung: Mitte −3 dB je Kanal, hart links 1/0.
- Clip- und Spur-Pan werden addiert; das Gesetz wirkt einmal.
- `volume` und `pan` dürfen animiert sein. Die Engine wertet sie alle 1/1000 s aus.
- Der Limiter schaut 5 ms voraus und begrenzt Sample-Spitzen (kein True-Peak).
- Ducking schaltet ab −40 dBFS Pegel der Führungsspur.
- `mapped` (`MappedAudioSource`): Quellzeit je Composition-Frame, dazwischen linear interpoliert.
  Die Quelle (Datei oder fertiges PCM, z. B. der Mix einer verschachtelten Composition) läuft wie ein Band:
  schneller heißt höher, rückwärts heißt rückwärts. Sprünge (Schleifen, `hold`) werden nicht überblendet.
  Pan in der Mitte (−3 dB je Kanal, wie ein Clip ohne `pan`).
