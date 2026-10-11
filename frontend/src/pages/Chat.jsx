import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp, Bot, ChevronDown, FileCode2, Folder, Layers3, LoaderCircle, MessageSquare, Pencil,
  Plus, RotateCcw, ShieldCheck, Sparkles, Square, TerminalSquare, Trash2, Zap,
} from 'lucide-react';
import { useApp } from '../state/AppContext.jsx';
import MarkdownLite from '../components/MarkdownLite.jsx';
import ToolTimeline from '../components/ToolTimeline.jsx';
import Modal from '../components/Modal.jsx';

const MODES = [
  { id: 'auto', label: 'Auto', hint: 'Tool’larni o‘zi tanlaydi' },
  { id: 'fast', label: 'Fast', hint: 'Qisqa javob, kam qadam' },
  { id: 'deep', label: 'Deep', hint: 'Ko‘proq qadam va tahlil' },
];

const QUICK_PROMPTS = [
  {
    icon: TerminalSquare,
    tone: 'purple',
    title: 'Learn backend',
    small: 'API va server asoslari',
    prompt: 'Menga backend qanday ishlashini sodda qilib tushuntir va kichik misol yarat.',
  },
  {
    icon: FileCode2,
    tone: 'blue',
    title: 'Build a feature',
    small: 'Rejalash va kod yozish',
    prompt: 'Yangi React component yaratib ber va uni qaysi faylga qo‘yishni tushuntir.',
  },
  {
    icon: Folder,
    tone: 'orange',
    title: 'Structure a project',
    small: 'Papka va arxitektura',
    prompt: 'Mening hozirgi projectim uchun yaxshi folder structure taklif qil.',
  },
  {
    icon: ShieldCheck,
    tone: 'green',
    title: 'Review code',
    small: 'Xavfsizlik va sifat',
    prompt: 'Kodimni security, bug va performance bo‘yicha review qil.',
  },
];

function timeLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function EmptyState({ onPick }) {
  return (
    <div className="welcome-wrap">
      <div className="welcome-orb"><Sparkles size={28} /></div>
      <div className="eyebrow"><span className="eyebrow-line" /> YOUR LOCAL AI CODING PARTNER <span className="eyebrow-line" /></div>
      <h1>Build something<br /><span>remarkable.</span></h1>
      <p className="welcome-sub">
        Loyihalar, memory va kod yordamchisi — hammasi shu kompyuterda.
        <br className="desktop-break" /> Quyidagi tez so‘rovlardan birini tanlang yoki o‘z savolingizni yozing.
      </p>
      <div className="quick-grid">
        {QUICK_PROMPTS.map((item) => (
          <button className="quick-card" key={item.title} onClick={() => onPick(item.prompt)}>
            <span className={`quick-icon ${item.tone}`}><item.icon size={17} /></span>
            <span><b>{item.title}</b><small>{item.small}</small></span>
            <ArrowUp size={14} />
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageRow({ message }) {
  const role = message?.role === 'user' ? 'user' : 'assistant';
  const streaming = Boolean(message?.streaming);
  const hasContent = Boolean(message?.content);
  const hasTools = Array.isArray(message?.tools) && message.tools.length > 0;
  return (
    <article className={`message-row ${role}`}>
      <div className={`message-avatar ${role}`}>{role === 'user' ? 'S' : <Bot size={16} />}</div>
      <div className="message-main">
        <div className="message-meta">
          <b>{role === 'user' ? 'Siz' : 'CodeBase'}</b>
          {role === 'assistant' ? <span className="assistant-tag"><Zap size={10} /> local</span> : null}
          {message?.model ? <span className="message-model">{message.model}</span> : null}
          {message?.stopped ? <span className="message-flag">stopped</span> : null}
          {message?.steps ? <span className="message-flag">{message.steps} steps</span> : null}
          <span className="message-time">{timeLabel(message?.createdAt)}</span>
        </div>
        {message?.error ? (
          <div className="message-error"><RotateCcw size={13} /><span>{message.error}</span></div>
        ) : null}
        {hasTools ? (
          <ToolTimeline tools={message.tools} steps={message.steps} durationMs={message.durationMs} />
        ) : null}
        {role === 'user' && hasContent ? <div className="message-copy"><p>{message.content}</p></div> : null}
        {role === 'assistant' && streaming && !hasContent ? (
          <div className="typing-line"><span /><span /><span /> javob yozilmoqda…</div>
        ) : null}
        {role === 'assistant' && hasContent ? <MarkdownLite text={message.content} /> : null}
        {role === 'assistant' && message?.summary ? (
          <div className="message-summary"><b>Summary</b><span>{message.summary}</span></div>
        ) : null}
        {Array.isArray(message?.permissions) && message.permissions.length ? (
          <div className="message-permissions">
            {message.permissions.map((permission, key) => (
              <span className={`enabled-badge ${permission?.approved ? 'enabled' : 'error'}`} key={permission?.id || key}>
                {permission?.approved ? 'allowed' : 'denied'} · {permission?.decision || 'once'}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </article>
  );
}

export default function Chat() {
  const {
    activeProject, activeProjectId, messages = [], models = [], model, mode, sessions = [], activeSessionId,
    busy, health, error, loading, sendMessage, stop, selectModel, selectMode, createSession, renameSession,
    deleteSession, selectSession, clearError, pushToast,
  } = useApp();

  const [input, setInput] = useState('');
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const scrollRef = useRef(null);
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);

  const activeSession = useMemo(
    () => sessions.find((item) => item.id === activeSessionId) || null,
    [sessions, activeSessionId],
  );

  const onScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 90;
    pinnedRef.current = atBottom;
    setPinned(atBottom);
  }, []);

  useEffect(() => {
    if (!pinnedRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: busy ? 'auto' : 'smooth', block: 'end' });
  }, [messages, busy]);

  useEffect(() => {
    pinnedRef.current = true;
    setPinned(true);
  }, [activeProjectId, activeSessionId]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    clearError();
    sendMessage(text, { projectId: activeProjectId, sessionId: activeSessionId });
    textareaRef.current?.focus();
  }, [input, busy, sendMessage, activeProjectId, activeSessionId, clearError]);

  const onKeyDown = useCallback((event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }, [send]);

  const retry = useCallback(() => {
    const lastUser = [...messages].reverse().find((item) => item?.role === 'user');
    if (lastUser?.content) {
      clearError();
      sendMessage(lastUser.content, { projectId: activeProjectId, sessionId: activeSessionId });
    }
  }, [messages, clearError, sendMessage, activeProjectId, activeSessionId]);

  async function submitRename(event) {
    event?.preventDefault();
    const name = renameValue.trim();
    if (!name || !activeSessionId) return;
    const ok = await renameSession(activeSessionId, name);
    if (ok) setRenameOpen(false);
  }

  const quickPick = useCallback((prompt) => {
    setInput(prompt);
    textareaRef.current?.focus();
  }, []);

  const showWelcome = !messages.length && !busy;
  const offline = health?.ollama?.connected === false;
  const lastError = error;

  return (
    <section className="chat-page">
      <div className="chat-session-bar">
        <div className="cb-select">
          <MessageSquare size={13} />
          <select
            value={activeSessionId || ''}
            onChange={(event) => selectSession(event.target.value)}
            disabled={busy || !sessions.length}
            title="Chat sessiyasi"
          >
            {!sessions.length ? <option value="">Yangi chat</option> : null}
            {sessions.map((session, index) => (
              <option value={session?.id} key={session?.id || index}>{session?.name || 'Untitled chat'}</option>
            ))}
          </select>
          <ChevronDown size={13} />
        </div>
        <button type="button" className="icon-btn" title="Chat nomini o‘zgartirish" onClick={() => { setRenameValue(activeSession?.name || ''); setRenameOpen(true); }} disabled={!activeSessionId}>
          <Pencil size={14} />
        </button>
        <button type="button" className="icon-btn" title="Chatni o‘chirish" onClick={() => setConfirmDelete(true)} disabled={!activeSessionId || sessions.length <= 1}>
          <Trash2 size={14} />
        </button>
        <button type="button" className="ghost-btn" onClick={() => createSession(`Chat ${sessions.length + 1}`)} disabled={busy}>
          <Plus size={14} /> New chat
        </button>
        <span className="chat-session-meta">
          {messages.length} messages · {activeProject?.name || 'General'}
        </span>
      </div>

      {offline ? (
        <div className="warn-banner">
          <Zap size={15} />
          <span>Ollama ulanmagan. Settings → “Start Ollama” bilan ishga tushiring, keyin qayta yuboring.</span>
        </div>
      ) : null}

      <div className="messages-wrap" ref={scrollRef} onScroll={onScroll}>
        {loading && !messages.length ? (
          <div className="loading-state"><LoaderCircle className="spin" size={25} /><span>Chat yuklanmoqda…</span></div>
        ) : null}

        {showWelcome ? <EmptyState onPick={quickPick} /> : null}

        {!showWelcome && messages.length ? (
          <>
            <div className="conversation-label">
              <span className="conversation-icon"><MessageSquare size={13} /></span>
              <span>{activeSession?.name || activeProject?.name || 'Conversation'}</span>
              <span className="conversation-line" />
              <span className="conversation-count">{messages.length} messages</span>
            </div>
            {messages.map((message, index) => <MessageRow message={message} key={message?.id || index} />)}
            {lastError ? (
              <div className="message-error retry-row">
                <RotateCcw size={13} />
                <span>{lastError}</span>
                <button type="button" className="ghost-btn" onClick={retry} disabled={busy}>Qayta yuborish</button>
                <button type="button" className="ghost-btn" onClick={clearError}>Yopish</button>
              </div>
            ) : null}
            <div ref={bottomRef} className="scroll-sentinel" />
          </>
        ) : null}
      </div>

      {!pinned && messages.length ? (
        <button
          type="button"
          className="scroll-to-bottom"
          onClick={() => {
            pinnedRef.current = true;
            setPinned(true);
            bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
          }}
        >
          <ArrowUp size={14} /> Eng pastga
        </button>
      ) : null}

      <div className={`composer-area ${showWelcome ? 'at-bottom' : ''}`}>
        <form className="composer" onSubmit={(event) => { event.preventDefault(); send(); }}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={offline ? 'Ollama ishga tushgach, shu yerda yozing…' : 'Ask CodeBase anything about your code…'}
            rows={2}
            onKeyDown={onKeyDown}
            disabled={busy}
          />
          <div className="composer-tools">
            <div className="composer-left">
              <div className="mode-switch" role="group" aria-label="Mode">
                {MODES.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={`mode-btn ${mode === item.id ? 'active' : ''}`}
                    title={item.hint}
                    onClick={() => selectMode(item.id)}
                    disabled={busy}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <span className="composer-divider" />
              <span className={`composer-status ${health?.ollama?.connected ? 'ready' : ''}`}>
                <span className="status-led" />{health?.ollama?.connected ? 'Local & private' : 'Offline'}
              </span>
            </div>
            <div className="composer-right">
              <select className="model-select" value={model || ''} onChange={(event) => selectModel(event.target.value)} title="Model tanlash">
                {models.length
                  ? models.map((item) => <option value={item?.name} key={item?.name}>{item?.name}</option>)
                  : <option value={model || ''}>{model || 'No model detected'}</option>}
              </select>
              {busy ? (
                <button type="button" className="stop-button" onClick={stop} title="Javobni to‘xtatish">
                  <Square size={14} /> Stop
                </button>
              ) : (
                <button className="send-button" type="submit" disabled={!input.trim()} title="Send message">
                  <ArrowUp size={17} />
                </button>
              )}
            </div>
          </div>
        </form>
        <div className="composer-footnote">
          <span>AI xato qilishi mumkin. Kodni ishga tushirishdan oldin tekshiring.</span>
          <span><kbd>Enter</kbd> send <kbd>Shift + Enter</kbd> new line</span>
        </div>
      </div>

      <Modal
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        icon={<Pencil size={18} />}
        title="Chat nomini o‘zgartirish"
        description="Nom faqat sizga ko‘rinadi va sessiya ro‘yxatida chiqadi."
        footer={(
          <>
            <button type="button" className="secondary-btn" onClick={() => setRenameOpen(false)}>Cancel</button>
            <button type="button" className="primary-btn" onClick={submitRename} disabled={!renameValue.trim()}>Save name</button>
          </>
        )}
      >
        <form className="modal-form" onSubmit={submitRename}>
          <label>
            Chat name
            <input data-autofocus maxLength={80} value={renameValue} onChange={(event) => setRenameValue(event.target.value)} placeholder="e.g. Login bug" />
          </label>
        </form>
      </Modal>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        icon={<Trash2 size={18} />}
        title="Chatni o‘chirish"
        description={`“${activeSession?.name || 'Bu chat'}” va uning xabarlari o‘chiriladi. Boshqa sessiyalar saqlanadi.`}
        footer={(
          <>
            <button type="button" className="secondary-btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
            <button
              type="button"
              className="danger-btn"
              onClick={async () => { await deleteSession(activeSessionId); setConfirmDelete(false); }}
            >
              <Trash2 size={14} /> Delete chat
            </button>
          </>
        )}
      >
        <div className="modal-note">
          <Layers3 size={15} />
          <span>Tool natijalari va audit yozuvlari store ichida qoladi, faqat shu sessiya tarixi olib tashlanadi.</span>
        </div>
      </Modal>
    </section>
  );
}
