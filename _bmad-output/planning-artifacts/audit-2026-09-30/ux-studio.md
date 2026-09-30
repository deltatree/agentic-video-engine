# Audit Studio (Sally, UX) – 2026-09-30

Layout nach §25 vollständig; kein deaktivierter Knopf für geplante Features (§51 ok).

| # | Befund | Beleg | Schwere |
|---|---|---|---|
| 1 | Keine Live-Synchronisation bei Fremdänderungen (Agent/CLI/Editor); Undo-Inversen veralten (§27) | apps/studio/src/store.ts:263-300 | hoch |
| 2 | Wiedergabe stumm; Audio nur für Wellenform dekodiert | store.ts playLoop; panels/Animation.tsx:25 | hoch |
| 3 | Ladefehler nur in Statuszeile; Panels ewig „Loading…“, Tree „No nodes yet“; kein Retry | store.ts:263-270; SceneTree.tsx:118; Inspector.tsx:107; Timeline.tsx:45 | hoch |
| 4 | Patches ohne Warteschlange (Races), Code-Save löscht Undo-Verlauf, Nudges je ein Undo-Schritt | store.ts:461, 528; Preview.tsx:240-248 | hoch |
| 5 | Kein beforeunload bei offenem Code-Entwurf | Bottom.tsx:102-106 | mittel |
| 6 | Bühne nur verschieben: keine Resize/Rotate-Griffe, keine Marquee-Auswahl | Preview.tsx:165-194 | mittel-hoch |
| 7 | Kein Live-Render beim Ziehen/Slider | Field.tsx:59-67; Preview.tsx:225-227 | mittel |
| 8 | Ebenen-Reihenfolge nur per DnD; kein Front/Back, Ungroup | SceneTree.tsx:92-116; App.tsx:182-200 | mittel |
| 9 | Marker nicht umbenennbar/löschbar, kein Kürzel M | store.ts:126; Timeline.tsx:115,164-193 | mittel |
| 10 | Keyframe-Rauten nicht ziehbar, kein Snapping, Trim-Start per Tastatur fehlt | Timeline.tsx:256-268, 75-82 | mittel |
| 11 | Ctrl+Mausrad in Timeline zoomt Browser (passiver Listener) | Timeline.tsx:129-131 | mittel (Bug) |
| 12 | Audio-Spuren nur im Code anlegbar; Wellenform fest 600 px, getrennt von Timeline | Animation.tsx:54,65 | mittel |
| 13 | Mehrfachauswahl im Inspector bearbeitet nur erste Node | Inspector.tsx:42,132 | niedrig-mittel |
| 14 | Bühne nicht per Tastatur wählbar; Guides nur per Maus | Preview.tsx:36,311-318 | mittel |
| 15 | ARIA: Statuszeile wechselt Rolle, Toolbar ohne Roving-Tabindex, Kurvengriffe ohne valuemin/max, kein reduced-motion/forced-colors | App.tsx:83,286; Animation.tsx:396-400; SceneTree.tsx:233 | niedrig-mittel |
| 16 | Feste Pixelspalten, keine Breakpoints, Panelgrößen nicht gespeichert | App.tsx:157-160,224; styles.css:1020 | niedrig-mittel |
| 17 | Projekt-Picker kann keine Projekte anlegen; keine Suche; kein Onboarding | main.tsx:31-41; Library.tsx:131-145 | mittel |
| 18 | Render-Queue und Clipboard nur sitzungslokal | store.ts:195,611; Bottom.tsx:252-253 | niedrig |
| 19 | Kürzel-Lücken (J/K/L, I/O, Keyframe-Sprung); Backspace löscht global | App.tsx:193 | niedrig |
