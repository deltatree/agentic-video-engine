# @agentic-video/compiler

TSX → Composition IR: Bündeln, Auswerten in der Sandbox, JSON-Export, AST-Rückschreiben.

- `compileTsx(entry, { projectDir, mode })` bündelt mit esbuild und wertet in der Sandbox aus. Node-Builtins sind verboten (`OV_COMPILE_NODE_BUILTIN`). Laufzeitfehler nennen Datei und Zeile der TSX-Quelle (`OV_COMPILE_RUNTIME`).
- `exportJson(project)` schreibt die IR als formatiertes JSON ohne Code.
- `applyPatchesToSource(source, patches)` schreibt Studio-Patches per TypeScript-AST zurück. Elemente werden über ihr `id`-Attribut gefunden. Ausdrücke statt Literale ergeben `OV_ROUNDTRIP_DYNAMIC`; dieser Patch bleibt dann aus.
