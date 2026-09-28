/**
 * Einstieg: `?project=<id>` öffnet ein Projekt direkt, sonst erscheint die Projektliste.
 */
import { StrictMode, useEffect, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { call, errorText } from './api.js';
import { App } from './App.js';
import { StudioContext } from './context.js';
import { records, str } from './json.js';
import { Studio } from './store.js';
import './styles.css';

function ProjectPicker(): ReactNode {
  const [projects, setProjects] = useState<{ id: string; name: string; kind: string }[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  useEffect(() => {
    call('project.inspect', {})
      .then((r) => {
        setProjects(records(r['projects']).map((p) => ({ id: str(p['id'], ''), name: str(p['name'], ''), kind: str(p['kind'], 'json') })));
      })
      .catch((e: unknown) => {
        setError(errorText(e));
      });
  }, []);
  return (
    <main className="picker">
      <h1>OpenVideo Studio</h1>
      <h2>Open a project</h2>
      {error !== undefined && <p role="alert">{error}</p>}
      {projects === undefined && error === undefined && <p>Loading projects…</p>}
      {projects?.length === 0 && <p>No projects yet. Create one with <code>openvideo create</code> or the operation <code>project.create</code>.</p>}
      <ul>
        {projects?.map((p) => (
          <li key={p.id}>
            <a href={`?project=${encodeURIComponent(p.id)}`}>
              {p.name} <span className="muted small">({p.id}, {p.kind})</span>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}

function Root(): ReactNode {
  const projectId = new URLSearchParams(window.location.search).get('project');
  const [studio] = useState(() => (projectId !== null && projectId !== '' ? new Studio(projectId) : undefined));
  useEffect(() => {
    if (studio !== undefined) void studio.load();
  }, [studio]);
  if (studio === undefined) return <ProjectPicker />;
  return (
    <StudioContext.Provider value={studio}>
      <App />
    </StudioContext.Provider>
  );
}

const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
