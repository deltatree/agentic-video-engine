/**
 * Scene Tree: Baum der IR mit Auswahl, Umbenennen, Sperren, Verbergen,
 * Reihenfolge per Drag & Drop, Gruppieren und Löschen.
 */
import { useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useStudio } from '../context.js';
import { findNode, walkNodes } from '../ir.js';
import { str } from '../json.js';

interface Row {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly depth: number;
  readonly parentId: string | null;
  readonly index: number;
  readonly hasChildren: boolean;
  readonly visible: boolean;
  readonly locked: boolean;
}

const CONTAINERS = new Set(['group', 'layer', 'component']);

/** Der Scene-Tree-Tab. */
export function SceneTree(): ReactNode {
  const [studio, state] = useStudio();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const [focusId, setFocusId] = useState<string | undefined>(undefined);
  const [dropHint, setDropHint] = useState<{ id: string; where: 'before' | 'after' | 'inside' } | undefined>(undefined);

  const rows: Row[] = [];
  const hidden = new Set<string>();
  walkNodes(state.comp?.['nodes'], (node, where) => {
    const id = str(node['id'], '');
    if (where.parentId !== null && (collapsed.has(where.parentId) || hidden.has(where.parentId))) {
      hidden.add(id);
      return;
    }
    rows.push({
      id,
      type: str(node['type'], ''),
      name: str(node['name'], ''),
      depth: where.depth,
      parentId: where.parentId,
      index: where.index,
      hasChildren: Array.isArray(node['children']) && node['children'].length > 0,
      visible: node['visible'] !== false,
      locked: node['locked'] === true,
    });
  });
  const selected = new Set(state.selection);
  const current = focusId ?? state.selection[0] ?? rows[0]?.id;

  const choose = (id: string, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): void => {
    setFocusId(id);
    if (e.ctrlKey || e.metaKey) studio.select([id], 'toggle');
    else if (e.shiftKey && state.selection.length > 0) {
      const anchor = rows.findIndex((r) => r.id === state.selection[state.selection.length - 1]);
      const target = rows.findIndex((r) => r.id === id);
      const [a, b] = anchor < target ? [anchor, target] : [target, anchor];
      studio.select(rows.slice(a, b + 1).map((r) => r.id), 'add');
    } else studio.select([id]);
  };

  const onKey = (e: KeyboardEvent, row: Row): void => {
    const i = rows.findIndex((r) => r.id === row.id);
    const focusRow = (r: Row | undefined): void => {
      if (r === undefined) return;
      setFocusId(r.id);
      document.getElementById(`tree-${r.id}`)?.focus();
    };
    if (e.key === 'ArrowDown') focusRow(rows[i + 1]);
    else if (e.key === 'ArrowUp') focusRow(rows[i - 1]);
    else if (e.key === 'ArrowRight' && row.hasChildren) setCollapsed(new Set([...collapsed].filter((c) => c !== row.id)));
    else if (e.key === 'ArrowLeft' && row.hasChildren && !collapsed.has(row.id)) setCollapsed(new Set([...collapsed, row.id]));
    else if (e.key === 'ArrowLeft' && row.parentId !== null) focusRow(rows.find((r) => r.id === row.parentId));
    else if (e.key === 'Enter' || e.key === ' ') choose(row.id, e);
    else if (e.key === 'F2') setRenaming(row.id);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const rename = (id: string, name: string): void => {
    setRenaming(undefined);
    const before = str(findNode(state.comp, id)?.node['name'], '');
    if (name.trim() === before) return;
    void studio.patch([{ op: 'setProperty', nodeId: id, property: 'name', value: name.trim() === '' ? null : name.trim() }]);
  };

  const onDrop = (e: DragEvent, row: Row): void => {
    e.preventDefault();
    const hint = dropHint;
    setDropHint(undefined);
    const moving = e.dataTransfer.getData('application/x-openvideo-node');
    if (moving === '' || moving === row.id || hint === undefined) return;
    const from = findNode(state.comp, moving);
    if (hint.where === 'inside') {
      void studio.patch([{ op: 'moveNode', nodeId: moving, parentId: row.id }]);
      return;
    }
    // Innerhalb desselben Elternteils verschiebt sich der Index nach dem Entfernen.
    let index = row.index + (hint.where === 'after' ? 1 : 0);
    if (from !== undefined && from.parentId === row.parentId && from.index < index) index -= 1;
    void studio.patch([{ op: 'moveNode', nodeId: moving, parentId: row.parentId, index }]);
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>, row: Row): void => {
    if (!e.dataTransfer.types.includes('application/x-openvideo-node')) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientY - rect.top) / rect.height;
    const where = CONTAINERS.has(row.type) && row.type !== 'component' && rel > 0.3 && rel < 0.7 ? 'inside' : rel < 0.5 ? 'before' : 'after';
    if (dropHint?.id !== row.id || dropHint.where !== where) setDropHint({ id: row.id, where });
  };

  if (rows.length === 0) {
    return <p className="empty">No nodes yet. Add a component from the Components tab or drop an asset on the stage.</p>;
  }

  return (
    <div className="scene-tree">
      <div className="row-actions">
        <button type="button" onClick={() => void studio.group()} disabled={state.selection.length === 0}>
          Group
        </button>
        <button type="button" onClick={() => void studio.deleteSelection()} disabled={state.selection.length === 0}>
          Delete
        </button>
      </div>
      <div role="tree" aria-label="Scene tree" aria-multiselectable="true" className="tree">
        {rows.map((row) => (
          <div
            key={row.id}
            id={`tree-${row.id}`}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-selected={selected.has(row.id)}
            {...(row.hasChildren ? { 'aria-expanded': !collapsed.has(row.id) } : {})}
            tabIndex={row.id === current ? 0 : -1}
            className={`tree-row${selected.has(row.id) ? ' selected' : ''}${dropHint?.id === row.id ? ` drop-${dropHint.where}` : ''}`}
            style={{ paddingLeft: `${String(8 + row.depth * 14)}px` }}
            draggable={renaming !== row.id}
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-openvideo-node', row.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              onDragOver(e, row);
            }}
            onDragLeave={() => {
              setDropHint(undefined);
            }}
            onDrop={(e) => {
              onDrop(e, row);
            }}
            onClick={(e) => {
              choose(row.id, e);
            }}
            onDoubleClick={() => {
              setRenaming(row.id);
            }}
            onKeyDown={(e) => {
              onKey(e, row);
            }}
          >
            {row.hasChildren ? (
              <button
                type="button"
                className="icon"
                tabIndex={-1}
                aria-hidden="true"
                onClick={(e) => {
                  e.stopPropagation();
                  setCollapsed(collapsed.has(row.id) ? new Set([...collapsed].filter((c) => c !== row.id)) : new Set([...collapsed, row.id]));
                }}
              >
                {collapsed.has(row.id) ? '▸' : '▾'}
              </button>
            ) : (
              <span className="icon" aria-hidden="true" />
            )}
            {renaming === row.id ? (
              <input
                className="rename"
                aria-label={`Name of ${row.id}`}
                defaultValue={row.name}
                placeholder={row.id}
                autoFocus
                onClick={(e) => {
                  e.stopPropagation();
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') rename(row.id, e.currentTarget.value);
                  if (e.key === 'Escape') setRenaming(undefined);
                }}
                onBlur={(e) => {
                  rename(row.id, e.currentTarget.value);
                }}
              />
            ) : (
              <span className="tree-label">
                <span className={row.visible ? '' : 'muted'}>{row.name !== '' ? row.name : row.id}</span>
                <span className="muted small"> {row.type}</span>
              </span>
            )}
            <button
              type="button"
              className="icon toggle"
              aria-label={`${row.visible ? 'Hide' : 'Show'} ${row.id}`}
              aria-pressed={!row.visible}
              title={row.visible ? 'Hide' : 'Show'}
              onClick={(e) => {
                e.stopPropagation();
                void studio.patch([{ op: 'setProperty', nodeId: row.id, property: 'visible', value: row.visible ? false : null }]);
              }}
            >
              {row.visible ? '◉' : '○'}
            </button>
            <button
              type="button"
              className="icon toggle"
              aria-label={`${row.locked ? 'Unlock' : 'Lock'} ${row.id}`}
              aria-pressed={row.locked}
              title={row.locked ? 'Unlock' : 'Lock'}
              onClick={(e) => {
                e.stopPropagation();
                void studio.patch([{ op: 'setProperty', nodeId: row.id, property: 'locked', value: row.locked ? null : true }]);
              }}
            >
              {row.locked ? '🔒' : '🔓'}
            </button>
          </div>
        ))}
      </div>
      <p className="hint small">Shift/Ctrl+click selects several nodes. Double-click or F2 renames. Drag rows to reorder or into a group.</p>
    </div>
  );
}
