# Example: product launch (JSON IR)

An 8-second launch video written directly as Composition IR (`project.json`): a logo reveal, a bar
chart with the week's numbers and a call to action, joined by automatic transitions and underlaid
with music.

| Feature | Where in `project.json` |
|---|---|
| Image with spring animation | `logo-image` (`image`, `scale.$spring`) |
| Text, per-word animation, theme tokens | `cta-title` (`textAnimation`), `fill: { "$ref": "theme.colors.text" }` |
| Components | `backdrop` (`GradientBackground`), `product-name` (`Title`), `new-badge` (`Badge`), `numbers-chart` (`BarChart`) |
| Scenes with transitions | `scenes` (`sequence` with `between` and `transitions`: slide-left, fade) |
| Line drawing | `cta-underline` (`line`, `trimEnd` keyframes) |
| Music with fades and loudness target | `audio`, `tracks[soundtrack]`, `audio.loudness: -16` |
| Render profile | `renderProfiles[web]` (MP4, H.264) |

## Run it

```bash
cd examples/product-launch
node generate-assets.mjs                 # writes assets/logo.png and assets/music.wav
npx openvideo validate                   # schema, assets, fonts, backends
npx openvideo render-frame --frame 4.5s  # out/frame-135.png (the chart)
npx openvideo render --profile web       # out/main.mp4 + render manifest
```

Inside this repository use `node ../../packages/cli/dist/bin.js` instead of `npx openvideo` (after `npm run build`).
Agents change the video with patches, e.g. `npx openvideo patch --input '[{"op":"setProperty","nodeId":"product-name","property":"props.text","value":"Meet Streamline"}]'`.

## Assets and license

`generate-assets.mjs` synthesizes both assets with plain Node.js (no downloads, no dependencies):
`assets/logo.png` (256 × 256 gradient tile with a play symbol) and `assets/music.wav` (8 s chord
progression C–Am–F–G, 48 kHz stereo). They are original, generated content under
[CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/); the project declares that in
`assets[].license`. The generated files are not checked in (`.gitignore`).

## Test

`product-launch.test.ts` copies this folder to a temporary directory, generates the assets, runs
`openvideo validate` and renders three frames (1 s, 4.5 s, 7 s): `npx vitest run examples/product-launch`.
