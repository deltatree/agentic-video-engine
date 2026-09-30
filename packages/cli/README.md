# @agentic-video/cli

Kommandozeile openvideo: create, dev, studio, validate, render, render-frame, inspect, op, patch, contact-sheet, import, doctor, benchmark, cache, fonts, assets, serve, mcp, worker, coordinator.

`openvideo op <name> --input <json|@file>` ruft jede Operation der Agent API auf (dieselben Operationen wie HTTP und MCP, ADR 0009); `openvideo op --list` zeigt alle.

Epic 21:

- `openvideo render --isolation docker [--image <img>] [--gpus all|2|device=0]` rendert Chunks in Docker-Containern (ohne Netz, read-only); `serve`, `mcp` und das Studio lesen `OPENVIDEO_RENDER_ISOLATION=docker`, `OPENVIDEO_WORKER_IMAGE`, `OPENVIDEO_WORKER_GPUS` und `OPENVIDEO_DOCKER`.
- `render-frame --manifest` und `contact-sheet --manifest` schreiben das Kurzmanifest (`<bild>.manifest.json`); die Operationen `frame.render`, `frame.renderMany` und `preview.contactSheet` liefern es als `manifest`.
- `doctor` nutzt dieselben GPU- und Grafik-Proben wie das Render-Manifest (`probeHostGpu`, `probeBrowserGraphics`) und nennt den Grafik-Modus (`OPENVIDEO_BROWSER_GPU`).
- TSX-Projekte: Der Compiler-Output landet in der Cache-Ebene `compiled`; unveränderte Quellen werden nicht erneut in der Sandbox ausgewertet.
- `asset.import` nutzt die Asset Loader der Plugins aus `settings.plugins` (mit derselben Rechteprüfung wie beim Rendern).
