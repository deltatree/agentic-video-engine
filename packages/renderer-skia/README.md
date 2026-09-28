# @agentic-video/renderer-skia

2D- und Text-Renderer auf Skia/CanvasKit (Node und Browser).

## Golden Images

Die Referenzbilder liegen in `test/golden/`. Erzeuge sie neu mit:

```bash
UPDATE_GOLDENS=1 npx vitest run packages/renderer-skia
```

Prüfe danach jedes geänderte Bild visuell.

Testschriften in `test/fixtures/` (SIL OFL 1.1): Noto Sans Hebrew (RTL) und Noto Serif (echte `ffi`-Ligatur).
