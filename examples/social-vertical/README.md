# Example: social vertical (9:16)

An 8-second vertical short (1080 × 1920) in the style of a story: a progress bar, a creator header
with a round avatar, three tip cards that follow each other with transitions, and karaoke captions
that fill word by word.

| Feature | Where in `project.json` |
|---|---|
| Vertical format | composition `main`: `width: 1080`, `height: 1920` |
| Cards one after another with transitions | `cards` (`sequence`, `transitions`: slide-up, zoom-in; each card has `timing.duration`) |
| Karaoke captions with word timings | track `captions` (`cues[].words`) → `captions-view` (`subtitles`, `style: "karaoke"`, `stroke`, `safeArea`) |
| Round avatar | `creator-avatar` (`image` with an `ellipse` as `mask`) |
| Story progress | `story-progress` (`ProgressBar`) |
| Components and theme | `backdrop` (`GradientBackground`), `creator-badge` (`Badge`), `settings.theme` |

Other caption styles: `word-highlight`, `pop`, `fade`, `typewriter`, `plain`. `subtitles.transcribe`
creates `cues` with word timings from a voice-over when whisper.cpp is installed.

## Run it

```bash
cd examples/social-vertical
node generate-assets.mjs                 # writes assets/avatar.png
npx openvideo validate                   # schema, assets, fonts, backends
npx openvideo render-frame --frame 4s    # out/frame-120.png (tip 1 with its caption)
npx openvideo render --profile vertical  # out/main.mp4 + render manifest
```

Inside this repository use `node ../../packages/cli/dist/bin.js` instead of `npx openvideo` (after `npm run build`).

## Assets and license

`generate-assets.mjs` draws `assets/avatar.png` (256 × 256, a stylized head on a gradient) with plain
Node.js. It is original, generated content under [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/);
the generated file is not checked in (`.gitignore`).

## Test

`social-vertical.test.ts` generates the avatar, runs `openvideo validate`, renders three frames in
9:16 without any diagnostics and checks that exactly one card and a caption are on screen:
`npx vitest run examples/social-vertical`.
