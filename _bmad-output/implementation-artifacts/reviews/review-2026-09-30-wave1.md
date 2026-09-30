# Review Welle 1 (Quinn) – cba83a9..0eae091+

| # | Schwere | Befund | Zuständig |
|---|---|---|---|
| B1 | blocker | compositing.test.ts erwartet OV_COMPOSITE_UNSUPPORTED, Code wendet Filter an (17.11); ADR 0024 veraltet | Epic 17b |
| M1 | major | Filter/Schatten bei isolierten scene3d/blender doppelt (plan.ts isolation + frame.ts buildIsolate) | Epic 17b |
| M2 | major | FFmpeg-Kindprozesse erben volle Umgebung (process.ts:136, encoder.ts:400, reader.ts:202) | Epic 18 |
| M3 | major | project.open-Symlinks bleiben; Wurzelprüfung nur beim Öffnen | Epic 20 (agent) |
| M4 | major | Worker können jobs/<id>/frames vorab vergiften (DoS); publishFrames überspringt bei has | Epic 18 (worker) |
| M5 | major | Gescheiterte Jobs: Rest-Chunks werden weiter geleast und für KEDA gezählt | Epic 18 (scheduler) |
| M6 | major | frameKey ignoriert Blender-motionStates | Epic 17b |
| m1 | minor | RevisionWatcher.subscribe schließt falschen Watcher | Epic 20 |
| m2 | minor | openEvents: close-Listener zu spät, Leck | Epic 20 |
| m3 | minor | /v1/events unbegrenzt | Epic 20 |
| m4 | minor | project.import: idPrefix ignoriert (anime/mc), Symlink beim Schreiben, fehlende Tests | Epic 20 (agent) |
| m5 | minor | arrangeSequence perGap-Index verrutscht | Epic 17b |
| m6 | minor | event(id,key) String in Arithmetik | Epic 17b |
| m7 | minor | heartbeat ohne expireLeases; URIError→500; /metrics löst Journal-Schreiben aus | Epic 18 |
| m8 | minor | maxActive-Race; inputs/ nie gelöscht | Epic 18 |
| m9 | minor | ensureGraphics-Race; probeOsSandbox wertet jeden Startfehler als keine Sandbox | Epic 18 |
| m10 | minor | `as` in agent-dx.test.ts, live.test.ts | Epic 20 |
