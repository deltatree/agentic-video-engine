/**
 * Einstieg: `?project=<id>` öffnet ein Projekt direkt, sonst erscheint die Projektliste
 * mit Suche und „Neues Projekt“ (leer oder aus einem Template, Story 20.8).
 */
import { StrictMode, useEffect, useState, type ReactNode, type SyntheticEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { call, errorText } from './api.js';
import { App } from './App.js';
import { StudioContext } from './context.js';
import { records, str } from './json.js';
import { matchesQuery } from './panels/Library.js';
import { Studio } from './store.js';
import './styles.css';

interface ProjectItem {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly updated: string;
}

interface TemplateItem {
  readonly name: string;
  readonly title: string;
  readonly description: string;
}

function NewProject(props: { templates: readonly TemplateItem[] | undefined }): ReactNode {
  const [name, setName] = useState('');
  const [template, setTemplate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const submit = (e: SyntheticEvent): void => {
    e.preventDefault();
    const clean = name.trim();
    if (clean === '') {
      setError('Give the project a name.');
      return;
    }
    setBusy(true);
    setError(undefined);
    call('project.create', { name: clean, ...(template !== '' ? { template } : {}) })
      .then((r) => {
        window.location.search = `?project=${encodeURIComponent(str(r['projectId'], ''))}`;
      })
      .catch((err: unknown) => {
        setError(errorText(err));
        setBusy(false);
      });
  };
  const chosen = props.templates?.find((t) => t.name === template);
  return (
    <form className="new-project" onSubmit={submit} aria-labelledby="new-project-title">
      <h2 id="new-project-title">New project</h2>
      <label>
        Name <input value={name} onChange={(e) => { setName(e.currentTarget.value); }} placeholder="Launch video" required />
      </label>
      <label>
        Start from{' '}
        <select value={template} onChange={(e) => { setTemplate(e.currentTarget.value); }}>
          <option value="">Empty composition (1920×1080, 30 fps, 10 s)</option>
          {props.templates?.map((t) => (
            <option key={t.name} value={t.name}>
              Template: {t.title}
            </option>
          ))}
        </select>
      </label>
      {chosen !== undefined && <p className="muted small">{chosen.description}</p>}
      {error !== undefined && <p role="alert" className="error">{error}</p>}
      <button type="submit" disabled={busy}>
        {busy ? 'Creating…' : 'Create and open'}
      </button>
    </form>
  );
}

function ProjectPicker(): ReactNode {
  const [projects, setProjects] = useState<ProjectItem[] | undefined>(undefined);
  const [templates, setTemplates] = useState<TemplateItem[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setError(undefined);
    call('project.inspect', {})
      .then((r) => {
        setProjects(records(r['projects']).map((p) => ({ id: str(p['id'], ''), name: str(p['name'], ''), kind: str(p['kind'], 'json'), updated: str(p['updated'], '') })));
      })
      .catch((e: unknown) => {
        setError(errorText(e));
      });
    call('templates.list', {})
      .then((r) => {
        setTemplates(records(r['templates']).map((t) => ({ name: str(t['name'], ''), title: str(t['title'], str(t['name'], '')), description: str(t['description'], '') })));
      })
      .catch((e: unknown) => {
        console.warn('OpenVideo Studio: templates not available', e);
        setTemplates([]);
      });
  }, [attempt]);
  const shown = projects?.filter((p) => matchesQuery({ name: `${p.name} ${p.id}`, description: p.kind }, query));
  return (
    <main className="picker">
      <h1>OpenVideo Studio</h1>
      <p className="muted">Open a project to edit it visually. Agents, the CLI and your editor can change the same project at the same time; the Studio follows their changes live.</p>
      {error !== undefined && (
        <div role="alert">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => {
              setAttempt(attempt + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}
      <NewProject templates={templates} />
      <h2>Open a project</h2>
      {projects === undefined && error === undefined && <p role="status">Loading projects…</p>}
      {projects !== undefined && projects.length > 0 && (
        <input type="search" aria-label="Search projects" placeholder="Search projects…" value={query} onChange={(e) => { setQuery(e.currentTarget.value); }} />
      )}
      {projects?.length === 0 && <p>No projects yet. Create one above, with <code>openvideo create</code> or with the operation <code>project.create</code>.</p>}
      {shown !== undefined && shown.length === 0 && projects !== undefined && projects.length > 0 && <p>No project matches “{query}”.</p>}
      <ul aria-label="Projects">
        {shown?.map((p) => (
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
    if (studio === undefined) return undefined;
    void studio.load();
    return () => {
      studio.dispose();
    };
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
