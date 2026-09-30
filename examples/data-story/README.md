# Example: data story with captions

A 10-second, two-chapter data video: a line chart with a year-over-year counter, then a donut chart
with a table of traffic sources. Captions come from an SRT file and highlight the current word.

| Feature | Where in `project.json` |
|---|---|
| Line chart with area and two series | `growth-chart` (`LineChart`) |
| Animated number | `growth-counter` (`Counter`, `from` → `to`, prefix and suffix) |
| Donut chart with legend and percentages | `sources-pie` (`PieChart`) |
| Table with staggered rows | `sources-table` (`Table`) |
| Chapters with a crossfade | `chapters` (`sequence`, `between: fade`), `markers` |
| Captions from an SRT file | asset `narration` → track `captions` → `captions-view` (`subtitles`, `style: "word-highlight"`, `box`, `safeArea`) |
| Background pattern | `grid` (`Grid`) |

The chart data lives inline in the component props, so an agent can change one value with a patch:

```bash
npx openvideo patch --input '[{"op":"setProperty","nodeId":"growth-counter","property":"props.to","value":41}]'
```

## Run it

```bash
cd examples/data-story
npx openvideo validate                   # schema, assets, fonts, backends
npx openvideo render-frame --frame 3.5s  # out/frame-105.png (line chart and counter)
npx openvideo render --profile web       # out/main.mp4 + render manifest
```

Inside this repository use `node ../../packages/cli/dist/bin.js` instead of `npx openvideo` (after `npm run build`).
The layout keeps every text inside the title-safe area, so `render-frame` reports no warnings.

## Assets and license

`assets/narration.srt` (four cues) was written for this example and is released under
[CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/). The numbers are made up.

## Test

`data-story.test.ts` runs `openvideo validate`, renders two frames without any diagnostics and checks
that the right caption cue is on screen: `npx vitest run examples/data-story`.
