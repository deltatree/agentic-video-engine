# @agentic-video/render

Render-Pipeline: Frame-Render, Compositing, Frame-Cache, Audio, Encoding, Render-Manifest.

`createNodeEnvironment` lädt die Plugins aus `settings.plugins` (Story 21.1, ADR 0012), bevor es die Assets auflöst: nur mit `trusted` oder `OPENVIDEO_ALLOW_PLUGINS=1`, Rechte nur ausdrücklich (`plugins.permissions` bzw. `OPENVIDEO_PLUGIN_PERMISSIONS`). Codecs (`codec: 'plugin:<id>'`) und Exporter (`format: 'plugin:<id>'`) wirken im Encoder, Asset Loader in der Asset-Pipeline; siehe [docs/guide/plugins.md](../../docs/guide/plugins.md).
