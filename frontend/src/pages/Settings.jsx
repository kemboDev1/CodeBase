import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, Cpu, Database, FolderOpen, Gauge, HardDrive, Layers3, Play, Plus,
  Power, RefreshCw, ScrollText, Settings2, ShieldCheck, Trash2, Zap,
} from 'lucide-react';
import { api, getOllamaAutostart, pickFolder, restartBackend, systemInfo } from '../api/client.js';
import { useApp } from '../state/AppContext.jsx';
import { EmptyState } from '../components/MarkdownLite.jsx';

const MODES = ['auto', 'fast', 'deep'];

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

export default function Settings() {
  const {
    settings = {}, models = [], model, health, ollamaStatus, backendStatus, patchSettings, refreshHealth,
    refreshModels, loadSettings, startOllamaService, saveAutostart, pushToast,
  } = useApp();

  const [form, setForm] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [info, setInfo] = useState(null);
  const [autostart, setAutostart] = useState(null);
  const [newRoot, setNewRoot] = useState('');
  const [starting, setStarting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => { setForm(settings); }, [settings]);

  const loadSystemInfo = useCallback(async () => {
    const bridge = await systemInfo();
    if (bridge) {
      setInfo(bridge);
      return;
    }
    try {
      const data = await api('/system/info');
      setInfo(data || null);
    } catch {
      setInfo(null);
    }
  }, []);

  useEffect(() => {
    loadSystemInfo();
    getOllamaAutostart().then((value) => setAutostart(value));
  }, [loadSystemInfo]);

  const roots = useMemo(() => (Array.isArray(form?.workspaceRoots) ? form.workspaceRoots : []), [form?.workspaceRoots]);
  const audit = useMemo(() => {
    const list = Array.isArray(health?.audit) ? health.audit : Array.isArray(settings?.audit) ? settings.audit : null;
    return list ? list.slice(-50).reverse() : null;
  }, [health?.audit, settings?.audit]);

  const connected = Boolean(health?.ollama?.connected ?? ollamaStatus?.connected);
  const ollamaUrl = form?.ollamaUrl || settings?.ollamaUrl || 'http://127.0.0.1:11434';
  const dataDir = info?.dataDir || health?.dataDir || settings?.dataDir || '—';
  const version = info?.version || health?.version || '—';
  const port = info?.port ?? health?.port ?? '—';

  const patch = (partial) => setForm((prev) => ({ ...prev, ...partial }));

  async function save() {
    setSaving(true);
    await patchSettings({
      model: form.model || model,
      fastModel: form.fastModel || form.model || model,
      numCtx: numberOr(form.numCtx, 8192),
      temperature: numberOr(form.temperature, 0.2),
      maxSteps: numberOr(form.maxSteps, 8),
      mode: form.mode || 'auto',
      summarize: Boolean(form.summarize),
      autoApproveReads: Boolean(form.autoApproveReads),
      ollamaUrl: form.ollamaUrl || ollamaUrl,
      workspaceRoots: roots,
    });
    setSaving(false);
  }

  async function doRefresh() {
    setRefreshing(true);
    await Promise.all([refreshHealth(), refreshModels(), loadSettings(), loadSystemInfo()]);
    setRefreshing(false);
  }

  async function startOllama() {
    setStarting(true);
    const data = await startOllamaService();
    setStarting(false);
    if (data) pushToast('Ollama start so‘rovi yuborildi', 'ok');
  }

  async function doRestartBackend() {
    setRestarting(true);
    const result = await restartBackend();
    setRestarting(false);
    if (result) pushToast('Backend qayta ishga tushirilmoqda…', 'ok');
    else pushToast('Backend restart faqat desktop ilovada mavjud.', 'warn');
  }

  async function addRoot(path) {
    const value = String(path ?? newRoot).trim();
    if (!value) return;
    if (roots.includes(value)) {
      pushToast('Bu papka allaqachon ro‘yxatda.', 'warn');
      return;
    }
    patch({ workspaceRoots: [...roots, value] });
    setNewRoot('');
  }

  async function browseRoot() {
    const picked = await pickFolder();
    if (picked) addRoot(picked);
    else if (!window.codebase) pushToast('Papka tanlash faqat desktop ilovada ishlaydi; yo‘lni qo‘lda yozing.', 'warn');
  }

  const modelOptions = models.length ? models : (model ? [{ name: model }] : []);

  return (
    <section className="content-page">
      <div className="page-heading">
        <div>
          <div className="page-kicker">PREFERENCES</div>
          <h1>Settings<span className="heading-dot">.</span></h1>
          <p>Model, Ollama manzili, workspace roots va agent xatti-harakati shu yerda boshqariladi.</p>
        </div>
        <div className="cb-heading-actions">
          <button type="button" className="secondary-btn" onClick={doRefresh} disabled={refreshing}>
            <RefreshCw size={15} className={refreshing ? 'spin' : ''} /> Refresh
          </button>
          <button type="button" className="primary-btn" onClick={save} disabled={saving}>
            <ShieldCheck size={15} /> {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </div>

      <div className="settings-panel">
        <div className="settings-row">
          <div className="settings-icon"><Cpu size={18} /></div>
          <div className="settings-description"><b>Default model</b><span>Chat uchun asosiy Ollama modeli.</span></div>
          <select className="settings-select" value={form.model || model || ''} onChange={(event) => patch({ model: event.target.value })}>
            {modelOptions.map((item) => <option value={item?.name} key={item?.name}>{item?.name}</option>)}
          </select>
        </div>

        <div className="settings-row">
          <div className="settings-icon"><Zap size={18} /></div>
          <div className="settings-description"><b>Fast model</b><span>Summarize va sarlavhalar uchun tez model.</span></div>
          <select className="settings-select" value={form.fastModel || ''} onChange={(event) => patch({ fastModel: event.target.value })}>
            <option value="">Default model bilan bir xil</option>
            {modelOptions.map((item) => <option value={item?.name} key={item?.name}>{item?.name}</option>)}
          </select>
        </div>

        <div className="settings-row">
          <div className="settings-icon"><Gauge size={18} /></div>
          <div className="settings-description"><b>Context & limits</b><span>numCtx, temperature va maksimal qadam soni.</span></div>
          <div className="settings-numbers">
            <label>numCtx<input type="number" min="1024" max="131072" step="1024" value={form.numCtx ?? 8192} onChange={(event) => patch({ numCtx: event.target.value })} /></label>
            <label>temperature<input type="number" min="0" max="2" step="0.05" value={form.temperature ?? 0.2} onChange={(event) => patch({ temperature: event.target.value })} /></label>
            <label>maxSteps<input type="number" min="1" max="40" step="1" value={form.maxSteps ?? 8} onChange={(event) => patch({ maxSteps: event.target.value })} /></label>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-icon"><Layers3 size={18} /></div>
          <div className="settings-description"><b>Default mode</b><span>Auto tool tanlaydi, fast qisqa, deep chuqurroq ishlaydi.</span></div>
          <div className="mode-switch">
            {MODES.map((item) => (
              <button type="button" key={item} className={`mode-btn ${form.mode === item ? 'active' : ''}`} onClick={() => patch({ mode: item })}>
                {item}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-icon"><ShieldCheck size={18} /></div>
          <div className="settings-description"><b>Safety</b><span>Read-only tool’larni avtomatik ruxsatlash va suhbatni qisqartirish.</span></div>
          <div className="settings-toggles">
            <label className="switch-row">
              <input type="checkbox" checked={Boolean(form.autoApproveReads)} onChange={(event) => patch({ autoApproveReads: event.target.checked })} />
              <span><b>Auto-approve reads</b><small>fs.read, fs.list kabi o‘qish tool’lari so‘ramaydi.</small></span>
            </label>
            <label className="switch-row">
              <input type="checkbox" checked={Boolean(form.summarize)} onChange={(event) => patch({ summarize: event.target.checked })} />
              <span><b>Summarize long chats</b><small>Eski xabarlar fast model bilan qisqartiriladi.</small></span>
            </label>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-icon"><Activity size={18} /></div>
          <div className="settings-description">
            <b>Ollama</b>
            <span>{connected ? `${(health?.ollama?.models || []).length} model topildi` : ollamaStatus?.starting ? 'Ollama ishga tushmoqda…' : 'Ollama javob bermayapti.'}</span>
          </div>
          <input className="settings-input" value={form.ollamaUrl || ''} onChange={(event) => patch({ ollamaUrl: event.target.value })} placeholder="http://127.0.0.1:11434" spellCheck={false} />
          <span className={`settings-state ${connected ? 'ok' : 'off'}`}><span className={`status-led ${connected ? 'online' : ''}`} />{connected ? 'Connected' : 'Offline'}</span>
          <button type="button" className="secondary-btn" onClick={startOllama} disabled={starting || connected}>
            <Play size={14} /> {starting ? 'Starting…' : 'Start Ollama'}
          </button>
        </div>

        <div className="settings-row">
          <div className="settings-icon"><Power size={18} /></div>
          <div className="settings-description"><b>Windows autostart</b><span>Kompyuter yoqilganda Ollama avtomatik ishga tushadi.</span></div>
          <label className="toggle" title="Autostart">
            <input
              type="checkbox"
              checked={Boolean(autostart ?? form.autostartOllama)}
              disabled={autostart === null}
              onChange={async (event) => {
                const value = await saveAutostart(event.target.checked);
                if (value !== null) setAutostart(value);
              }}
            />
            <span />
          </label>
          <span className="settings-note">{autostart === null ? 'Faqat desktop ilovada mavjud' : autostart ? 'Enabled' : 'Disabled'}</span>
        </div>

        <div className="settings-row column">
          <div className="settings-row-head">
            <div className="settings-icon"><HardDrive size={18} /></div>
            <div className="settings-description">
              <b>Workspace roots</b>
              <span>Agent faqat shu papkalar ichida fayl o‘qiy oladi va buyruq ishlata oladi.</span>
            </div>
          </div>
          <div className="roots-editor">
            {roots.length ? roots.map((root) => (
              <div className="root-row" key={root}>
                <FolderOpen size={14} />
                <code>{root}</code>
                <button type="button" className="icon-btn" title="O‘chirish" onClick={() => patch({ workspaceRoots: roots.filter((item) => item !== root) })}>
                  <Trash2 size={13} />
                </button>
              </div>
            )) : <div className="cb-inline-note">Hozircha root yo‘q. Files va Terminal ishlashi uchun kamida bitta papka qo‘shing.</div>}
            <div className="field-row">
              <input value={newRoot} onChange={(event) => setNewRoot(event.target.value)} placeholder="C:\\projects\\my-app" spellCheck={false} />
              <button type="button" className="secondary-btn" onClick={() => addRoot()} disabled={!newRoot.trim()}><Plus size={14} /> Add</button>
              <button type="button" className="secondary-btn" onClick={browseRoot}><FolderOpen size={14} /> Browse</button>
            </div>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-icon"><Database size={18} /></div>
          <div className="settings-description"><b>Data & runtime</b><span>Store fayli, backend porti va versiya.</span></div>
          <div className="settings-kv">
            <span>version <code>{version}</code></span>
            <span>port <code>{port}</code></span>
            <span>platform <code>{info?.platform || navigator.platform || '—'}</code></span>
            <span>node <code>{info?.node || '—'}</code></span>
            <span className="wide" title={String(dataDir)}>dataDir <code>{dataDir}</code></span>
            <span>backend <code>{backendStatus?.running === false ? 'stopped' : backendStatus?.port ? `running :${backendStatus.port}` : 'running'}</code></span>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-icon"><RefreshCw size={18} /></div>
          <div className="settings-description"><b>Backend restart</b><span>Backendni qayta ishga tushirish (desktop ilovada mavjud).</span></div>
          <button type="button" className="secondary-btn" onClick={doRestartBackend} disabled={restarting}>
            <RefreshCw size={14} className={restarting ? 'spin' : ''} /> {restarting ? 'Restarting…' : 'Restart backend'}
          </button>
        </div>
      </div>

      <div className="settings-tip">
        <Settings2 size={16} />
        <span>
          O‘zgarishlar “Save settings” bilan store’ga yoziladi. Root papkalar va model darhol keyingi so‘rovda qo‘llanadi;
          autostart va backend restart esa Electron supervisor orqali bajariladi.
        </span>
      </div>

      <div className="panel-card settings-audit">
        <div className="panel-title">
          <h3>Audit log</h3>
          <span>{audit ? `${audit.length} entries` : 'unavailable'}</span>
        </div>
        {audit === null ? (
          <EmptyState
            compact
            icon={<ScrollText size={18} />}
            title="Audit log mavjud emas"
            hint="Backend /health yoki /settings ichida audit maydonini qaytarsa, oxirgi 50 yozuv shu yerda ko‘rinadi."
          />
        ) : null}
        {audit && !audit.length ? <EmptyState compact icon={<ScrollText size={18} />} title="Yozuvlar yo‘q" hint="Tool ishlatilganda yozuvlar shu yerda paydo bo‘ladi." /> : null}
        {audit && audit.length ? (
          <div className="audit-table">
            <div className="audit-head">
              <span>Time</span><span>Tool</span><span>Decision</span><span>OK</span><span>Duration</span><span>Note</span>
            </div>
            {audit.map((entry, index) => (
              <div className="audit-row" key={entry?.id || `${entry?.at || index}-${index}`}>
                <span>{entry?.at ? new Date(entry.at).toLocaleTimeString() : '—'}</span>
                <span className="audit-tool">{entry?.tool || '—'}</span>
                <span><span className={`enabled-badge ${entry?.decision === 'deny' ? 'error' : entry?.decision === 'ask' ? 'warn' : 'enabled'}`}>{entry?.decision || 'allow'}</span></span>
                <span>{entry?.ok === false ? 'fail' : entry?.ok === true ? 'ok' : '—'}</span>
                <span>{formatDuration(entry?.ms)}</span>
                <span className="audit-note" title={entry?.error || entry?.argsDigest || ''}>{entry?.error || entry?.argsDigest || ''}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}
