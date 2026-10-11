import React, { useCallback, useState } from 'react';
import { CircleHelp, FolderPlus, LoaderCircle, Plus, RefreshCw, Sparkles, X } from 'lucide-react';
import { useApp } from './state/AppContext.jsx';
import Sidebar from './components/Sidebar.jsx';
import Topbar from './components/Topbar.jsx';
import Toasts from './components/Toasts.jsx';
import ApprovalModal from './components/ApprovalModal.jsx';
import Modal from './components/Modal.jsx';
import Chat from './pages/Chat.jsx';
import Files from './pages/Files.jsx';
import Terminal from './pages/Terminal.jsx';
import Mcp from './pages/Mcp.jsx';
import Plugins from './pages/Plugins.jsx';
import Skills from './pages/Skills.jsx';
import Memory from './pages/Memory.jsx';
import Projects from './pages/Projects.jsx';
import Settings from './pages/Settings.jsx';

const EMPTY_PROJECT = { name: '', description: '', instructions: '' };

/** Keeps a render error inside one page instead of blanking the whole window. */
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prevProps) {
    if (prevProps.pageKey !== this.props.pageKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (this.state.error) {
      return (
        <section className="content-page">
          <div className="panel-card">
            <div className="empty-panel">
              <div className="empty-icon"><CircleHelp size={21} /></div>
              <b>Bu sahifada xatolik yuz berdi</b>
              <span>{String(this.state.error?.message || this.state.error)}</span>
              <div className="cb-empty-actions">
                <button type="button" className="primary-btn" onClick={() => this.setState({ error: null })}>
                  <RefreshCw size={15} /> Qayta urinish
                </button>
                <button type="button" className="secondary-btn" onClick={() => window.location.reload()}>Ilovani yangilash</button>
              </div>
            </div>
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const {
    activeProjectId, projects = [], health, models = [], model, busy, error, loading, settings,
    toasts, dismissToast, approvals, resolvePermission, refreshAll, setError,
    selectProject, createProject, deleteProject, createSession, pushToast,
  } = useApp();

  const [page, setPage] = useState('Chat');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [projectModal, setProjectModal] = useState(false);
  const [projectForm, setProjectForm] = useState(EMPTY_PROJECT);
  const [creating, setCreating] = useState(false);

  const activeProject = projects.find((item) => item.id === activeProjectId) || null;

  const navigate = useCallback((next) => {
    setPage(next);
    setError('');
  }, [setError]);

  const startNewChat = useCallback(async () => {
    navigate('Chat');
    if (!activeProjectId) return;
    await createSession('Yangi chat');
  }, [navigate, activeProjectId, createSession]);

  const openProject = useCallback(async (id) => {
    await selectProject(id);
    navigate('Chat');
  }, [selectProject, navigate]);

  async function submitProject(event) {
    event.preventDefault();
    const name = projectForm.name.trim();
    if (!name || creating) return;
    setCreating(true);
    const created = await createProject({
      name,
      description: projectForm.description.trim(),
      instructions: projectForm.instructions.trim(),
    });
    setCreating(false);
    if (created) {
      setProjectForm(EMPTY_PROJECT);
      setProjectModal(false);
      navigate('Chat');
    }
  }

  async function removeProject(project) {
    if (!project || project.id === 'general') {
      pushToast('General projectini o‘chirib bo‘lmaydi.', 'warn');
      return;
    }
    const ok = window.confirm(`“${project.name}” loyihasi va uning chat tarixi o‘chiriladi. Davom etamizmi?`);
    if (!ok) return;
    await deleteProject(project.id);
  }

  const showSkeleton = loading && !projects.length && !settings?.model;

  return (
    <div className="app-shell">
      <Sidebar
        page={page}
        onNavigate={navigate}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((value) => !value)}
        projects={projects}
        activeProjectId={activeProjectId}
        onSelectProject={openProject}
        onCreateProject={() => setProjectModal(true)}
        onDeleteProject={removeProject}
        onNewChat={startNewChat}
        onRefresh={refreshAll}
        health={health}
        models={models}
        model={model}
        busy={busy}
      />

      <main className="main-area">
        <Topbar
          page={page}
          projectName={activeProject?.name}
          health={health}
          modelCount={Array.isArray(health?.ollama?.models) ? health.ollama.models.length : models.length}
          onRefresh={refreshAll}
          onNewChat={startNewChat}
          onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
          sidebarCollapsed={sidebarCollapsed}
          busy={busy}
        />

        {error ? (
          <div className="error-banner">
            <CircleHelp size={16} />
            <span>{error}</span>
            <button type="button" onClick={() => setError('')} title="Yopish" aria-label="Yopish"><X size={15} /></button>
          </div>
        ) : null}

        {showSkeleton ? (
          <div className="loading-state"><LoaderCircle className="spin" size={25} /><span>CodeBase ochilmoqda…</span></div>
        ) : (
          <ErrorBoundary pageKey={page}>
            {page === 'Chat' ? <Chat /> : null}
            {page === 'Files' ? <Files /> : null}
            {page === 'Terminal' ? <Terminal /> : null}
            {page === 'MCP' ? <Mcp /> : null}
            {page === 'Plugins' ? <Plugins /> : null}
            {page === 'Skills' ? <Skills /> : null}
            {page === 'Memory' ? <Memory /> : null}
            {page === 'Projects' ? <Projects onOpenProject={openProject} /> : null}
            {page === 'Settings' ? <Settings /> : null}
          </ErrorBoundary>
        )}

        <footer className="app-footer">
          <span><span className="footer-dot" /> CodeBase {health?.version ? `v${health.version}` : 'desktop'}</span>
          <span>Local & private <Sparkles size={12} /></span>
        </footer>
      </main>

      <Toasts toasts={toasts} onDismiss={dismissToast} />

      <ApprovalModal requests={approvals} onResolve={resolvePermission} />

      <Modal
        open={projectModal}
        onClose={() => setProjectModal(false)}
        icon={<FolderPlus size={19} />}
        title="Create a project"
        description="Yangi loyiha uchun alohida chat sessiyalari va instructions yarating."
        footer={(
          <>
            <button type="button" className="secondary-btn" onClick={() => setProjectModal(false)}>Cancel</button>
            <button type="button" className="primary-btn" onClick={submitProject} disabled={creating || !projectForm.name.trim()}>
              <Plus size={15} /> {creating ? 'Creating…' : 'Create project'}
            </button>
          </>
        )}
      >
        <form className="modal-form" onSubmit={submitProject}>
          <label>
            Project name
            <input
              data-autofocus
              maxLength={80}
              value={projectForm.name}
              onChange={(event) => setProjectForm({ ...projectForm, name: event.target.value })}
              placeholder="e.g. Roblox Car Parking"
              required
            />
          </label>
          <label>
            Description <span className="optional">optional</span>
            <input
              maxLength={500}
              value={projectForm.description}
              onChange={(event) => setProjectForm({ ...projectForm, description: event.target.value })}
              placeholder="What are you building?"
            />
          </label>
          <label>
            Project instructions <span className="optional">optional</span>
            <textarea
              rows={3}
              maxLength={5000}
              value={projectForm.instructions}
              onChange={(event) => setProjectForm({ ...projectForm, instructions: event.target.value })}
              placeholder="Preferred stack, conventions, goals…"
            />
          </label>
        </form>
      </Modal>
    </div>
  );
}
