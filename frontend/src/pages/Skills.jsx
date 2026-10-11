import React, { useMemo, useState } from 'react';
import {
  ChevronDown, ChevronRight, Download, FileCode2, Layers3, Pencil, Plus, Sparkles, Trash2, Zap,
} from 'lucide-react';
import { useApp } from '../state/AppContext.jsx';
import { EmptyState, LoadingState } from '../components/MarkdownLite.jsx';
import Modal from '../components/Modal.jsx';

const EMPTY_FORM = { name: '', description: '', content: '', whenToUse: '' };
const MAX_NAME = 80;
const MAX_DESCRIPTION = 300;
const MAX_CONTENT = 5000;

const SOURCE_LABEL = {
  builtin: 'builtin',
  file: 'file',
  inline: 'inline',
};

export default function Skills() {
  const { skills = [], saveSkill, deleteSkill, importSkill, loading } = useApp();
  const [editorOpen, setEditorOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [importFrom, setImportFrom] = useState('');
  const [importing, setImporting] = useState(false);
  const [expanded, setExpanded] = useState({});

  const enabledCount = useMemo(() => skills.filter((skill) => skill?.enabled).length, [skills]);
  const builtinCount = useMemo(() => skills.filter((skill) => skill?.source === 'builtin').length, [skills]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setEditorOpen(true);
  }

  function openEdit(skill) {
    setEditing(skill);
    setForm({
      name: skill?.name || '',
      description: skill?.description || '',
      content: skill?.content || '',
      whenToUse: skill?.whenToUse || '',
    });
    setEditorOpen(true);
  }

  async function submitEditor(event) {
    event.preventDefault();
    const name = form.name.trim();
    const content = form.content.trim();
    if (!name || !content || saving) return;
    setSaving(true);
    const saved = await saveSkill(
      { name, description: form.description.trim(), content, whenToUse: form.whenToUse.trim() },
      editing?.id,
    );
    setSaving(false);
    // On failure the modal stays open so the typed instructions are never lost.
    if (saved) {
      setEditorOpen(false);
      setEditing(null);
      setForm(EMPTY_FORM);
    }
  }

  async function submitImport(event) {
    event.preventDefault();
    const from = importFrom.trim();
    if (!from || importing) return;
    setImporting(true);
    const imported = await importSkill(from);
    setImporting(false);
    if (imported) {
      setImportOpen(false);
      setImportFrom('');
    }
  }

  async function onToggle(skill) {
    if (!skill?.id) return;
    await saveSkill({ enabled: !skill?.enabled }, skill.id);
  }

  return (
    <section className="content-page">
      <div className="page-heading">
        <div>
          <div className="page-kicker">REUSABLE INSTRUCTIONS</div>
          <h1>Skills<span className="heading-dot">.</span></h1>
          <p>Yoqilgan skills modelga har bir chatda qisqa tavsif bilan beriladi; to‘liq matn faqat kerak bo‘lganda yuklanadi.</p>
        </div>
        <div className="cb-heading-actions">
          <button type="button" className="secondary-btn" onClick={() => setImportOpen(true)}>
            <Download size={15} /> Import
          </button>
          <button type="button" className="primary-btn" onClick={openCreate}>
            <Plus size={16} /> Create skill
          </button>
        </div>
      </div>

      <div className="stats-row">
        <div className="stat-card"><Layers3 size={18} /><span>Skills</span><b>{skills.length}</b></div>
        <div className="stat-card"><Zap size={18} /><span>Enabled</span><b>{enabledCount}</b></div>
        <div className="stat-card"><Sparkles size={18} /><span>Builtin</span><b>{builtinCount}</b></div>
      </div>

      <div className="info-strip">
        <Zap size={16} />
        <span>
          Builtin skills ham tahrirlanadi: matnini o‘zgartirsangiz, o‘zgarish store’da saqlanadi va qayta seed qilinmaydi.
          Import uchun lokal papka yo‘li, <code>.md</code> fayl yoki <code>https://</code> havola bering.
        </span>
      </div>

      {loading && !skills.length ? <LoadingState text="Skills yuklanmoqda…" rows={3} /> : null}

      {!loading && !skills.length ? (
        <div className="panel-card">
          <EmptyState
            icon={<Layers3 size={21} />}
            title="Hozircha skill yo‘q"
            hint="Yangi skill yarating yoki mavjud SKILL.md faylini import qiling."
          >
            <button type="button" className="primary-btn" onClick={openCreate}><Plus size={15} /> Create skill</button>
            <button type="button" className="secondary-btn" onClick={() => setImportOpen(true)}><Download size={15} /> Import</button>
          </EmptyState>
        </div>
      ) : null}

      <div className="skills-list">
        {skills.map((skill) => {
          const isOpen = Boolean(expanded[skill?.id]);
          const source = SOURCE_LABEL[skill?.source] || skill?.source || 'inline';
          return (
            <div className="skill-card" key={skill?.id || skill?.name}>
              <div className="skill-symbol"><Layers3 size={20} /></div>
              <div className="skill-details">
                <div className="skill-title-row">
                  <h3>{skill?.name || 'Untitled skill'}</h3>
                  <span className={`enabled-badge ${skill?.enabled ? 'enabled' : ''}`}>{skill?.enabled ? 'Enabled' : 'Disabled'}</span>
                  <span className={`enabled-badge source-${source}`}>{source}</span>
                  {skill?.path ? <span className="skill-path" title={skill.path}><FileCode2 size={11} /> {skill.path}</span> : null}
                </div>
                <p>{skill?.description || 'Tavsif yo‘q.'}</p>
                {skill?.whenToUse ? <p className="skill-when"><b>When to use:</b> {skill.whenToUse}</p> : null}
                <button
                  type="button"
                  className="skill-preview-toggle"
                  onClick={() => setExpanded((prev) => ({ ...prev, [skill?.id]: !prev[skill?.id] }))}
                  aria-expanded={isOpen}
                >
                  {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  {isOpen ? 'Hide instructions' : `Show instructions (${(skill?.content || '').length} chars)`}
                </button>
                {isOpen ? (
                  <pre className="skill-content-full">{skill?.content || '(bo‘sh)'}</pre>
                ) : (
                  <div className="skill-content-preview">{skill?.content || ''}</div>
                )}
              </div>
              <div className="skill-actions">
                <label className="toggle" title={skill?.enabled ? 'O‘chirish' : 'Yoqish'}>
                  <input type="checkbox" checked={Boolean(skill?.enabled)} onChange={() => onToggle(skill)} disabled={!skill?.id} />
                  <span />
                </label>
                <button type="button" className="icon-btn" title="Tahrirlash" onClick={() => openEdit(skill)}>
                  <Pencil size={15} />
                </button>
                <button type="button" className="icon-btn" title="Skillni o‘chirish" onClick={() => deleteSkill(skill?.id)} disabled={!skill?.id}>
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <Modal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        size="lg"
        icon={<Layers3 size={19} />}
        title={editing ? `Edit “${editing.name}”` : 'Create a skill'}
        description="Bu yo‘riqnoma yoqilgan holatda AI promptiga qo‘shiladi. Aniq va qisqa yozing."
        footer={(
          <>
            <button type="button" className="secondary-btn" onClick={() => setEditorOpen(false)}>Cancel</button>
            <button type="button" className="primary-btn" onClick={submitEditor} disabled={saving || !form.name.trim() || !form.content.trim()}>
              <Plus size={15} /> {saving ? 'Saving…' : editing ? 'Save changes' : 'Save skill'}
            </button>
          </>
        )}
      >
        <form className="modal-form" onSubmit={submitEditor}>
          <label>
            Skill name
            <input
              data-autofocus
              maxLength={MAX_NAME}
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="e.g. Code review"
              required
            />
          </label>
          <label>
            Description <span className="optional">model uchun bir qatorli tavsif</span>
            <input
              maxLength={MAX_DESCRIPTION}
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              placeholder="What should this skill help with?"
            />
          </label>
          <label>
            When to use <span className="optional">optional</span>
            <input
              value={form.whenToUse}
              onChange={(event) => setForm({ ...form, whenToUse: event.target.value })}
              placeholder="e.g. Review qilish so‘ralganda"
            />
          </label>
          <label>
            Instructions
            <textarea
              rows={10}
              maxLength={MAX_CONTENT}
              value={form.content}
              onChange={(event) => setForm({ ...form, content: event.target.value })}
              placeholder="Write clear instructions for the assistant…"
              required
            />
            <span className="field-note">{form.content.length} / {MAX_CONTENT} belgi</span>
          </label>
        </form>
      </Modal>

      <Modal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        icon={<Download size={19} />}
        title="Import a skill"
        description="Lokal papka, SKILL.md fayli yoki https havola. Backend frontmatter’ni o‘qib, skillni store’ga qo‘shadi."
        footer={(
          <>
            <button type="button" className="secondary-btn" onClick={() => setImportOpen(false)}>Cancel</button>
            <button type="button" className="primary-btn" onClick={submitImport} disabled={importing || !importFrom.trim()}>
              <Download size={15} /> {importing ? 'Importing…' : 'Import skill'}
            </button>
          </>
        )}
      >
        <form className="modal-form" onSubmit={submitImport}>
          <label>
            Path or URL
            <input
              data-autofocus
              value={importFrom}
              onChange={(event) => setImportFrom(event.target.value)}
              placeholder="C:\\skills\\my-skill  yoki  https://example.com/SKILL.md"
              spellCheck={false}
              required
            />
            <span className="field-note">Masalan: <code>docs/skills/review.md</code> yoki to‘liq papka manzili.</span>
          </label>
        </form>
      </Modal>
    </section>
  );
}
