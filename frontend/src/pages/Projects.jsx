import React, { useMemo, useState } from 'react';
import { Activity, Folder, FolderOpen, FolderPlus, MessageSquare, Pencil, Plus, Trash2 } from 'lucide-react';
import { pickFolder } from '../api/client.js';
import { useApp } from '../state/AppContext.jsx';
import { EmptyState, LoadingState } from '../components/MarkdownLite.jsx';
import Modal from '../components/Modal.jsx';

const EMPTY_FORM = { name: '', description: '', instructions: '', root: '' };

export default function Projects({ onOpenProject }) {
  const { projects = [], createProject, updateProject, deleteProject, loading, pushToast } = useApp();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);

  const totals = useMemo(() => ({
    messages: projects.reduce((sum, project) => sum + (project?.messageCount || 0), 0),
    roots: projects.filter((project) => project?.root).length,
  }), [projects]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setEditorOpen(true);
  }

  function openEdit(project) {
    setEditing(project);
    setForm({
      name: project?.name || '',
      description: project?.description || '',
      instructions: project?.instructions || '',
      root: project?.root || '',
    });
    setEditorOpen(true);
  }

  async function chooseRoot() {
    setPicking(true);
    const picked = await pickFolder();
    setPicking(false);
    if (picked) setForm((prev) => ({ ...prev, root: picked }));
    else if (!window.codebase) pushToast('Papka tanlash faqat desktop ilovada ishlaydi; yo‘lni qo‘lda yozing.', 'warn');
  }

  async function submit(event) {
    event.preventDefault();
    const name = form.name.trim();
    if (!name || saving) return;
    setSaving(true);
    const fields = {
      name,
      description: form.description.trim(),
      instructions: form.instructions.trim(),
      root: form.root.trim() || null,
    };
    const result = editing ? await updateProject(editing.id, fields) : await createProject(fields);
    setSaving(false);
    if (result) {
      setEditorOpen(false);
      setEditing(null);
      setForm(EMPTY_FORM);
    }
  }

  async function remove(project) {
    if (!project || project.id === 'general') return;
    const ok = window.confirm(`“${project.name}” loyihasi va uning chat tarixi o‘chiriladi. Davom etamizmi?`);
    if (!ok) return;
    await deleteProject(project.id);
  }

  return (
    <section className="content-page">
      <div className="page-heading">
        <div>
          <div className="page-kicker">WORKSPACE MANAGEMENT</div>
          <h1>Your projects<span className="heading-dot">.</span></h1>
          <p>Har bir loyiha o‘z chat sessiyalari, ko‘rsatmalari va ixtiyoriy root papkasi bilan ishlaydi.</p>
        </div>
        <div className="cb-heading-actions">
          <button type="button" className="primary-btn" onClick={openCreate}><Plus size={16} /> New project</button>
        </div>
      </div>

      <div className="stats-row">
        <div className="stat-card"><Folder size={18} /><span>Projects</span><b>{projects.length}</b></div>
        <div className="stat-card"><MessageSquare size={18} /><span>Total messages</span><b>{totals.messages}</b></div>
        <div className="stat-card"><Activity size={18} /><span>Roots set</span><b>{totals.roots}</b></div>
      </div>

      {loading && !projects.length ? <LoadingState text="Loyihalar yuklanmoqda…" rows={3} /> : null}

      {!loading && !projects.length ? (
        <div className="panel-card">
          <EmptyState
            icon={<FolderPlus size={21} />}
            title="Hozircha project yo‘q"
            hint="Birinchi loyihani yaratib, unga root papka va instructions bering."
          >
            <button type="button" className="primary-btn" onClick={openCreate}><Plus size={15} /> New project</button>
          </EmptyState>
        </div>
      ) : null}

      <div className="project-cards">
        {projects.map((project, index) => (
          <div className="project-card" key={project?.id || index}>
            <div className={`project-card-icon tone-${index % 4}`}><Folder size={21} /></div>
            <div className="project-card-actions">
              <button type="button" className="icon-btn" title="Tahrirlash" onClick={() => openEdit(project)} disabled={!project?.id}>
                <Pencil size={14} />
              </button>
              <button
                type="button"
                className="icon-btn"
                title={project?.id === 'general' ? 'General projectini o‘chirib bo‘lmaydi' : 'O‘chirish'}
                onClick={() => remove(project)}
                disabled={project?.id === 'general'}
              >
                <Trash2 size={14} />
              </button>
            </div>
            <h3>{project?.name || 'Untitled'}</h3>
            <p>{project?.description || 'No description added yet.'}</p>
            <div className="project-root" title={project?.root || 'root papka tanlanmagan'}>
              {project?.root ? <><FolderOpen size={12} /> <code>{project.root}</code></> : <span className="muted-note">Root papka tanlanmagan</span>}
            </div>
            {project?.instructions ? (
              <div className="project-instructions" title={project.instructions}>{project.instructions}</div>
            ) : null}
            <div className="project-card-meta">
              <span><MessageSquare size={13} />{project?.messageCount || 0} messages</span>
              <span>{project?.updatedAt || project?.createdAt ? new Date(project.updatedAt || project.createdAt).toLocaleDateString() : '—'}</span>
            </div>
            <button className="open-project-btn" onClick={() => onOpenProject?.(project?.id)} disabled={!onOpenProject || !project?.id}>
              Open in chat <FolderOpen size={14} />
            </button>
          </div>
        ))}
      </div>

      <Modal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        size="lg"
        icon={<FolderPlus size={19} />}
        title={editing ? `Edit “${editing.name}”` : 'Create a project'}
        description="Loyiha instructions modelga har bir so‘rovda qo‘shiladi. Root papka fayl va terminal tool’lari uchun asos bo‘ladi."
        footer={(
          <>
            <button type="button" className="secondary-btn" onClick={() => setEditorOpen(false)}>Cancel</button>
            <button type="button" className="primary-btn" onClick={submit} disabled={saving || !form.name.trim()}>
              <Plus size={15} /> {saving ? 'Saving…' : editing ? 'Save changes' : 'Create project'}
            </button>
          </>
        )}
      >
        <form className="modal-form" onSubmit={submit}>
          <label>
            Project name
            <input
              data-autofocus
              maxLength={80}
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="e.g. Roblox Car Parking"
              required
            />
          </label>
          <label>
            Description <span className="optional">optional</span>
            <input
              maxLength={500}
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="What are you building?"
            />
          </label>
          <label>
            Root folder <span className="optional">fayl tool’lari uchun</span>
            <div className="field-row">
              <input
                value={form.root}
                onChange={(event) => setForm({ ...form, root: event.target.value })}
                placeholder="C:\\projects\\my-app"
                spellCheck={false}
              />
              <button type="button" className="secondary-btn" onClick={chooseRoot} disabled={picking}>
                <FolderOpen size={14} /> {picking ? '…' : 'Browse'}
              </button>
            </div>
          </label>
          <label>
            Project instructions <span className="optional">optional</span>
            <textarea
              rows={5}
              maxLength={5000}
              value={form.instructions}
              onChange={(event) => setForm({ ...form, instructions: event.target.value })}
              placeholder="Preferred stack, conventions, goals…"
            />
            <span className="field-note">{form.instructions.length} / 5000 belgi</span>
          </label>
        </form>
      </Modal>
    </section>
  );
}
