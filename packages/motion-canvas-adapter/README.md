# @agentic-video/motion-canvas-adapter

Motion-Canvas-artige Generator-Szenen als OpenVideo-IR.
Motion Canvas wird nicht eingebunden. Die Szenen laufen symbolisch ohne Uhr.

```ts
import { all, makeScene, Rect, toProject, waitFor } from '@agentic-video/motion-canvas-adapter';

const intro = makeScene('intro', function* (view) {
  const rect = new Rect({ key: 'box', width: 200, height: 100, fill: '#e13238' });
  view.add(rect);
  yield* all(rect.x(300, 1), rect.opacity(0, 1));
  yield* waitFor(0.5);
  yield* rect.x(0, 1);
});

const { project, diagnostics } = toProject([intro], { width: 1920, height: 1080, fps: 30 });
// Keyframes von x bei 0 s, 1 s, 1.5 s und 2.5 s
```

- Ursprung jeder Szene ist die Bildmitte, y zeigt nach unten (wie Motion Canvas).
- Jeder Knoten wird eine Gruppe an seiner Position; die Form liegt zentriert darin.
- Standard-Easing ist `easeInOutCubic`.
- `waitUntil(name)` wird ein Composition-Marker; die Wartezeit kommt aus `toProject(…, { events })`.
- Nicht unterstützt (Diagnose `OV_IMPORT_LOSSY`): Flexbox-Layout, eigene Easing-Funktionen, unbekannte Properties.
