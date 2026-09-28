/**
 * Assets- und Components-Tab: Dateien importieren, auf die Bühne ziehen, Komponenten einfügen.
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
            return (
              <li
                key={id}
                draggable={placeable}
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
              </li>
            );
          })}
        </ul>
      )}
      <p className="hint small">Drag an image, video, SVG or Lottie asset onto the stage to place it.</p>
    </div>
  );
}

/** Der Components-Tab: alle Komponenten der Bibliothek mit ihrem Beispiel. */
export function Components(): ReactNode {
  const [studio] = useStudio();
  return (
    <ul className="component-list" aria-label="Components">
      {COMPONENTS.map((c) => (
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
