import React, { useMemo, useState } from 'react';
import {
  Boxes, Plug, Play, Pencil, Plus, RefreshCw, ShieldAlert, Square, Trash2, Wrench,
} from 'lucide-react';
import { useApp } from '../state/AppContext.jsx';
import { EmptyState, LoadingState } from '../components/MarkdownLite.jsx';
import Modal from '../components/Modal.jsx';
import { truncate } from '../components/ToolTimeline.jsx';

const EMPTY_FORM = { name: '', command: '', args: '', env: '', cwd: '', autoStart: true, enabled: true };
const STATUS_TONE = {
  ready: 'ok',
  starting: 'pending',
  stopped: 'idle',
  error: 'error',
  crashed: 'error',
};

function argsToText(args) {
  return Array.isArray(args) ? args.join('\n') : '';
}

function textToArgs(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function envToText(env) {
  if (!env || typeof env !== 'object') return '';
  return Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n');
}

function textToEnv(text) {
  const env = {};
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return env;
}

function serverStatus(server) {
  return server?.status || server?.lastStatus || 'stopped';
}

function toolCount(server) {
  if (Number.isFinite(server?.tools)) return server.tools;
  if (Array.isArray(server?.tools)) return server.tools.length;
  return 0;
}

export default function Mcp() {
  const {
    mcpServers = [], saveMcpServer, deleteMcpServer, mcpAction, loadMcpTools, loading, pushToast,
  } = useApp();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [expanded, setExpanded] = useState({});
  const [toolCache, setToolCache] = useState({});
  const [toolsLoading, setToolsLoading] = useState('');

  const totals = useMemo(() => ({
    ready: mcpServers.filter((server) => serverStatus(server) === 'ready').length,
    tools: mcpServers.reduce((sum, server) => sum + toolCount(server), 0),
  }), [mcpServers]);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setEditorOpen(true);
  }

  function openEdit(server) {
    setEditing(server);
    setForm({
      name: server?.name || '',
      command: server?.command || '',
      args: argsToText(server?.args),
      env: envToText(server?.env),
      cwd: server?.cwd || '',
      autoStart: server?.autoStart !== false,
      enabled: server?.enabled !== false,
    });
    setEditorOpen(true);
  }

  async function submit(event) {
    event.preventDefault();
    const name = form.name.trim();
    const command = form.command.trim();
    if (!name || !command || saving) return;
    setSaving(true);
    const fields = {
      name,
      command,
      args: textToArgs(form.args),
      env: textToEnv(form.env),
      cwd: form.cwd.trim() || undefined,
      autoStart: Boolean(form.autoStart),
      enabled: Boolean(form.enabled),
      transport: 'stdio',
    };
    const saved = await saveMcpServer(fields, editing?.id);
    setSaving(false);
    if (saved) {
      setEditorOpen(false);
      setEditing(null);
      setForm(EMPTY_FORM);
    }
  }

  async function action(server, name) {
    if (!server?.id) return;
    setBusyId(server.id);
    await mcpAction(server.id, name);
    setBusyId('');
  }

  async function test(server) {
    if (!server?.id) return;
    const key = server.id;
    const open = !expanded[key];
    setExpanded((prev) => ({ ...prev, [key]: open }));
    if (!open) return;
    setToolsLoading(key);
    const tools = await loadMcpTools(key);
    setToolCache((prev) => ({ ...prev, [key]: tools }));
    setToolsLoading('');
    if (!tools.length) pushToast('Server tool qaytarmadi. Status va logni tekshiring.', 'warn');
  }

  async function remove(server) {
    if (!server?.id) return;
    const ok = window.confirm(`“${server.name}” MCP server konfiguratsiyasi o‘chiriladi. Davom etamizmi?`);
    if (!ok) return;
    await deleteMcpServer(server.id);
  }

  return (
    <section className="content-page">
      <div className="page-heading">
        <div>
          <div className="page-kicker">MODEL CONTEXT PROTOCOL</div>
          <h1>MCP servers<span className="heading-dot">.</span></h1>
          <p>Lokal stdio MCP serverlar. Ularning tool’lari <code>mcp__server__tool</code> nomi bilan registry’ga qo‘shiladi.</p>
        </div>
        <div className="cb-heading-actions">
          <button type="button" className="primary-btn" onClick={openCreate}><Plus size={16} /> Add server</button>
        </div>
      </div>

      <div className="stats-row">
        <div className="stat-card"><Plug size={18} /><span>Servers</span><b>{mcpServers.length}</b></div>
        <div className="stat-card"><Boxes size={18} /><span>Ready</span><b>{totals.ready}</b></div>
        <div className="stat-card"><Wrench size={18} /><span>Tools</span><b>{totals.tools}</b></div>
      </div>

      <div className="info-strip">
        <ShieldAlert size={16} />
        <span>
          MCP serverlar sizning kompyuteringizda alohida jarayon sifatida ishga tushadi. Faqat ishonchli
          command va argumentlarni kiriting; serverlar <code>cwd</code> yoki data papkasidan ishga tushadi.
        </span>
      </div>

      {loading && !mcpServers.length ? <LoadingState text="MCP serverlar yuklanmoqda…" rows={3} /> : null}

      {!loading && !mcpServers.length ? (
        <div className="panel-card">
          <EmptyState
            icon={<Boxes size={21} />}
            title="Hozircha MCP server yo‘q"
            hint="Masalan: npx -y @modelcontextprotocol/server-filesystem kabi stdio server qo‘shing."
          >
            <button type="button" className="primary-btn" onClick={openCreate}><Plus size={15} /> Add server</button>
          </EmptyState>
        </div>
      ) : null}

      <div className="mcp-list">
        {mcpServers.map((server) => {
          const status = serverStatus(server);
          const tone = STATUS_TONE[status] || 'idle';
          const key = server?.id;
          const isOpen = Boolean(expanded[key]);
          const tools = toolCache[key] || (Array.isArray(server?.tools) ? server.tools : []);
          const busy = busyId === key;
          return (
            <div className={`mcp-card status-${tone}`} key={key || server?.name}>
              <div className="mcp-card-head">
                <div className="mcp-icon"><Plug size={18} /></div>
                <div className="mcp-title">
                  <div className="mcp-title-row">
                    <h3>{server?.name || 'Unnamed server'}</h3>
                    <span className={`status-badge ${tone}`}>{status}</span>
                    {server?.enabled === false ? <span className="enabled-badge">disabled</span> : null}
                    {server?.autoStart ? <span className="enabled-badge">auto-start</span> : null}
                    <span className="enabled-badge">{server?.transport || 'stdio'}</span>
                  </div>
                  <div className="mcp-command">
                    <code>{server?.command || '—'}</code>
                    {Array.isArray(server?.args) && server.args.length ? <code>{server.args.join(' ')}</code> : null}
                  </div>
                  <div className="mcp-meta">
                    <span>{toolCount(server)} tools</span>
                    {server?.cwd ? <span title={server.cwd}>cwd: {server.cwd}</span> : null}
                    {server?.lastError ? <span className="mcp-error">{server.lastError}</span> : null}
                  </div>
                </div>
                <div className="mcp-actions">
                  <button type="button" className="secondary-btn" onClick={() => action(server, 'start')} disabled={busy || status === 'ready' || status === 'starting'}>
                    <Play size={13} /> Start
                  </button>
                  <button type="button" className="secondary-btn" onClick={() => action(server, 'stop')} disabled={busy || status === 'stopped'}>
                    <Square size={13} /> Stop
                  </button>
                  <button type="button" className="secondary-btn" onClick={() => action(server, 'restart')} disabled={busy}>
                    <RefreshCw size={13} className={busy ? 'spin' : ''} /> Restart
                  </button>
                  <button type="button" className="secondary-btn" onClick={() => test(server)} disabled={toolsLoading === key}>
                    <Wrench size={13} /> {toolsLoading === key ? 'Testing…' : 'Test'}
                  </button>
                  <button type="button" className="icon-btn" title="Tahrirlash" onClick={() => openEdit(server)}><Pencil size={14} /></button>
                  <button type="button" className="icon-btn" title="O‘chirish" onClick={() => remove(server)}><Trash2 size={14} /></button>
                </div>
              </div>

              {isOpen ? (
                <div className="mcp-tools">
                  {toolsLoading === key ? <LoadingState text="Tool’lar olinmoqda…" /> : null}
                  {toolsLoading !== key && !tools.length ? (
                    <div className="mcp-tools-empty">Bu server hozircha tool qaytarmadi. “Start” bosib, keyin “Test” ni qayta bosing.</div>
                  ) : null}
                  {tools.map((tool, index) => {
                    const preview = truncate(tool?.inputSchema ?? tool?.parameters ?? {}, 700);
                    return (
                      <div className="mcp-tool" key={tool?.name || index}>
                        <div className="mcp-tool-head">
                          <Wrench size={12} />
                          <b>{tool?.name || `tool ${index + 1}`}</b>
                          <span className="mcp-tool-desc">{tool?.description || ''}</span>
                        </div>
                        <pre className="tool-pre">{preview.text}</pre>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <Modal
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        size="lg"
        icon={<Plug size={19} />}
        title={editing ? `Edit “${editing.name}”` : 'Add MCP server'}
        description="stdio transport: command bitta jarayon sifatida ishga tushadi va JSON-RPC 2.0 bilan gaplashadi."
        footer={(
          <>
            <button type="button" className="secondary-btn" onClick={() => setEditorOpen(false)}>Cancel</button>
            <button type="button" className="primary-btn" onClick={submit} disabled={saving || !form.name.trim() || !form.command.trim()}>
              <Plus size={15} /> {saving ? 'Saving…' : editing ? 'Save changes' : 'Add server'}
            </button>
          </>
        )}
      >
        <form className="modal-form" onSubmit={submit}>
          <label>
            Name
            <input
              data-autofocus
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="e.g. filesystem"
              required
            />
          </label>
          <label>
            Command
            <input
              value={form.command}
              onChange={(event) => setForm({ ...form, command: event.target.value })}
              placeholder="npx"
              spellCheck={false}
              required
            />
          </label>
          <label>
            Arguments <span className="optional">har bir qatorga bitta argument</span>
            <textarea
              rows={4}
              value={form.args}
              onChange={(event) => setForm({ ...form, args: event.target.value })}
              placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\projects'}
              spellCheck={false}
            />
          </label>
          <label>
            Environment <span className="optional">KEY=VALUE, har bir qatorda bittasi</span>
            <textarea
              rows={3}
              value={form.env}
              onChange={(event) => setForm({ ...form, env: event.target.value })}
              placeholder={'API_KEY=…\nLOG_LEVEL=info'}
              spellCheck={false}
            />
          </label>
          <label>
            Working directory <span className="optional">optional</span>
            <input
              value={form.cwd}
              onChange={(event) => setForm({ ...form, cwd: event.target.value })}
              placeholder="C:\\projects\\my-app"
              spellCheck={false}
            />
          </label>
          <div className="modal-switches">
            <label className="switch-row">
              <input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />
              <span><b>Enabled</b><small>Server ro‘yxatda faol bo‘ladi.</small></span>
            </label>
            <label className="switch-row">
              <input type="checkbox" checked={form.autoStart} onChange={(event) => setForm({ ...form, autoStart: event.target.checked })} />
              <span><b>Auto start</b><small>Backend ishga tushganda avtomatik ulanadi.</small></span>
            </label>
          </div>
        </form>
      </Modal>
    </section>
  );
}
