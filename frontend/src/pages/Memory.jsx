import React, { useState } from 'react';
import { Brain, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useApp } from '../state/AppContext.jsx';
import { EmptyState, LoadingState } from '../components/MarkdownLite.jsx';

const MAX_LENGTH = 3000;

export default function Memory() {
  const { memories = [], addMemory, deleteMemory, loading } = useApp();
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const tooLong = draft.length > MAX_LENGTH;

  async function submit(event) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || tooLong || saving) return;
    setSaving(true);
    const created = await addMemory(content);
    setSaving(false);
    if (created) setDraft('');
  }

  return (
    <section className="content-page">
      <div className="page-heading">
        <div>
          <div className="page-kicker">PERSONAL CONTEXT</div>
          <h1>Memory<span className="heading-dot">.</span></h1>
          <p>CodeBase keyingi suhbatlarda ham eslab qolishi kerak bo‘lgan ma’lumotlar.</p>
        </div>
        <div className="mini-count"><Brain size={15} />{memories.length} saved memories</div>
      </div>

      <div className="memory-layout">
        <div className="memory-form-card">
          <div className="card-icon purple"><Brain size={18} /></div>
          <h3>Teach CodeBase about you</h3>
          <p>Masalan: “Men Roblox Studio’da Luau ishlataman. Kodni to‘liq va fayl yo‘llari bilan ber.”</p>
          <form onSubmit={submit}>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={5}
              maxLength={MAX_LENGTH + 200}
              placeholder="Nimani eslab qolish kerak?"
              disabled={saving}
            />
            <div className={`char-counter ${tooLong ? 'over' : draft.length > MAX_LENGTH * 0.9 ? 'warn' : ''}`}>
              <span>{draft.length} / {MAX_LENGTH}</span>
              <span>{tooLong ? 'Juda uzun — qisqartiring' : 'Belgilar soni'}</span>
            </div>
            <button className="primary-btn full" type="submit" disabled={!draft.trim() || tooLong || saving}>
              <Plus size={15} /> {saving ? 'Saving…' : 'Save memory'}
            </button>
          </form>
          <div className="privacy-note">
            <ShieldCheck size={15} />
            <span>Bu xotiralar faqat shu kompyuterdagi backend faylida saqlanadi va model promptiga faqat kerak bo‘lganda qo‘shiladi.</span>
          </div>
        </div>

        <div className="memory-list-panel">
          <div className="panel-title"><h3>Saved memories</h3><span>{memories.length}</span></div>
          {loading && !memories.length ? <LoadingState text="Memory yuklanmoqda…" rows={3} /> : null}
          {!loading && !memories.length ? (
            <EmptyState
              icon={<Brain size={21} />}
              title="No memories yet"
              hint="Save a preference or project detail to personalize answers."
            />
          ) : null}
          {memories.map((memory, index) => (
            <div className="memory-item" key={memory?.id || index}>
              <div className="memory-number">{String(index + 1).padStart(2, '0')}</div>
              <div className="memory-text">
                <p>{memory?.content}</p>
                <small>
                  {memory?.createdAt ? new Date(memory.createdAt).toLocaleString() : '—'}
                  {Array.isArray(memory?.tags) && memory.tags.length ? ` · ${memory.tags.join(', ')}` : ''}
                </small>
              </div>
              <button
                type="button"
                className="icon-btn"
                title="Memoryni o‘chirish"
                onClick={() => deleteMemory(memory?.id)}
                disabled={!memory?.id}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
