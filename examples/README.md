# Examples

Five complete projects to copy, validate, render and change. Each folder has a README with its
purpose and the commands, generates its own small assets (CC0-1.0) and has a test that renders a few
frames.

| Example | Format | Shows |
|---|---|---|
| [`product-launch`](product-launch/README.md) | JSON IR, 1920 × 1080, 8 s | Image, text animation, `BarChart`, `sequence` transitions, music with fades and loudness target |
| [`explainer-tsx`](explainer-tsx/README.md) | TSX SDK, 1920 × 1080, 9 s | Library components, a custom component, a brand theme, an SVG asset by `src` |
| [`data-story`](data-story/README.md) | JSON IR, 1920 × 1080, 10 s | `LineChart`, `Counter`, `PieChart`, `Table`, captions from an SRT file with word highlight |
| [`3d-showcase`](3d-showcase/README.md) | JSON IR, 1280 × 720, 6 s | `scene3d` with a glTF model, camera move, lights and shadows, `particles3d`, bloom, 2D title on top |
| [`social-vertical`](social-vertical/README.md) | JSON IR, 1080 × 1920, 8 s | 9:16, `sequence` of cards, karaoke captions with word timings, masked avatar |

Every example follows the same loop:

```bash
cd examples/<name>
node generate-assets.mjs        # if the folder has one
npx openvideo validate          # add --trusted for explainer-tsx
npx openvideo render-frame --frame 2s
npx openvideo render
```

Inside this repository run `npm run build` once and use `node ../../packages/cli/dist/bin.js` instead of
`npx openvideo`. The tests run with `npx vitest run examples`.

## One example per node type

Every node type also has a small, valid JSON example: `capabilities.get` with `{ "nodeType": "<type>" }`
returns it as `example` (with `propertyTypes`), and [`docs/reference/node-semantics.md`](../docs/reference/node-semantics.md#3-beispiele-je-node-typ)
lists all of them.

## MCP clients

[`mcp.json`](mcp.json) is a client configuration that starts the OpenVideo MCP server on stdio with
the `product-launch` project. Copy it into your client's configuration (for example `.mcp.json`) and
change `--project` to your own project folder, or use `--workspace <dir>` to start with an empty workspace.

## More

- [`dod`](dod/) – the Definition-of-Done run: an agent creates, checks, patches and renders a video with all 21 required parts.
- [`plugin-hello`](plugin-hello/README.md) – a plugin with one extension of every kind.
