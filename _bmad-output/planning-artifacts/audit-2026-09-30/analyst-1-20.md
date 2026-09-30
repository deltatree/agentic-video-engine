# Audit Auftrag §1–20 (Mary, Analyst) – 2026-09-30

| § | Befund | Beleg | Schwere |
|---|---|---|---|
| 3/14 | group mit nur three/browser/blender-Kindern bekommt dieses Backend; Backend wirft bei group (abgeleitet) | core/src/plan.ts:52; renderer-browser/src/runtime/three.ts:22; runtime/html.ts:134; renderer-blender/src/backend.ts:101 | hoch |
| 9/14 | blendMode geht an Backend-Grenzen verloren (Layer immer normal) | compositor/src/composite.ts:287-290; render/src/frame.ts:206 | hoch |
| 7/14 | wipe/iris-reveal wirkt nicht auf layer/gemischte Gruppen/scene3d/blender | core/src/evaluate.ts:173-187 | mittel |
| 14 | mask auf scene3d/blender still ignoriert | render/src/frame.ts:187-196 | mittel |
| 14 | layer.colorSpace ohne Wirkung | schema/src/nodes.ts:197; compositor/src/composite.ts:338 | mittel |
| 3/14 | settings.workingColorSpace ohne Verbraucher; outputColorSpace linear fällt still auf sRGB | schema/src/project.ts:305; render/src/frame.ts:284 | niedrig |
| 14 | kein zIndex | schema/src/nodes.ts:137-150 | niedrig |
| 13 | Blender motionBlur wirkungslos (motionStates nie übergeben) | renderer-blender/src/backend.ts:63-66,256; render/src/frame.ts:142 | hoch |
| 13 | particles3d in Blender harter Fehler | renderer-blender/src/check.ts:54 | niedrig |
| 9 | Pixi weit hinter Skia (rich-text, svg, lottie, shadow, …); Untertitel scheitern mit renderer2d pixi | renderer-pixi/src/check.ts | mittel |
| 1/9/12 | Chromium fest SwiftShader, kein GPU-Modus | renderer-browser/src/host.ts:29-35 | mittel |
| 12 | WebGPU/WebGL2-Wahl nicht im Manifest/Cache-Key | renderer-three/src/renderer.ts:77-100 | mittel |
| 20 | Manifest platform.gpu nie gesetzt | render/src/node-env.ts:270; video.ts:270 | mittel |
| 20 | Manifest: erwartete statt tatsächliche Chromium-Version; renderBackend = alle registrierten | renderer-browser/src/lazy.ts:16-50; render/src/video.ts:236,271 | niedrig |
| 20 | Kein Manifest für frame/preview/contactSheet | render/src/video.ts:295 | niedrig |
| 20/18 | Voice-Hashes fehlen im Manifest | render/src/video.ts:230 | niedrig |
| 16 | Audio aus composition-ref fehlt; Video-Audio ignoriert speed/reverse/remap | render/src/audio-engine.ts:37-81 | mittel |
| 17 | tracks[].fromAudio nie ausgewertet; keine Transcribe-Operation | schema/src/project.ts:207; subtitles/src/expander.ts:149 | mittel |
| 17 | ASS-Styles geparst, verworfen | subtitles/src/parse.ts:341-400 | niedrig |
| 17 | Untertitel-Umbruch geschätzt (0,6 em); Karaoke nur ganze Wörter | subtitles/src/expander.ts:38,100-106,224-246 | mittel |
| 15 | animierte GIF/WebP/APNG in image-Node: MKV-Pfad, Decode scheitert (abgeleitet) | assets/src/pipeline.ts:117,354,375; renderer-skia/src/backend.ts:146 | hoch |
| 10/15 | WOFF/WOFF2/TTC vom Loader abgelehnt | fonts/src/sfnt.ts:123 | niedrig |
| 10 | textPath schließt textAnimation/Hintergrund still aus | renderer-skia/src/text.ts:550-559 | niedrig |
| 9 | SVG-Parser ohne clipPath/mask/filter/pattern/image/tspan; für Asset-SVGs keine Meldung | renderer-skia/src/svg.ts:34 | mittel |
| 11 | HTML ohne Skripte: Canvas/WebGL rendert leer, nur info | renderer-browser/src/html-check.ts:50-59 | mittel |
| 7 | Named Events ohne Semantik/Expression-Zugriff | timeline/src/expression.ts:341 | niedrig |
| 7 | Keine Transition zwischen zwei Clips/Sequenzen | schema/src/nodes.ts:62-76 | niedrig |
| 6 | Kein renderFrames([...]) als Operation | agent/src/operations.ts | niedrig |
| 19 | hardware:auto als Standard → unterschiedliche Bytes je Hardware | ffmpeg/src/encoder.ts:215; render/src/video.ts:216 | niedrig |
| 1/8/12 | Paketnamen weichen vom Auftrag ab (@openvideo/three) | – | niedrig (D2 erklärt) |
| 9 | Keine portable Shader-Sprache (SkSL vs GLSL) | renderer-skia/src/backend.ts:244 | niedrig |
