/**
 * Untere Leiste: Code (Monaco), Diagnostics und Render Queue.
 */
import { isRecord } from '@agentic-video/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { downloadWithAuth, needsAuthFetch } from '../api.js';
import { useStudio } from '../context.js';
import { records, str } from '../json.js';
import { RENDER_PRESETS, type RenderPreset } from '../store.js';

type Monaco = typeof import('monaco-editor');
type Editor = import('monaco-editor').editor.IStandaloneCodeEditor;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * Findet die Textstelle zu einer Node-ID oder einem JSON Pointer in `project.json` bzw. der TSX-Quelle.
 *
 * @example
 * ```ts
 * locateInText('{"id": "title"}', { nodeId: 'title' }); // 1
 * ```
 */
export function locateInText(text: string, target: { readonly nodeId?: string; readonly pointer?: string }): number | undefined {
  let nodeId = target.nodeId;
  let property: string | undefined;
  if (target.pointer !== undefined) {
    // Tiefste Node auf dem Pointer-Pfad bestimmen, danach die Property dahinter suchen.
    try {
      let cur: unknown = JSON.parse(text);
      const parts = target.pointer.split('/').slice(1).map((p) => p.replace(/~1/gu, '/').replace(/~0/gu, '~'));
      for (const part of parts) {
        if (Array.isArray(cur)) cur = cur[Number(part)];
        else if (isRecord(cur)) cur = cur[part];
        else break;
        if (isRecord(cur) && typeof cur['id'] === 'string' && typeof cur['type'] === 'string') {
          nodeId = cur['id'];
          property = undefined;
        } else property = part;
      }
    } catch {
      property = undefined;
    }
  }
  if (nodeId === undefined) return undefined;
  const id = escapeRegExp(nodeId);
  const hit = new RegExp(`"id"\\s*:\\s*"${id}"|\\bid\\s*[=:]\\s*\\{?\\s*["'\`]${id}["'\`]`, 'u').exec(text);
  if (hit === null) return undefined;
  if (property !== undefined && !/^\d+$/u.test(property)) {
    const after = text.slice(hit.index).search(new RegExp(`"${escapeRegExp(property)}"\\s*:`, 'u'));
    if (after >= 0) return hit.index + after;
  }
  return hit.index;
}

/** Der Code-Tab: `project.json` mit Schema-Validierung; TSX-Quellen nur lesend. */
export function Code(): ReactNode {
  const [studio, state] = useStudio();
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | undefined>(undefined);
  const monacoRef = useRef<Monaco | undefined>(undefined);
  const applying = useRef(false);
  const [dirty, setDirty] = useState(studio.codeDraft !== undefined);
  const [loaded, setLoaded] = useState(false);
  const tsx = state.kind === 'tsx';
  const text = tsx ? (state.sourceText ?? '') : state.projectText;
  const saveRef = useRef<() => void>(() => undefined);
  saveRef.current = () => {
    const value = editor.current?.getValue();
    if (tsx || value === undefined) return;
    void studio.saveCode(value).then((ok) => {
      if (ok) {
        studio.codeDraft = undefined;
        setDirty(false);
      }
    });
  };

  useEffect(() => {
    let disposed = false;
    void import('../monaco.js').then(({ monaco }) => {
      if (disposed || host.current === null) return;
      monacoRef.current = monaco;
      const uri = monaco.Uri.parse(tsx ? `file:///${state.entry}` : 'file:///project.json');
      const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(studio.codeDraft ?? text, tsx ? 'typescript' : 'json', uri);
      const ed = monaco.editor.create(host.current, {
        model,
        theme: 'openvideo',
        readOnly: tsx,
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        tabSize: 2,
        scrollBeyondLastLine: false,
        ariaLabel: tsx ? `${state.entry} (read-only)` : 'project.json editor',
      });
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        saveRef.current();
      });
      ed.onDidChangeModelContent(() => {
        if (applying.current) return;
        studio.codeDraft = ed.getValue();
        setDirty(true);
      });
      editor.current = ed;
      setLoaded(true);
    });
    return () => {
      disposed = true;
      editor.current?.dispose();
      editor.current = undefined;
    };
    // Der Editor entsteht einmal je Tab-Öffnung; Inhalte folgen über die Effekte unten.
  }, []);

  // Neuer Server-Stand: übernehmen, solange keine eigenen Änderungen offen sind.
  useEffect(() => {
    const ed = editor.current;
    if (ed === undefined || dirty || ed.getValue() === text) return;
    applying.current = true;
    const position = ed.getPosition();
    ed.setValue(text);
    if (position !== null) ed.setPosition(position);
    applying.current = false;
  }, [text, dirty, loaded]);

  // Sprung aus den Diagnosen.
  useEffect(() => {
    const ed = editor.current;
    const target = state.reveal;
    const model = ed?.getModel();
    if (ed === undefined || target === undefined || model === null || model === undefined) return;
    let line = tsx ? target.line : undefined;
    if (line === undefined) {
      const offset = locateInText(model.getValue(), target);
      if (offset !== undefined) line = model.getPositionAt(offset).lineNumber;
    }
    if (line === undefined) return;
    ed.revealLineInCenter(line);
    ed.setSelection({ startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line) });
    ed.focus();
  }, [state.reveal, loaded, tsx]);

  return (
    <div className="code">
      <div className="row-actions">
        <strong>{tsx ? state.entry : 'project.json'}</strong>
        {tsx ? (
          <span className="badge" role="note">
            read-only: TSX source is edited in your editor; Studio changes are written back through patches
          </span>
        ) : (
          <>
            <button type="button" onClick={() => { saveRef.current(); }} disabled={!dirty}>
              Save (Ctrl+S)
            </button>
            {dirty && (
              <button
                type="button"
                onClick={() => {
                  studio.codeDraft = undefined;
                  setDirty(false);
                }}
              >
                Discard changes
              </button>
            )}
            <span className="muted small">{dirty ? 'Unsaved changes' : 'In sync with the server'}</span>
          </>
        )}
      </div>
      {state.draftConflict && dirty && (
        <p className="conflict" role="alert">
          project.json changed outside the Studio. Save keeps your edits and overwrites that change; Discard loads the new version.
        </p>
      )}
      <div className="editor-host" ref={host}>
        {!loaded && <p className="empty">Loading editor…</p>}
      </div>
    </div>
  );
}

/** Der Diagnostics-Tab. */
export function Diagnostics(): ReactNode {
  const [studio, state] = useStudio();
  const list = state.diagnostics;
  const count = (s: string): number => list.filter((d) => d.severity === s).length;
  return (
    <div className="diagnostics">
      <div className="row-actions">
        <span>
          Frame {state.frame}: {count('error')} error(s), {count('warning')} warning(s), {count('info')} note(s)
        </span>
        <button type="button" onClick={() => void studio.refreshDiagnostics()}>
          Refresh
        </button>
      </div>
      {list.length === 0 ? (
        <p className="empty">No diagnostics for this frame.</p>
      ) : (
        <ul className="diag-list" aria-label="Diagnostics">
          {list.map((d, i) => (
            <li key={`${d.code}-${String(i)}`}>
              <button
                type="button"
                className={`diag ${d.severity}`}
                onClick={() => {
                  studio.reveal({ ...(d.nodeId !== undefined ? { nodeId: d.nodeId } : {}), ...(d.pointer !== undefined ? { pointer: d.pointer } : {}) });
                }}
              >
                <span className={`sev ${d.severity}`}>{d.severity}</span> <code>{d.code}</code> {d.problem}
                {d.nodeId !== undefined && <span className="muted small"> · node {d.nodeId}</span>}
                {d.suggestions[0] !== undefined && <span className="suggestion small">Fix: {d.suggestions[0]}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Der Render-Queue-Tab. */
export function RenderQueue(): ReactNode {
  const [studio, state] = useStudio();
  const profiles: RenderPreset[] = [
    ...RENDER_PRESETS,
    ...records(state.project?.['renderProfiles']).map((p) => ({ key: `profile:${str(p['id'], '')}`, label: `Project profile ${str(p['id'], '')} (${str(p['format'], '')})`, operation: 'video.render' as const, input: { profileId: str(p['id'], '') } })),
  ];
  const [key, setKey] = useState('preview');
  const [useRange, setUseRange] = useState(true);
  const preset = profiles.find((p) => p.key === key) ?? profiles[0];
  const hasRange = state.inPoint !== undefined || state.outPoint !== undefined;
  return (
    <div className="queue">
      <div className="row-actions">
        <label>
          Profile{' '}
          <select
            value={preset?.key}
            onChange={(e) => {
              setKey(e.currentTarget.value);
            }}
          >
            {profiles.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {hasRange && preset?.operation === 'preview.render' && (
          <label title="Render only the in/out range of the timeline">
            <input type="checkbox" checked={useRange} onChange={(e) => { setUseRange(e.currentTarget.checked); }} /> Only in/out ({state.inPoint ?? 0}–{state.outPoint ?? '…'})
          </label>
        )}
        <button type="button" onClick={() => preset !== undefined && void studio.startRender(preset, useRange)}>
          Start render
        </button>
      </div>
      {state.jobs.length === 0 ? (
        <p className="empty">No render jobs for this project yet.</p>
      ) : (
        <ul className="job-list" aria-label="Render jobs">
          {state.jobs.map((j) => {
            const pct = j.total > 0 ? Math.round((j.done / j.total) * 100) : j.state === 'succeeded' ? 100 : 0;
            const active = j.state === 'queued' || j.state === 'running';
            return (
              <li key={j.id} className={`job ${j.state}`} aria-label={`${j.label}: ${j.state}`}>
                <span className="job-label">{j.label}</span>
                <span className={`job-state ${j.state}`} data-state={j.state}>
                  {j.state}
                </span>
                <progress max={100} value={pct} aria-label={`Progress of ${j.label}`}>
                  {pct} %
                </progress>
                <span className="muted small">
                  {j.stage} {j.total > 0 ? `${String(j.done)}/${String(j.total)}` : ''}
                </span>
                {active && (
                  <button type="button" onClick={() => void studio.cancelJob(j.id)}>
                    Cancel
                  </button>
                )}
                {j.outputs.map((url) => (
                  <a
                    key={url}
                    href={url}
                    download
                    onClick={(e) => {
                      if (!needsAuthFetch()) return;
                      e.preventDefault();
                      downloadWithAuth(url).catch((error: unknown) => {
                        console.warn('OpenVideo Studio: download failed', error);
                      });
                    }}
                  >
                    {url.split('/').pop()}
                  </a>
                ))}
                {j.error !== undefined && <span className="error small">{j.error}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
