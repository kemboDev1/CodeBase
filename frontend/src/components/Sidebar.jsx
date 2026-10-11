import React, { useMemo } from 'react';
import {
  ArrowLeft, Boxes, Brain, Cpu, Folder, HardDrive, Layers3, Menu, MessageSquare, MoreHorizontal,
  Play, Plus, Puzzle, RefreshCw, Settings2, Sparkles, TerminalSquare, Trash2,
} from 'lucide-react';

const NAV_GROUPS = [
  {
    label: 'WORKSPACE',
    items: [
      { name: 'Chat', icon: MessageSquare },
      { name: 'Projects', icon: Folder },
      { name: 'Files', icon: HardDrive },
      { name: 'Terminal', icon: TerminalSquare },
    ],
  },
  {
    label: 'EXTENSIONS',
    items: [
      { name: 'MCP', icon: Boxes },
      { name: 'Plugins', icon: Puzzle },
      { name: 'Skills', icon: Layers3 },
      { name: 'Memory', icon: Brain },
    ],
  },
  {
    label: 'SYSTEM',
    items: [
      { name: 'Settings', icon: Settings2 },
    ],
  },
];

function IconButton({ title, onClick, children, className = '', disabled = false }) {
  return (
    <button type="button" className={`icon-btn ${className}`} title={title} aria-label={title} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export default function Sidebar({
  page,
  onNavigate,
  collapsed,
  onToggleCollapse,
  projects = [],
  activeProjectId,
  onSelectProject,
  onCreateProject,
  onDeleteProject,
  onNewChat,
  onRefresh,
  health,
  models = [],
  model,
  busy,
}) {
  const counts = useMemo(() => ({ Projects: projects.length }), [projects.length]);
  const connected = Boolean(health?.ollama?.connected);
  const modelCount = Array.isArray(health?.ollama?.models) ? health.ollama.models.length : models.length;

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div className="brand-row">
        <div className="brand-mark"><Sparkles size={20} strokeWidth={2.3} /></div>
        {!collapsed && (
          <>
            <div className="brand-copy"><b>CodeBase</b><span>LOCAL AI WORKSPACE</span></div>
            <button className="collapse-btn" onClick={onToggleCollapse} title="Sidebarni yopish" aria-label="Sidebarni yopish">
              <ArrowLeft size={15} />
            </button>
          </>
        )}
      </div>

      {collapsed && (
        <IconButton title="Sidebarni ochish" onClick={onToggleCollapse}><Menu size={17} /></IconButton>
      )}

      {!collapsed && (
        <button className="new-chat" onClick={onNewChat} disabled={busy}>
          <Plus size={16} /><span>{busy ? 'Agent ishlayapti…' : 'New chat'}</span><kbd>Ctrl K</kbd>
        </button>
      )}

      {NAV_GROUPS.map((group) => (
        <React.Fragment key={group.label}>
          <div className="nav-label">{group.label}</div>
          <nav className="main-nav">
            {group.items.map((item) => (
              <button
                key={item.name}
                className={`nav-item ${page === item.name ? 'active' : ''}`}
                title={item.name}
                onClick={() => onNavigate(item.name)}
              >
                <item.icon size={17} />
                {!collapsed && (
                  <>
                    <span>{item.name}</span>
                    {counts[item.name] !== undefined && <span className="nav-count">{counts[item.name]}</span>}
                  </>
                )}
              </button>
            ))}
          </nav>
        </React.Fragment>
      ))}

      {!collapsed && (
        <div className="project-section">
          <div className="section-heading">
            <span>YOUR PROJECTS</span>
            <IconButton title="Yangi project" onClick={onCreateProject}><Plus size={15} /></IconButton>
          </div>
          <div className="project-list">
            {projects.slice(0, 7).map((project) => (
              <div className={`project-entry ${project?.id === activeProjectId ? 'selected' : ''}`} key={project?.id}>
                <button onClick={() => onSelectProject?.(project?.id)} title={project?.name}>
                  <span className="project-dot" />
                  <span className="project-name">{project?.name || 'Untitled'}</span>
                </button>
                {project?.id !== 'general' && (
                  <IconButton title="Projectni o‘chirish" className="project-delete" onClick={() => onDeleteProject?.(project)}>
                    <Trash2 size={13} />
                  </IconButton>
                )}
              </div>
            ))}
            {!projects.length && <div className="sidebar-empty">Hozircha project yo‘q. “+” bilan yarating.</div>}
          </div>
          <button className="all-projects" onClick={() => onNavigate('Projects')}>
            <Folder size={14} /> All projects
          </button>
        </div>
      )}

      <div className="sidebar-bottom">
        {!collapsed && (
          <div className="model-status-card">
            <div className="model-card-top">
              <span className={`status-led ${connected ? 'online' : ''}`} />
              <span>{connected ? 'Ollama connected' : 'Ollama offline'}</span>
              <IconButton title="Holatni yangilash" onClick={onRefresh}><RefreshCw size={13} /></IconButton>
            </div>
            <div className="model-card-name"><Cpu size={14} /><span>{model || 'No model detected'}</span></div>
            <div className="model-card-note">
              {connected ? `${modelCount} model available locally` : 'Start Ollama to enable chat'}
            </div>
            {busy && <div className="model-card-note running"><Play size={11} /> agent running…</div>}
          </div>
        )}
        {!collapsed && (
          <div className="sidebar-foot-note">
            {health?.service || 'CodeBase API'} · v{health?.version || '—'} · port {health?.port ?? '—'}
          </div>
        )}
        <button className="profile-row" onClick={() => onNavigate('Settings')} title="Settings">
          <div className="avatar"><Settings2 size={16} /></div>
          {!collapsed && (
            <>
              <div className="profile-copy"><b>Local workspace</b><span>Personal environment</span></div>
              <MoreHorizontal size={17} />
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
