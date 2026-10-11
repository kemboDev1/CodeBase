import React, { useState } from 'react';
import { BookOpen, ExternalLink, Package, Puzzle, RefreshCw, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useApp } from '../state/AppContext.jsx';
import { EmptyState, LoadingState } from '../components/MarkdownLite.jsx';

const PLUGIN_DOCS = 'docs/PLUGINS.md';

function statusLabel(plugin) {
  if (plugin?.error) return { text: 'error', className: 'error' };
  if (!plugin?.trusted) return { text: 'untrusted', className: 'warn' };
  return plugin?.enabled ? { text: 'enabled', className: 'enabled' } : { text: 'disabled', className: '' };
}

export default function Plugins() {
  const { plugins = [], togglePlugin, reloadPlugins, loading } = useApp();
  const [busyId, setBusyId] = useState('');
  const [reloading, setReloading] = useState(false);

  const untrusted = plugins.filter((plugin) => !plugin?.trusted);
  const errored = plugins.filter((plugin) => plugin?.error);

  async function onToggle(plugin) {
    if (!plugin?.id) return;
    setBusyId(plugin.id);
    await togglePlugin(plugin.id, !plugin.enabled);
    setBusyId('');
  }

  async function onReload() {
    setReloading(true);
    await reloadPlugins();
    setReloading(false);
  }

  return (
    <section className="content-page">
      <div className="page-heading">
        <div>
          <div className="page-kicker">LOCAL EXTENSIONS</div>
          <h1>Plugins<span className="heading-dot">.</span></h1>
          <p>Plaginlar Node modul sifatida lokal ishlaydi va registry’ga o‘z tool’larini qo‘shadi. Faqat ishonchli plaginni yoqing.</p>
        </div>
        <div className="cb-heading-actions">
          <button type="button" className="primary-btn" onClick={onReload} disabled={reloading}>
            <RefreshCw size={15} className={reloading ? 'spin' : ''} /> {reloading ? 'Reloading…' : 'Reload plugins'}
          </button>
        </div>
      </div>

      <div className="info-strip">
        <BookOpen size={16} />
        <span>
          Plagin yozish uchun papkada <code>plugin.json</code> (name, version, main, permissions) va
          <code> index.mjs</code> fayli kerak; modul <code>activate(api)</code> funksiyasini export qiladi.
          To‘liq qo‘llanma: <a href={`/${PLUGIN_DOCS}`} target="_blank" rel="noopener noreferrer">{PLUGIN_DOCS}</a>.
          Plaginlar <code>plugins/</code> papkasidan yuklanadi.
        </span>
      </div>

      {untrusted.length ? (
        <div className="security-note">
          <ShieldAlert size={17} />
          <div>
            <b>{untrusted.length} plugin ishonchsiz (untrusted)</b>
            <span>
              Untrusted plaginlar default holatda o‘chirilgan. Ularni yoqish kompyuteringizda ixtiyoriy kod ishga tushishini bildiradi:
              faqat manbasini o‘qib, ishonch hosil qilgandan keyin yoqing.
            </span>
          </div>
        </div>
      ) : null}

      {loading && !plugins.length ? <LoadingState text="Plaginlar yuklanmoqda…" rows={3} /> : null}

      {!loading && !plugins.length ? (
        <div className="panel-card">
          <EmptyState
            icon={<Puzzle size={21} />}
            title="Hozircha plagin yo‘q"
            hint={`Plagin papkasini plugins/ ichiga qo‘ying va “Reload plugins” tugmasini bosing. Qo‘llanma: ${PLUGIN_DOCS}`}
          >
            <a className="secondary-btn" href={`/${PLUGIN_DOCS}`} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={14} /> Open docs
            </a>
          </EmptyState>
        </div>
      ) : null}

      {plugins.length ? (
        <div className="plugin-list">
          {plugins.map((plugin) => {
            const status = statusLabel(plugin);
            const busy = busyId === plugin.id;
            return (
              <div className={`plugin-card ${plugin?.error ? 'has-error' : ''}`} key={plugin?.id || plugin?.name}>
                <div className="plugin-icon"><Package size={19} /></div>
                <div className="plugin-details">
                  <div className="plugin-title-row">
                    <h3>{plugin?.name || 'Unnamed plugin'}</h3>
                    <span className="plugin-version">v{plugin?.version || '0.0.0'}</span>
                    <span className={`enabled-badge ${status.className}`}>{status.text}</span>
                    {!plugin?.trusted ? <span className="enabled-badge warn"><ShieldAlert size={10} /> trust required</span> : null}
                    {plugin?.trusted ? <span className="enabled-badge"><ShieldCheck size={10} /> trusted</span> : null}
                  </div>
                  <p>{plugin?.description || 'Tavsif ko‘rsatilmagan.'}</p>
                  {plugin?.error ? <div className="plugin-error">{plugin.error}</div> : null}
                  <div className="plugin-meta">
                    <code title={plugin?.dir}>{plugin?.dir || 'plugins/…'}</code>
                    {plugin?.main ? <code>{plugin.main}</code> : null}
                    {plugin?.createdAt ? <span>{new Date(plugin.createdAt).toLocaleDateString()}</span> : null}
                  </div>
                </div>
                <div className="plugin-actions">
                  <label className="toggle" title={plugin?.enabled ? 'O‘chirish' : 'Yoqish'}>
                    <input
                      type="checkbox"
                      checked={Boolean(plugin?.enabled)}
                      disabled={busy || !plugin?.id}
                      onChange={() => onToggle(plugin)}
                    />
                    <span />
                  </label>
                  <span className="plugin-action-note">{busy ? '…' : plugin?.enabled ? 'on' : 'off'}</span>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      {errored.length ? (
        <div className="settings-tip">
          <ShieldAlert size={16} />
          <span>
            {errored.length} plaginda yuklash xatosi bor. Plagin xatosi backendni to‘xtatmaydi: kodni tuzatib,
            “Reload plugins” tugmasini bosing. Batafsil log Settings → Audit log yoki backend konsolida.
          </span>
        </div>
      ) : null}

      <div className="panel-card plugin-help">
        <div className="panel-title"><h3>How to write a plugin</h3><span>plugin.json</span></div>
        <pre className="tool-pre">{`{
  "name": "example-tools",
  "version": "1.0.0",
  "description": "Adds one example tool",
  "main": "index.mjs",
  "permissions": ["filesystem:read"]
}`}</pre>
        <pre className="tool-pre">{`// index.mjs
export default function activate(api) {
  api.registerTool({
    name: 'hello',
    title: 'Hello tool',
    description: 'Returns a greeting',
    category: 'system',
    parameters: { type: 'object', properties: {} },
    defaultPolicy: 'allow',
    async run() {
      return { ok: true, summary: 'Hello from plugin', content: 'Hello!' };
    }
  });
}`}</pre>
        <p className="plugin-help-note">
          To‘liq API (registerCommand, on('chat.before'), getStore, settings) uchun
          <a href={`/${PLUGIN_DOCS}`} target="_blank" rel="noopener noreferrer"> {PLUGIN_DOCS}</a> faylini o‘qing.
        </p>
      </div>
    </section>
  );
}
