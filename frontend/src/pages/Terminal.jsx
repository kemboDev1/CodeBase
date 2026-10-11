import React, { useCallback, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, Clock, Copy, Eraser, Play, TerminalSquare } from 'lucide-react';
import { api } from '../api/client.js';
import { useApp } from '../state/AppContext.jsx';
import { EmptyState, LoadingState } from '../components/MarkdownLite.jsx';

const TIMEOUTS = [
  { label: '15 seconds', value: 15_000 },
  { label: '60 seconds', value: 60_000 },
  { label: '3 minutes', value: 180_000 },
];
const HISTORY_LIMIT = 60;
const MAX_COMMAND_LENGTH = 4000;

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`;
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(String(value ?? ''));
    return true;
  } catch {
    return false;
  }
}

export default function Terminal() {
  const { settings, pushToast, health, loading } = useApp();
  const roots = useMemo(() => (Array.isArray(settings?.workspaceRoots) ? settings.workspaceRoots : []), [settings?.workspaceRoots]);

  const [cwd, setCwd] = useState(roots[0] || '');
  const [command, setCommand] = useState('');
  const [timeoutMs, setTimeoutMs] = useState(60_000);
  const [entry, setEntry] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState([]);
  const historyIndex = useRef(-1);

  const run = useCallback(async (raw) => {
    const value = String(raw ?? '').trim();
    if (!value) return;
    setRunning(true);
    setError('');
    setEntry({ command: value, cwd: cwd || undefined, startedAt: new Date().toISOString(), pending: true });
    setHistory((prev) => (prev[prev.length - 1] === value ? prev : [...prev, value].slice(-HISTORY_LIMIT)));
    historyIndex.current = -1;
    try {
      const data = await api('/terminal/exec', {
        method: 'POST',
        body: { command: value.slice(0, MAX_COMMAND_LENGTH), cwd: cwd || undefined, timeoutMs },
      });
      if (typeof data?.cwd === 'string' && data.cwd) setCwd(data.cwd);
      setEntry({
        command: value,
        cwd: data?.cwd || cwd || undefined,
        code: data?.code,
        stdout: data?.stdout || '',
        stderr: data?.stderr || '',
        ms: data?.ms,
        truncated: Boolean(data?.truncated),
        finishedAt: new Date().toISOString(),
      });
    } catch (err) {
      const text = err?.message || 'Buyruq bajarilmadi';
      setError(text);
      setEntry({ command: value, cwd: cwd || undefined, code: null, stdout: '', stderr: text, ms: undefined, failed: true });
    } finally {
      setRunning(false);
    }
  }, [cwd, timeoutMs]);

  const onKeyDown = useCallback((event) => {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!history.length) return;
      const next = historyIndex.current < 0 ? history.length - 1 : Math.max(0, historyIndex.current - 1);
      historyIndex.current = next;
      setCommand(history[next] || '');
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (historyIndex.current < 0) return;
      const next = historyIndex.current + 1;
      if (next >= history.length) {
        historyIndex.current = -1;
        setCommand('');
        return;
      }
      historyIndex.current = next;
      setCommand(history[next] || '');
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      run(command);
    }
  }, [history, run, command]);

  const outputText = useMemo(() => {
    if (!entry) return '';
    const head = `$ ${entry.command}`;
    const exit = entry.pending ? '…' : `exit ${entry.code ?? '—'}`;
    return [head, entry.stdout || '', entry.stderr || '', exit].filter(Boolean).join('\n');
  }, [entry]);

  const ok = entry && !entry.pending && entry.code === 0;

  return (
    <section className="content-page terminal-page">
      <div className="page-heading">
        <div>
          <div className="page-kicker">SAFE LOCAL SHELL</div>
          <h1>Terminal<span className="heading-dot">.</span></h1>
          <p>Buyruqlar backend ruxsat tizimidan o‘tadi: xavfli buyruqlar rad etiladi va cwd faqat workspace root ichida bo‘ladi.</p>
        </div>
        <div className="cb-heading-actions">
          <button type="button" className="secondary-btn" onClick={() => { setCommand(''); setEntry(null); setError(''); }} disabled={running}>
            <Eraser size={14} /> Clear
          </button>
        </div>
      </div>

      <div className="terminal-bar">
        <span className="terminal-cwd-label">cwd</span>
        <input
          className="terminal-cwd"
          value={cwd}
          onChange={(event) => setCwd(event.target.value)}
          placeholder={roots[0] || 'C:\\path\\to\\project'}
          spellCheck={false}
          list="terminal-roots"
        />
        <datalist id="terminal-roots">
          {roots.map((root) => <option value={root} key={root} />)}
        </datalist>
        <div className="cb-select">
          <Clock size={13} />
          <select value={timeoutMs} onChange={(event) => setTimeoutMs(Number(event.target.value))} title="Timeout">
            {TIMEOUTS.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
          </select>
          <ChevronDown size={13} />
        </div>
      </div>

      <div className="terminal-command">
        <span className="terminal-prompt">$</span>
        <input
          className="terminal-input"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="npm test"
          spellCheck={false}
          disabled={running}
          aria-label="Buyruq"
        />
        <button type="button" className="primary-btn" onClick={() => run(command)} disabled={running || !command.trim()}>
          <Play size={14} /> {running ? 'Running…' : 'Run'}
        </button>
      </div>
      <div className="terminal-hint">
        <span><kbd>Enter</kbd> run · <kbd>↑</kbd>/<kbd>↓</kbd> history</span>
        <span>{history.length ? `${history.length} buyruq tarixda` : 'Tarix bo‘sh'}</span>
      </div>

      {error ? <div className="error-banner inline"><AlertTriangle size={15} /><span>{error}</span></div> : null}

      {!entry && !running && !loading && (
        <div className="panel-card terminal-empty">
          <EmptyState
            icon={<TerminalSquare size={21} />}
            title="Hali buyruq ishlatilmadi"
            hint={roots.length
              ? `Masalan: “npm test” yoki “git status”. Ijro papkasi: ${roots[0]}`
              : 'Workspace root hali sozlanmagan. Settings → Workspace roots bo‘limida papka qo‘shing.'}
          />
        </div>
      )}

      {loading && !entry ? <LoadingState text="Terminal tayyorlanmoqda…" /> : null}

      {entry && (
        <div className="terminal-output">
          <div className="terminal-output-head">
            <span className={`terminal-exit ${entry.pending ? 'pending' : ok ? 'ok' : 'fail'}`}>
              {entry.pending ? 'running…' : entry.code === null ? 'error' : `exit ${entry.code}`}
            </span>
            <span className="terminal-cmd" title={entry.command}>{entry.command}</span>
            <span className="terminal-meta">{entry.ms !== undefined ? formatDuration(entry.ms) : ''}{entry.truncated ? ' · output truncated' : ''}</span>
            <button type="button" className="ghost-btn" onClick={async () => { if (await copyText(outputText)) pushToast('Output nusxalandi', 'ok'); }} disabled={!outputText}>
              <Copy size={13} /> Copy output
            </button>
          </div>
          <div className="terminal-panes">
            <div className="terminal-pane">
              <div className="terminal-pane-title">stdout{entry.stdout ? ` · ${entry.stdout.length} chars` : ''}</div>
              <pre className="terminal-pre">{entry.stdout || <span className="terminal-muted">(stdout bo‘sh)</span>}</pre>
            </div>
            <div className={`terminal-pane ${entry.stderr ? 'has-error' : ''}`}>
              <div className="terminal-pane-title">stderr{entry.stderr ? ` · ${entry.stderr.length} chars` : ''}</div>
              <pre className="terminal-pre">{entry.stderr || <span className="terminal-muted">(stderr bo‘sh)</span>}</pre>
            </div>
          </div>
        </div>
      )}

      <div className="panel-card terminal-note">
        <AlertTriangle size={15} />
        <div>
          <b>Xavfsizlik</b>
          <span>
            Backend deny-list bilan himoyalangan, lekin buyruqlar baribir sizning kompyuteringizda bajariladi.
            Ishlatishdan oldin buyruqni o‘qib chiqing.
            {health?.ollama?.connected === false ? ' Ollama oflayn bo‘lsa ham terminal ishlaydi.' : ''}
          </span>
        </div>
      </div>
    </section>
  );
}
