/**
 * Studio-Panels aus Plugins (Story 21.1): `plugins.list` liefert Titel und signierte URL je Panel.
 * Jedes Panel läuft in einem iframe mit `sandbox="allow-scripts"` (eigene, undurchsichtige Origin,
 * kein Zugriff auf Token oder Studio-Zustand). Das Studio sendet das aktuelle Projekt per
 * `postMessage`; das Panel darf Meldungen (`openvideo.panel.notify`) zurückschicken.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { call } from '../api.js';
import { useStudio } from '../context.js';
import { records, str } from '../json.js';

/** Ein Panel aus `plugins.list`. */
export interface PluginPanelInfo {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly plugin: string;
}

/**
 * Liest die Panels eines Projekts. Ohne Plugins oder ohne Erlaubnis für Plugins (Fehler der
 * Operation) gibt es keine Panels; der Tab erscheint dann nicht.
 *
 * @example
 * ```tsx
 * const panels = usePluginPanels(state.projectId);
 * ```
 */
export function usePluginPanels(projectId: string): readonly PluginPanelInfo[] {
  const [panels, setPanels] = useState<readonly PluginPanelInfo[]>([]);
  useEffect(() => {
    let live = true;
    call('plugins.list', { projectId }).then(
      (r) => {
        if (!live) return;
        setPanels(
          records(r['studioPanels'])
            .map((p) => ({ id: str(p['id'], ''), title: str(p['title'], ''), url: str(p['url'], ''), plugin: str(p['plugin'], '') }))
            .filter((p) => p.id !== '' && p.url.startsWith('/plugin-panels/')),
        );
      },
      (error: unknown) => {
        // Plugins sind optional: Ein Projekt ohne erlaubte Plugins zeigt einfach keinen Tab.
        if (live) setPanels([]);
        console.info('OpenVideo Studio: no plugin panels', error);
      },
    );
    return () => {
      live = false;
    };
  }, [projectId]);
  return panels;
}

/** Ein Panel im sandboxed iframe; bekommt das Projekt bei jedem Laden und jeder Änderung. */
function PluginPanelFrame(props: { readonly panel: PluginPanelInfo }): ReactNode {
  const [studio, state] = useStudio();
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (e.source !== frame.current?.contentWindow) return;
      const data: unknown = e.data;
      if (typeof data !== 'object' || data === null || !('type' in data)) return;
      if (data.type === 'openvideo.panel.ready') setReady(true);
      if (data.type === 'openvideo.panel.notify' && 'text' in data && typeof data.text === 'string') studio.notify('info', `${props.panel.title}: ${data.text.slice(0, 300)}`);
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, [studio, props.panel.title]);
  useEffect(() => {
    // Die Panel-Seite hat eine undurchsichtige Origin („null“); darum Ziel „*“. Sie erhält nur das Projekt.
    if (ready && state.project !== undefined) frame.current?.contentWindow?.postMessage({ type: 'openvideo.panel.project', project: state.project }, '*');
  }, [ready, state.project]);
  return <iframe ref={frame} className="plugin-panel" title={props.panel.title} src={props.panel.url} sandbox="allow-scripts" referrerPolicy="no-referrer" style={{ border: 0, width: '100%', height: '100%', minHeight: 240 }} />;
}

/**
 * Inhalt des Tabs „Plugins“: Auswahl (bei mehreren Panels) und das gewählte Panel.
 *
 * @example
 * ```tsx
 * <PluginPanels panels={panels} />
 * ```
 */
export function PluginPanels(props: { readonly panels: readonly PluginPanelInfo[] }): ReactNode {
  const [active, setActive] = useState(0);
  const panel = props.panels[Math.min(active, props.panels.length - 1)];
  if (panel === undefined) return <p className="empty">No plugin panels.</p>;
  return (
    <div className="plugin-panels" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {props.panels.length > 1 && (
        <label>
          Panel{' '}
          <select
            value={active}
            onChange={(e) => {
              setActive(Number(e.target.value));
            }}
          >
            {props.panels.map((p, i) => (
              <option key={p.id} value={i}>
                {p.title} ({p.plugin})
              </option>
            ))}
          </select>
        </label>
      )}
      <PluginPanelFrame key={panel.id} panel={panel} />
    </div>
  );
}
