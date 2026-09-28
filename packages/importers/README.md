# @agentic-video/importers

Importe offener Formate in die OpenVideo-IR: SVG, Lottie, glTF und HTML/CSS.
Jeder Importer ist ein reiner Umwandler. Er rendert nichts.

## Funktionen

| Funktion | Ergebnis |
|---|---|
| `importSvg(markup, { idPrefix })` | Gruppe mit Formen, Text, Bildern, Verläufen und Masken |
| `importLottie(json, { mode: 'embed' })` | eine `lottie`-Node plus Asset (verlustfrei) |
| `importLottie(json, { mode: 'native' })` | Gruppen und Formen mit `$keyframes` |
| `importGltf(bytes, { assetId })` | `scene3d` mit `model3d`, Kameras, Lichtern und Clip-Liste |
| `importHtml(html, css, { id })` | eine `html`-Node; data-URIs werden Assets |

Jedes Ergebnis hat `nodes`, `assets` (IR-Eintrag plus Bytes) und `diagnostics`.

## Verluste

Jeder Informationsverlust erzeugt eine Diagnose `OV_IMPORT_LOSSY` (Schweregrad `warning`).
Sie nennt den Pfad im Quellformat und einen Vorschlag. Beispiel:

```ts
const { nodes, diagnostics } = importSvg('<svg width="10" height="10"><rect width="5" height="5" filter="url(#f)"/></svg>');
// diagnostics[0].problem: 'SVG filters are not supported; the element is drawn without the filter.'
```
