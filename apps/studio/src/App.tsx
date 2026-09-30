/**
 * Hauptfenster nach A25: Toolbar oben; links Scene Tree/Assets/Components; Mitte Preview;
 * rechts Inspector/Properties/Effects; darunter Timeline/Audio/Keyframes/Curves;
 * ganz unten Code/Diagnostics/Render Queue. Alle Panels sind in der Größe verstellbar und
 * einklappbar; Größen und Zustand bleiben pro Browser gespeichert (Story 20.8).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NODES_MIME } from './clipboard.js';
import { useStudio } from './context.js';
import { formatFrame } from './ir.js';
import { isTyping, keyState, spaceActivates } from './keys.js';
import { loadLayout, saveLayout, type Layout, type PanelId, PANEL_LIMITS } from './layout.js';
import { Audio, Curves, Keyframes } from './panels/Animation.js';
import { Code, Diagnostics, RenderQueue } from './panels/Bottom.js';
import { Effects, Inspector } from './panels/Inspector.js';
import { Assets, Components } from './panels/Library.js';
import { Preview } from './panels/Preview.js';
import { SceneTree } from './panels/SceneTree.js';
import { Timeline } from './panels/Timeline.js';
import type { BottomTab, Studio } from './store.js';
import { Splitter, Tabs, useRovingToolbar } from './ui.js';

/** Alle Tastenkürzel (für den Hilfe-Dialog). */
export const SHORTCUTS: readonly (readonly [string, string])[] = [
  ['Ctrl+Z', 'Undo'],
  ['Ctrl+Shift+Z / Ctrl+Y', 'Redo'],
  ['Ctrl+C / Ctrl+X', 'Copy / cut selection (also to the system clipboard as JSON)'],
  ['Ctrl+V', 'Paste (nodes from the system clipboard or the Studio)'],
  ['Ctrl+D', 'Duplicate selection'],
  ['Delete', 'Delete selection'],
  ['Backspace', 'Delete selection (only when the stage or the Scene Tree has focus)'],
  ['Ctrl+G / Ctrl+Shift+G', 'Group / ungroup selection'],
  ['Ctrl+] / Ctrl+[', 'Bring forward / send backward'],
  ['Ctrl+Shift+] / Ctrl+Shift+[', 'Bring to front / send to back'],
  ['Space', 'Play / pause (hold and drag on the stage to pan)'],
  ['J / K / L', 'Play backwards / stop / play forwards (press again for 2×, 4×, 8×)'],
  ['← / →', 'Previous / next frame (Shift: 10 frames)'],
  ['Ctrl+← / Ctrl+→', 'Previous / next keyframe (of the selection, or of all nodes)'],
  ['Home / End', 'First / last frame'],
  ['I / O / Alt+X', 'Set in point / set out point / clear both (playback loops inside)'],
  ['M', 'Add a marker at the playhead'],
  ['Ctrl + / Ctrl − / Ctrl 0', 'Zoom in / out / fit'],
  ['Tab / Shift+Tab on the stage', 'Select the next / previous node'],
  ['Arrow keys on the stage', 'Move selection by 1 px (Shift: 10 px); quick repeats are one undo step'],
  ['Shift while resizing / rotating', 'Keep aspect ratio / snap to 15°'],
  ['Alt while dragging', 'Turn snapping off'],
  ['[ / ] on a timeline bar or clip', 'Trim the start (Shift: 10 frames); Alt+← / → trims the end'],
  ['F2 / Delete on a marker', 'Rename / delete the marker'],
  ['Ctrl+S in the code editor', 'Save project.json (undoable)'],
  ['Escape', 'Clear selection / close dialog'],
  ['?', 'Show this help'],
];

function zoom(detail: 'in' | 'out' | 'fit'): void {
  window.dispatchEvent(new CustomEvent('openvideo:zoom', { detail }));
}

function HelpDialog(props: { open: boolean; onClose: () => void }): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (props.open && !d.open) d.showModal();
    if (!props.open && d.open) d.close();
  }, [props.open]);
  return (
    <dialog ref={ref} aria-labelledby="help-title" onClose={props.onClose} className="help">
      <h2 id="help-title">Keyboard shortcuts</h2>
      <table>
        <tbody>
          {SHORTCUTS.map(([keys, action]) => (
            <tr key={keys}>
              <th scope="row">
                <kbd>{keys}</kbd>
              </th>
              <td>{action}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={props.onClose} autoFocus>
        Close
      </button>
    </dialog>
  );
}

/** Kopiert in die System-Zwischenablage (Toolbar-Knopf; ohne Berechtigung bleibt die Studio-Zwischenablage). */
function copyToSystem(text: string | undefined): void {
  if (text === undefined || typeof navigator.clipboard === 'undefined') return;
  navigator.clipboard.writeText(text).catch((error: unknown) => {
    console.warn('OpenVideo Studio: system clipboard not available', error);
  });
}

/** Liest die System-Zwischenablage (Toolbar-Knopf) und fügt ein; ohne Berechtigung die Studio-Zwischenablage. */
async function pasteFromSystem(studio: Studio): Promise<void> {
  let text: string | undefined;
  try {
    text = typeof navigator.clipboard === 'undefined' ? undefined : await navigator.clipboard.readText();
  } catch (error) {
    console.warn('OpenVideo Studio: system clipboard not readable', error);
  }
  await studio.paste(text);
}

function Toolbar(props: { onHelp: () => void; layout: Layout; onTogglePanel: (p: PanelId) => void }): ReactNode {
  const [studio, state] = useStudio();
  const ref = useRef<HTMLElement>(null);
  const onKeyDown = useRovingToolbar(ref);
  const fps = state.timeline?.fps ?? 30;
  const sel = state.selection.length;
  const align = (label: string, mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom', icon: string): ReactNode => (
    <button type="button" aria-label={label} title={label} disabled={sel < 2} onClick={() => void studio.align(mode)}>
      {icon}
    </button>
  );
  const panel = (id: PanelId, label: string): ReactNode => (
    <button type="button" aria-pressed={!props.layout.collapsed[id]} onClick={() => { props.onTogglePanel(id); }} title={`Show or hide the ${label} panel`}>
      {label}
    </button>
  );
  const liveText = state.live === 'live' ? 'Live' : state.live === 'connecting' ? 'Connecting…' : 'Offline';
  return (
    <header className="toolbar" role="toolbar" aria-label="Main toolbar" ref={ref} onKeyDown={onKeyDown}>
      <strong className="brand">OpenVideo Studio</strong>
      <span className="project" title={state.entry}>
        {state.projectId}
        {state.kind === 'tsx' ? ' (TSX)' : ''}
      </span>
      <span className={`live ${state.live}`} title={state.live === 'live' ? 'Changes from agents, the CLI or your editor appear automatically.' : 'Live updates are not connected; the Studio retries automatically.'}>
        <span aria-hidden="true">●</span> {liveText}
      </span>
      <div className="group" role="group" aria-label="History">
        <button type="button" onClick={() => void studio.undo()} disabled={!state.canUndo} title="Undo (Ctrl+Z)">
          Undo
        </button>
        <button type="button" onClick={() => void studio.redo()} disabled={!state.canRedo} title="Redo (Ctrl+Shift+Z)">
          Redo
        </button>
      </div>
      <div className="group" role="group" aria-label="Playback">
        <button type="button" aria-label="Previous frame" onClick={() => { studio.step(-1); }}>
          ◀︎
        </button>
        <button type="button" onClick={() => { studio.togglePlay(); }} aria-label={state.playing ? 'Pause' : 'Play'} aria-pressed={state.playing}>
          {state.playing ? '❚❚' : '▶'}
        </button>
        <button type="button" aria-label="Next frame" onClick={() => { studio.step(1); }}>
          ▶︎|
        </button>
        <span className="timecode" aria-label="Current time">
          {formatFrame(state.frame, fps, 'smpte')} · {state.frame}
          {state.playing && state.speed !== 1 ? ` · ${String(state.speed)}×` : ''}
        </span>
        <label title="Exact playback shows every frame, even when rendering is slower than real time (without sound).">
          <input type="checkbox" checked={state.exact} onChange={(e) => { studio.setExact(e.currentTarget.checked); }} /> Exact
        </label>
        <button type="button" aria-pressed={state.muted} onClick={() => { studio.setMuted(!state.muted); }} title="Mute the audio preview">
          {state.muted ? 'Unmute' : 'Mute'}
        </button>
      </div>
      <div className="group" role="group" aria-label="Edit">
        <button type="button" onClick={() => { copyToSystem(studio.copy()); }} disabled={sel === 0} title="Copy (Ctrl+C)">
          Copy
        </button>
        <button type="button" onClick={() => void pasteFromSystem(studio)} title="Paste (Ctrl+V)">
          Paste
        </button>
        <button type="button" onClick={() => void studio.duplicate()} disabled={sel === 0} title="Duplicate (Ctrl+D)">
          Duplicate
        </button>
        <button type="button" onClick={() => void studio.group()} disabled={sel === 0} title="Group (Ctrl+G)">
          Group
        </button>
        <button type="button" onClick={() => void studio.ungroup()} disabled={sel === 0} title="Ungroup (Ctrl+Shift+G)">
          Ungroup
        </button>
        <button type="button" onClick={() => void studio.deleteSelection()} disabled={sel === 0} title="Delete (Del)">
          Delete
        </button>
      </div>
      <div className="group" role="group" aria-label="Align and distribute">
        {align('Align left', 'left', '⇤')}
        {align('Align center', 'center', '↔')}
        {align('Align right', 'right', '⇥')}
        {align('Align top', 'top', '⤒')}
        {align('Align middle', 'middle', '↕')}
        {align('Align bottom', 'bottom', '⤓')}
        <button type="button" aria-label="Distribute horizontally" title="Distribute horizontally" disabled={sel < 3} onClick={() => void studio.distribute('horizontal')}>
          ⋯
        </button>
        <button type="button" aria-label="Distribute vertically" title="Distribute vertically" disabled={sel < 3} onClick={() => void studio.distribute('vertical')}>
          ⋮
        </button>
      </div>
      <div className="group" role="group" aria-label="Panels">
        {panel('left', 'Project')}
        {panel('right', 'Inspector')}
        {panel('timeline', 'Time')}
        {panel('bottom', 'Output')}
      </div>
      <span className="spacer" />
      {state.busy && <span className="muted small">Saving…</span>}
      <button type="button" onClick={props.onHelp} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
        ?
      </button>
    </header>
  );
}

/** Lade- und Fehlerzustand beim Öffnen eines Projekts (Story 20.3). */
function BootScreen(): ReactNode {
  const [studio, state] = useStudio();
  if (state.status === 'loading') {
    return (
      <main className="boot" aria-busy="true">
        <h1>OpenVideo Studio</h1>
        <p role="status">Loading project {state.projectId}…</p>
      </main>
    );
  }
  return (
    <main className="boot">
      <h1>OpenVideo Studio</h1>
      <h2>The project “{state.projectId}” could not be opened</h2>
      <p role="alert">{state.loadError}</p>
      <div className="row-actions">
        <button type="button" onClick={() => void studio.load()} autoFocus>
          Retry
        </button>
        <a href="./">Choose another project</a>
      </div>
    </main>
  );
}

/** Wo Backspace die Auswahl löschen darf (Audit §19): Bühne und Szenenbaum. */
function deletesOnBackspace(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.stage, [role="tree"]') !== null;
}

/** Die ganze Oberfläche. */
export function App(): ReactNode {
  const [studio, state] = useStudio();
  const [layout, setLayout] = useState<Layout>(() => loadLayout(window.innerWidth));
  const [leftTab, setLeftTab] = useState<'tree' | 'assets' | 'components'>('tree');
  const [rightTab, setRightTab] = useState<'inspector' | 'properties' | 'effects'>('inspector');
  const [midTab, setMidTab] = useState<'timeline' | 'audio' | 'keyframes' | 'curves'>('timeline');
  const [help, setHelp] = useState(false);

  const updateLayout = (next: Layout): void => {
    setLayout(next);
    saveLayout(next);
  };
  const resize = (p: PanelId, v: number): void => {
    updateLayout({ ...layout, sizes: { ...layout.sizes, [p]: v } });
  };
  const togglePanel = (p: PanelId): void => {
    updateLayout({ ...layout, collapsed: { ...layout.collapsed, [p]: !layout.collapsed[p] } });
  };

  useEffect(() => {
    let pasteHandled = false;
    const onKey = (e: KeyboardEvent): void => {
      // Im Hilfe-Dialog gelten die Tasten des Dialogs (Escape schließt ihn).
      if (e.defaultPrevented || isTyping(e.target) || (e.target instanceof Element && e.target.closest('dialog[open]') !== null)) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (e.key === ' ') {
        if (spaceActivates(e.target)) return;
        e.preventDefault();
        if (!e.repeat) {
          keyState.space = true;
          keyState.spaceUsed = false;
        }
        return;
      }
      let handled = true;
      if (mod && key === 'z' && e.shiftKey) void studio.redo();
      else if (mod && key === 'z') void studio.undo();
      else if (mod && key === 'y') void studio.redo();
      else if (mod && (key === 'c' || key === 'x')) {
        // Kopieren läuft über das copy/cut-Ereignis (System-Zwischenablage); die Studio-Kopie entsteht sofort.
        if (key === 'c') studio.copy();
        return;
      } else if (mod && key === 'v') {
        // Kommt kein paste-Ereignis (z. B. ohne Fokus im Dokument), fügt die Studio-Zwischenablage ein.
        pasteHandled = false;
        setTimeout(() => {
          if (!pasteHandled) void studio.paste();
        }, 60);
        return;
      } else if (mod && key === 'd') void studio.duplicate();
      else if (mod && key === 'g' && e.shiftKey) void studio.ungroup();
      else if (mod && key === 'g') void studio.group();
      else if (mod && (e.key === ']' || e.key === '}')) void studio.arrange(e.shiftKey ? 'front' : 'forward');
      else if (mod && (e.key === '[' || e.key === '{')) void studio.arrange(e.shiftKey ? 'back' : 'backward');
      else if (mod && e.key === 'ArrowLeft') studio.jumpKeyframe(-1);
      else if (mod && e.key === 'ArrowRight') studio.jumpKeyframe(1);
      else if (mod && (key === '+' || key === '=')) zoom('in');
      else if (mod && key === '-') zoom('out');
      else if (mod && key === '0') zoom('fit');
      else if (mod) handled = false;
      else if (e.key === 'Delete') void studio.deleteSelection();
      else if (e.key === 'Backspace' && deletesOnBackspace(e.target)) void studio.deleteSelection();
      else if (e.key === 'ArrowLeft') studio.step(e.shiftKey ? -10 : -1);
      else if (e.key === 'ArrowRight') studio.step(e.shiftKey ? 10 : 1);
      else if (e.key === 'Home') studio.seek(0);
      else if (e.key === 'End') studio.seek(studio.durationFrames - 1);
      else if (key === 'j' || key === 'k' || key === 'l') studio.shuttle(key);
      else if (key === 'i' && !e.altKey) studio.setRange('in');
      else if (key === 'o' && !e.altKey) studio.setRange('out');
      else if (key === 'x' && e.altKey) studio.setRange('clear');
      else if (key === 'm' && !e.altKey) void studio.addMarker();
      else if (e.key === '?') setHelp(true);
      else if (e.key === 'Escape') studio.select([]);
      else handled = false;
      if (handled) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key !== ' ' || !keyState.space) return;
      keyState.space = false;
      if (!keyState.spaceUsed) studio.togglePlay();
    };
    const blocked = (e: ClipboardEvent): boolean => isTyping(e.target) || (e.target instanceof Element && e.target.closest('dialog[open]') !== null);
    const onCopy = (e: ClipboardEvent): void => {
      if (blocked(e) || e.clipboardData === null || window.getSelection()?.isCollapsed === false) return;
      const text = e.type === 'cut' ? undefined : studio.copy();
      if (e.type === 'cut') {
        void studio.cut().then((t) => {
          copyToSystem(t);
        });
        e.preventDefault();
        return;
      }
      if (text === undefined) return;
      e.clipboardData.setData('text/plain', text);
      e.clipboardData.setData(NODES_MIME, text);
      e.preventDefault();
    };
    const onPaste = (e: ClipboardEvent): void => {
      if (blocked(e) || e.clipboardData === null) return;
      pasteHandled = true;
      const text = e.clipboardData.getData(NODES_MIME) || e.clipboardData.getData('text/plain');
      e.preventDefault();
      void studio.paste(text === '' ? undefined : text);
    };
    // Ungespeicherter Code-Entwurf oder laufende Speicherung: vor dem Verlassen warnen (Story 20.3).
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      if (!studio.hasUnsavedWork()) return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCopy);
    document.addEventListener('paste', onPaste);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCopy);
      document.removeEventListener('paste', onPaste);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [studio]);

  if (state.status !== 'ready') return <BootScreen />;

  const px = (v: number): string => `${String(v)}px`;
  const c = layout.collapsed;
  const s = layout.sizes;
  const rail = (p: PanelId, label: string, side: 'left' | 'right'): ReactNode => (
    <section className={`panel rail ${side}`} aria-label={label}>
      <button type="button" className="icon" aria-label={`Expand ${label} panel`} aria-expanded="false" title={`Expand ${label} panel`} onClick={() => { togglePanel(p); }}>
        <span aria-hidden="true">{side === 'left' ? '▸' : '◂'}</span>
      </button>
    </section>
  );
  return (
    <div className="app" style={{ gridTemplateRows: `auto minmax(160px, 1fr) ${c.timeline ? '0px auto' : `6px ${px(s.timeline)}`} ${c.bottom ? '0px auto' : `6px ${px(s.bottom)}`} auto` }}>
      <Toolbar
        onHelp={() => {
          setHelp(true);
        }}
        layout={layout}
        onTogglePanel={togglePanel}
      />
      <div className="workspace" style={{ gridTemplateColumns: `${c.left ? '28px 0px' : `${px(s.left)} 6px`} minmax(200px, 1fr) ${c.right ? '0px 28px' : `6px ${px(s.right)}`}` }}>
        {c.left ? (
          rail('left', 'Project', 'left')
        ) : (
          <Tabs
            label="Project"
            tabs={[
              { id: 'tree', label: 'Scene Tree' },
              { id: 'assets', label: 'Assets' },
              { id: 'components', label: 'Components' },
            ]}
            active={leftTab}
            onChange={setLeftTab}
            onToggle={() => {
              togglePanel('left');
            }}
          >
            {leftTab === 'tree' ? <SceneTree /> : leftTab === 'assets' ? <Assets /> : <Components />}
          </Tabs>
        )}
        <Splitter label="Resize project panel" orientation="vertical" value={s.left} min={PANEL_LIMITS.left.min} max={PANEL_LIMITS.left.max} hidden={c.left} onChange={(v) => { resize('left', v); }} />
        <section className="panel center" aria-label="Preview">
          <Preview />
        </section>
        <Splitter label="Resize inspector panel" orientation="vertical" value={s.right} min={PANEL_LIMITS.right.min} max={PANEL_LIMITS.right.max} invert hidden={c.right} onChange={(v) => { resize('right', v); }} />
        {c.right ? (
          rail('right', 'Inspector', 'right')
        ) : (
          <Tabs
            label="Inspector"
            className="right"
            tabs={[
              { id: 'inspector', label: 'Inspector' },
              { id: 'properties', label: 'Properties' },
              { id: 'effects', label: 'Effects' },
            ]}
            active={rightTab}
            onChange={setRightTab}
            onToggle={() => {
              togglePanel('right');
            }}
          >
            {rightTab === 'effects' ? <Effects /> : <Inspector mode={rightTab} />}
          </Tabs>
        )}
      </div>
      <Splitter label="Resize timeline panel" orientation="horizontal" value={s.timeline} min={PANEL_LIMITS.timeline.min} max={PANEL_LIMITS.timeline.max} invert hidden={c.timeline} onChange={(v) => { resize('timeline', v); }} />
      <Tabs
        label="Time"
        tabs={[
          { id: 'timeline', label: 'Timeline' },
          { id: 'audio', label: 'Audio' },
          { id: 'keyframes', label: 'Keyframes' },
          { id: 'curves', label: 'Curves' },
        ]}
        active={midTab}
        onChange={(t) => {
          setMidTab(t);
          if (c.timeline) togglePanel('timeline');
        }}
        collapsed={c.timeline}
        onToggle={() => {
          togglePanel('timeline');
        }}
      >
        {midTab === 'timeline' ? <Timeline /> : midTab === 'audio' ? <Audio /> : midTab === 'keyframes' ? <Keyframes /> : <Curves />}
      </Tabs>
      <Splitter label="Resize code panel" orientation="horizontal" value={s.bottom} min={PANEL_LIMITS.bottom.min} max={PANEL_LIMITS.bottom.max} invert hidden={c.bottom} onChange={(v) => { resize('bottom', v); }} />
      <Tabs
        label="Output"
        tabs={[
          { id: 'code', label: 'Code' },
          { id: 'diagnostics', label: 'Diagnostics' },
          { id: 'queue', label: 'Render Queue' },
        ]}
        active={state.bottomTab}
        onChange={(t: BottomTab) => {
          studio.setBottomTab(t);
          if (c.bottom) togglePanel('bottom');
        }}
        collapsed={c.bottom}
        onToggle={() => {
          togglePanel('bottom');
        }}
      >
        {state.bottomTab === 'code' ? <Code /> : state.bottomTab === 'diagnostics' ? <Diagnostics /> : <RenderQueue />}
      </Tabs>
      <footer className={`status ${state.message?.kind ?? ''}`}>
        {/* Zwei feste Live-Regionen statt wechselnder Rolle (Audit §15): Meldungen und Fehler. */}
        <span role="status" className="status-text">
          {state.message?.kind === 'error' ? '' : (state.message?.text ?? 'Ready.')}
        </span>
        <span role="alert" className="status-text">
          {state.message?.kind === 'error' ? state.message.text : ''}
        </span>
        {state.message !== undefined && (
          <button type="button" className="icon" aria-label="Dismiss message" onClick={() => { studio.dismissMessage(); }}>
            ✕
          </button>
        )}
      </footer>
      <HelpDialog
        open={help}
        onClose={() => {
          setHelp(false);
        }}
      />
    </div>
  );
}
