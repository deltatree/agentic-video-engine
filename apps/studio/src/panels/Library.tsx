/**
 * Assets- und Components-Tab: Dateien importieren, auf die Bühne (Bilder, Videos …) oder die Timeline
 * (Audio, Story 20.7) ziehen, Grund-Nodes und Komponenten einfügen und durchsuchen.
 */
import { COMPONENTS } from '@agentic-video/components';
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { call, errorText, fileObjectUrl, fileUrl, needsAuthFetch } from '../api.js';
import { useStudio } from '../context.js';
import { rec, records, str } from '../json.js';

/** Asset-Typen, die als Node auf die Bühne passen. */
export const STAGE_ASSET_TYPES: ReadonlySet<string> = new Set(['image', 'video', 'svg', 'lottie']);

/** MIME-Typ für Asset-Drag-and-Drop auf die Bühne. */
export const ASSET_DRAG_TYPE = 'application/x-openvideo-asset';

function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let text = '';
  for (let i = 0; i < view.length; i += 0x8000) text += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(text);
}

/** Der Assets-Tab. */
export function Assets(): ReactNode {
  const [studio, state] = useStudio();
  const [importing, setImporting] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const assets = records(state.project?.['assets']);

  const importFiles = async (files: readonly File[]): Promise<void> => {
    setImporting(true);
    try {
      for (const file of files) {
        const r = await call('asset.import', { projectId: state.projectId, base64: toBase64(await file.arrayBuffer()), fileName: file.name });
        studio.notify('info', `Imported ${str(rec(r['asset'])['id'], file.name)}.`);
      }
      await studio.reload();
    } catch (error) {
      studio.notify('error', errorText(error));
    } finally {
      setImporting(false);
    }
  };

  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    setOver(false);
    void importFiles([...e.dataTransfer.files]);
  };

  return (
    <div className="assets">
      <div
        className={`dropzone${over ? ' over' : ''}`}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => {
          setOver(false);
        }}
        onDrop={onDrop}
      >
        <p>{importing ? 'Importing…' : 'Drop files here to import them.'}</p>
        <button
          type="button"
          onClick={() => {
            input.current?.click();
          }}
        >
          Choose files…
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="Import files"
          onChange={(e) => {
            void importFiles([...(e.currentTarget.files ?? [])]);
            e.currentTarget.value = '';
          }}
        />
      </div>
      {assets.length === 0 ? (
        <p className="empty">No assets yet.</p>
      ) : (
        <ul className="asset-list" aria-label="Assets">
          {assets.map((a) => {
            const id = str(a['id'], '');
            const type = str(a['type'], '');
            const src = str(a['src'], '');
            const placeable = STAGE_ASSET_TYPES.has(type);
            const audio = type === 'audio';
            return (
              <li
                key={id}
                draggable={placeable || audio}
                onDragStart={(e) => {
                  e.dataTransfer.setData(ASSET_DRAG_TYPE, JSON.stringify({ id, type }));
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                className="asset"
              >
                {(type === 'image' || type === 'svg') && !src.startsWith('http') ? <AssetThumb projectId={state.projectId} src={src} /> : <span className="thumb type">{type}</span>}
                <span className="asset-name">
                  {id}
                  <span className="muted small"> {type}</span>
                </span>
                {placeable && (
                  <button type="button" onClick={() => void studio.addNode({ id, type, asset: id, x: 0, y: 0 })} aria-label={`Add ${id} to the stage`}>
                    Add
                  </button>
                )}
                {audio && (
                  <button type="button" onClick={() => void studio.addAudioClip(id, state.frame)} aria-label={`Add ${id} to the timeline at the playhead`}>
                    Add
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <p className="hint small">Drag an image, video, SVG or Lottie asset onto the stage to place it. Drag audio onto the timeline to create an audio track.</p>
    </div>
  );
}

/** Grund-Nodes, die ohne Asset auskommen (auch die Container `group` und `sequence`). */
const BASIC_NODES: readonly { readonly name: string; readonly description: string; readonly node: Readonly<Record<string, unknown>> }[] = [
  { name: 'Rectangle', description: 'rect: a filled box', node: { id: 'rect', type: 'rect', x: 100, y: 100, width: 320, height: 180, fill: '#5AA2FF' } },
  { name: 'Ellipse', description: 'ellipse: a circle or oval', node: { id: 'ellipse', type: 'ellipse', x: 100, y: 100, width: 200, height: 200, fill: '#FF8A80' } },
  { name: 'Text', description: 'text: a single text block', node: { id: 'text', type: 'text', x: 100, y: 100, text: 'Text', fontSize: 64, fill: '#FFFFFF' } },
  { name: 'Group', description: 'group: draws its children together', node: { id: 'group', type: 'group', children: [] } },
  { name: 'Sequence', description: 'sequence: plays its children one after another (each needs timing.duration)', node: { id: 'sequence', type: 'sequence', children: [] } },
];

/**
 * Filtert Einträge nach einem Suchtext (Name und Beschreibung, ohne Groß-/Kleinschreibung).
 *
 * @example
 * ```ts
 * matchesQuery({ name: 'LowerThird', description: 'Name and title' }, 'lower'); // true
 * ```
 */
export function matchesQuery(item: { readonly name: string; readonly description: string }, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/u).filter((w) => w !== '');
  const text = `${item.name} ${item.description}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

/** Der Components-Tab: Grund-Nodes und alle Komponenten der Bibliothek, durchsuchbar. */
export function Components(): ReactNode {
  const [studio] = useStudio();
  const [query, setQuery] = useState('');
  const basics = BASIC_NODES.filter((b) => matchesQuery(b, query));
  const components = COMPONENTS.filter((c) => matchesQuery(c, query));
  return (
    <div className="components">
      <div className="row-actions">
        <input
          type="search"
          aria-label="Search components"
          placeholder="Search nodes and components…"
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
          }}
        />
        <span className="muted small" aria-live="polite">
          {basics.length + components.length} result(s)
        </span>
      </div>
      {basics.length > 0 && (
        <ul className="component-list" aria-label="Basic nodes">
          {basics.map((b) => (
            <li key={b.name}>
              <button type="button" className="component" onClick={() => void studio.addNode({ ...b.node })}>
                <strong>{b.name}</strong>
                <span className="muted small">{b.description}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <ul className="component-list" aria-label="Components">
        {components.map((c) => (
          <li key={c.name}>
            <button
              type="button"
              className="component"
              onClick={() => void studio.addNode({ id: c.name.charAt(0).toLowerCase() + c.name.slice(1), type: 'component', component: c.name, props: { ...c.example }, x: 100, y: 100 })}
            >
              <strong>{c.name}</strong>
              <span className="muted small">{c.description}</span>
            </button>
          </li>
        ))}
      </ul>
      {basics.length + components.length === 0 && <p className="empty">Nothing matches “{query}”.</p>}
    </div>
  );
}

/** Vorschaubild eines Assets; mit Token über eine Blob-URL, sonst direkt. */
function AssetThumb(props: { readonly projectId: string; readonly src: string }) {
  const direct = !needsAuthFetch();
  const [url, setUrl] = useState<string | undefined>(direct ? fileUrl(props.projectId, props.src) : undefined);
  useEffect(() => {
    if (direct) return undefined;
    let objectUrl: string | undefined;
    let alive = true;
    fileObjectUrl(props.projectId, props.src).then(
      (u) => {
        objectUrl = u;
        if (alive) setUrl(u);
        else URL.revokeObjectURL(u);
      },
      (error: unknown) => {
        console.warn('OpenVideo Studio: thumbnail failed', error);
      },
    );
    return () => {
      alive = false;
      if (objectUrl !== undefined) URL.revokeObjectURL(objectUrl);
    };
  }, [direct, props.projectId, props.src]);
  return url !== undefined ? <img src={url} alt="" className="thumb" /> : <span className="thumb type">…</span>;
}
