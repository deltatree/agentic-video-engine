# Example: explainer in TSX

A 9-second explainer written with the TypeScript/JSX SDK (`@agentic-video/sdk`). JSX is only syntax:
the compiler turns `src/video.tsx` into the same Composition IR a JSON project uses, and writes it
to `project.json` on every load.

| File | What it shows |
|---|---|
| `src/video.tsx` | `project()` and `composition()`, library components via `component('Title')`, `Subtitle`, `Callout`, `Connector`, `ProgressBar`; an SVG asset declared by `src` (`<Svg src="assets/mark.svg" />`); `animate()` and `ref('theme.colors.*')` |
| `src/StepCard.tsx` | A custom component: a plain function that returns elements (`Group`, `Rect`, `Circle`, `Text`) |
| `src/theme.ts` | A brand theme built from `THEMES.light` (`@agentic-video/components`); every component picks up its colors |

## Run it

TSX is code, so OpenVideo compiles it in a sandbox (Docker). For your own project on your own
machine, `--trusted` compiles on the host instead.

```bash
cd examples/explainer-tsx
npx openvideo validate --trusted                  # compiles src/video.tsx, then checks the IR
npx openvideo render-frame --trusted --frame 6.5s # out/frame-195.png
npx openvideo render --trusted --profile web      # out/main.mp4 + render manifest
npx openvideo dev --trusted                       # Studio with live preview
```

Inside this repository use `node ../../packages/cli/dist/bin.js` instead of `npx openvideo` (after `npm run build`).
`composition.patch` and `openvideo patch` write changes back into the TSX source (AST round trip).

## Assets and license

`assets/mark.svg` is a hand-written brand mark (a few lines of SVG) for this example, released under
[CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/). No other assets are needed.

## Test

`explainer-tsx.test.ts` copies this folder to a temporary directory, runs `openvideo validate --trusted`,
checks the compiled IR (theme, components, asset) and renders two frames: `npx vitest run examples/explainer-tsx`.
