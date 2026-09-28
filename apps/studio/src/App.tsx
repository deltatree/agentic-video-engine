/**
 * Hauptfenster nach A25: Toolbar oben; links Scene Tree/Assets/Components; Mitte Preview;
 * rechts Inspector/Properties/Effects; darunter Timeline/Audio/Keyframes/Curves;
 * ganz unten Code/Diagnostics/Render Queue. Alle Panels sind in der Größe verstellbar.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStudio } from './context.js';
import { formatFrame } from './ir.js';
import { isTyping, keyState, spaceActivates } from './keys.js';
import { Audio, Curves, Keyframes } from './panels/Animation.js';
import { Code, Diagnostics, RenderQueue } from './panels/Bottom.js';
import { Effects, Inspector } from './panels/Inspector.js';
import { Assets, Components } from './panels/Library.js';
import { Preview } from './panels/Preview.js';
import { SceneTree } from './panels/SceneTree.js';
import { Timeline } from './panels/Timeline.js';
import type { BottomTab } from './store.js';
import { Splitter, Tabs } from './ui.js';

/** Alle Tastenkürzel (für den Hilfe-Dialog). */
export const SHORTCUTS: readonly (readonly [string, string])[] = [
  ['Ctrl+Z', 'Undo'],
  ['Ctrl+Shift+Z / Ctrl+Y', 'Redo'],
  ['Ctrl+C', 'Copy selection'],
  ['Ctrl+V', 'Paste'],
  ['Ctrl+D', 'Duplicate selection'],
  ['Delete', 'Delete selection'],
  ['Ctrl+G', 'Group selection'],
  ['Space', 'Play / pause (hold and drag on the stage to pan)'],
  ['← / →', 'Previous / next frame (Shift: 10 frames)'],
  ['Home / End', 'First / last frame'],
  ['Ctrl + / Ctrl − / Ctrl 0', 'Zoom in / out / fit'],
  ['Arrow keys on the stage', 'Move selection by 1 px (Shift: 10 px)'],
  ['Ctrl+S in the code editor', 'Save project.json'],
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

function Toolbar(props: { onHelp: () => void }): ReactNode {
  const [studio, state] = useStudio();
  const fps = state.timeline?.fps ?? 30;
  const sel = state.selection.length;
  const align = (label: string, mode: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom', icon: string): ReactNode => (
    <button type="button" aria-label={label} title={label} disabled={sel < 2} onClick={() => void studio.align(mode)}>
      {icon}
    </button>
  );
  return (
    <header className="toolbar" role="toolbar" aria-label="Main toolbar">
      <strong className="brand">OpenVideo Studio</strong>
      <span className="project" title={state.entry}>
        {state.projectId}
        {state.kind === 'tsx' ? ' (TSX)' : ''}
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
        </span>
        <label title="Exact playback shows every frame, even when rendering is slower than real time.">
          <input type="checkbox" checked={state.exact} onChange={(e) => { studio.setExact(e.currentTarget.checked); }} /> Exact
        </label>
      </div>
      <div className="group" role="group" aria-label="Edit">
        <button type="button" onClick={() => { studio.copy(); }} disabled={sel === 0} title="Copy (Ctrl+C)">
          Copy
        </button>
        <button type="button" onClick={() => void studio.paste()} title="Paste (Ctrl+V)">
          Paste
        </button>
        <button type="button" onClick={() => void studio.duplicate()} disabled={sel === 0} title="Duplicate (Ctrl+D)">
          Duplicate
        </button>
        <button type="button" onClick={() => void studio.group()} disabled={sel === 0} title="Group (Ctrl+G)">
          Group
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
      <span className="spacer" />
      {state.busy && <span className="muted small">Saving…</span>}
      <button type="button" onClick={props.onHelp} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
        ?
      </button>
    </header>
  );
}

/** Die ganze Oberfläche. */
export function App(): ReactNode {
  const [studio, state] = useStudio();
  const [left, setLeft] = useState(260);
  const [right, setRight] = useState(320);
  const [timeline, setTimeline] = useState(220);
  const [bottom, setBottom] = useState(240);
  const [leftTab, setLeftTab] = useState<'tree' | 'assets' | 'components'>('tree');
  const [rightTab, setRightTab] = useState<'inspector' | 'properties' | 'effects'>('inspector');
  const [midTab, setMidTab] = useState<'timeline' | 'audio' | 'keyframes' | 'curves'>('timeline');
  const [help, setHelp] = useState(false);

  useEffect(() => {
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
      else if (mod && key === 'c') studio.copy();
      else if (mod && key === 'v') void studio.paste();
      else if (mod && key === 'd') void studio.duplicate();
      else if (mod && key === 'g') void studio.group();
      else if (mod && (key === '+' || key === '=')) zoom('in');
      else if (mod && key === '-') zoom('out');
      else if (mod && key === '0') zoom('fit');
      else if (mod) handled = false;
      else if (e.key === 'Delete' || e.key === 'Backspace') void studio.deleteSelection();
      else if (e.key === 'ArrowLeft') studio.step(e.shiftKey ? -10 : -1);
      else if (e.key === 'ArrowRight') studio.step(e.shiftKey ? 10 : 1);
      else if (e.key === 'Home') studio.seek(0);
      else if (e.key === 'End') studio.seek(studio.durationFrames - 1);
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
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [studio]);

  const px = (v: number): string => `${String(v)}px`;
  return (
    <div className="app" style={{ gridTemplateRows: `auto minmax(160px, 1fr) 6px ${px(timeline)} 6px ${px(bottom)} auto` }}>
      <Toolbar
        onHelp={() => {
          setHelp(true);
        }}
      />
      <div className="workspace" style={{ gridTemplateColumns: `${px(left)} 6px minmax(200px, 1fr) 6px ${px(right)}` }}>
        <Tabs
          label="Project"
          tabs={[
            { id: 'tree', label: 'Scene Tree' },
            { id: 'assets', label: 'Assets' },
            { id: 'components', label: 'Components' },
          ]}
          active={leftTab}
          onChange={setLeftTab}
        >
          {leftTab === 'tree' ? <SceneTree /> : leftTab === 'assets' ? <Assets /> : <Components />}
        </Tabs>
        <Splitter label="Resize project panel" orientation="vertical" value={left} min={160} max={600} onChange={setLeft} />
        <section className="panel center" aria-label="Preview">
          <Preview />
        </section>
        <Splitter label="Resize inspector panel" orientation="vertical" value={right} min={220} max={700} invert onChange={setRight} />
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
        >
          {rightTab === 'effects' ? <Effects /> : <Inspector mode={rightTab} />}
        </Tabs>
      </div>
      <Splitter label="Resize timeline panel" orientation="horizontal" value={timeline} min={100} max={600} invert onChange={setTimeline} />
      <Tabs
        label="Time"
        tabs={[
          { id: 'timeline', label: 'Timeline' },
          { id: 'audio', label: 'Audio' },
          { id: 'keyframes', label: 'Keyframes' },
          { id: 'curves', label: 'Curves' },
        ]}
        active={midTab}
        onChange={setMidTab}
      >
        {midTab === 'timeline' ? <Timeline /> : midTab === 'audio' ? <Audio /> : midTab === 'keyframes' ? <Keyframes /> : <Curves />}
      </Tabs>
      <Splitter label="Resize code panel" orientation="horizontal" value={bottom} min={80} max={700} invert onChange={setBottom} />
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
        }}
      >
        {state.bottomTab === 'code' ? <Code /> : state.bottomTab === 'diagnostics' ? <Diagnostics /> : <RenderQueue />}
      </Tabs>
      <footer className={`status ${state.message?.kind ?? ''}`}>
        <span role={state.message?.kind === 'error' ? 'alert' : 'status'}>{state.message?.text ?? 'Ready.'}</span>
        {state.message !== undefined && (
          <button type="button" className="icon" aria-label="Dismiss message" onClick={() => { studio.notify('info', 'Ready.'); }}>
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
