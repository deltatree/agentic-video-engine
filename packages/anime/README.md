# @agentic-video/anime

Anime.js-artige API (v4-Konzepte), die in OpenVideo-Keyframes übersetzt.
Anime.js wird nicht eingebunden. OpenVideo besitzt die Zeit: Die Timeline startet keine Uhr.

```ts
import { applyTimeline, createTimeline, stagger } from '@agentic-video/anime';

const tl = createTimeline({ defaults: { duration: 600 } })
  .add(['card-1', 'card-2', 'card-3'], { y: [40, 0], opacity: [0, 1], delay: stagger(100) })
  .add('#title', { scale: 1.2, ease: 'outBack' }, '-=200');

const result = applyTimeline(project, tl); // result.project, result.diagnostics
```

- Ziele sind Node-IDs (`'logo'`, `'#logo'`, Liste).
- `x`/`translateX` und `y`/`translateY` sind relativ zum Basiswert der Node.
- Positionen: ms, `'+=100'`, `'-=100'`, `'<'`, `'<<'`, `'<+=50'`, Label, `'label+=100'`.
- Verluste melden `OV_IMPORT_LOSSY`; `autoplay` meldet `OV_ANIME_IGNORED` (info).
