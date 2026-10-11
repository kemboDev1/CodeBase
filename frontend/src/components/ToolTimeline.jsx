import React, { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, LoaderCircle, Wrench } from 'lucide-react';

const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|authorization|credential)/i;

function stringify(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Mask obviously secret arguments so a screenshot of the timeline never leaks a token. */
function redact(value, depth = 0) {
  if (depth > 4) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? '•••' : redact(item, depth + 1);
    }
    return out;
  }
  return value;
}

export function truncate(value, max = 400) {
  const text = stringify(value);
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}…`, truncated: true };
}

export function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(value / 60_000);
  return `${minutes}m ${Math.round((value % 60_000) / 1000)}s`;
}

function ToolRow({ tool, index }) {
  const running = tool?.running || (!tool?.running && tool?.durationMs === undefined && tool?.ok === undefined && !tool?.summary && !tool?.contentPreview);
  const failed = tool?.ok === false;
  const [open, setOpen] = useState(Boolean(running));
  const argsPreview = truncate(redact(tool?.args) ?? {}, 400);
  const resultPreview = truncate(tool?.summary || tool?.contentPreview || '', 600);

  return (
    <div className={`tool-row ${failed ? 'failed' : ''} ${running ? 'running' : ''}`}>
      <button type="button" className="tool-row-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className="tool-status">
          {running ? <LoaderCircle className="spin" size={13} /> : failed ? <AlertTriangle size={13} /> : <Check size={13} />}
        </span>
        <span className="tool-name">{tool?.name || `tool ${index + 1}`}</span>
        {tool?.title && tool.title !== tool.name ? <span className="tool-title">{tool.title}</span> : null}
        <span className="tool-duration">{running ? 'running…' : formatDuration(tool?.durationMs)}</span>
      </button>
      {open && (
        <div className="tool-row-body">
          <div className="tool-block">
            <span className="tool-block-label">Args</span>
            <pre className="tool-pre">{argsPreview.text || '—'}</pre>
          </div>
          {(tool?.summary || tool?.contentPreview) && (
            <div className="tool-block">
              <span className="tool-block-label">Result</span>
              <pre className="tool-pre">{resultPreview.text}</pre>
            </div>
          )}
          {failed && !tool?.summary && !tool?.contentPreview ? (
            <div className="tool-block">
              <span className="tool-block-label">Error</span>
              <pre className="tool-pre">Tool bajarilmadi yoki foydalanuvchi ruxsat bermadi.</pre>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Collapsible tool_start/tool_end pairs attached to one assistant message. */
export default function ToolTimeline({ tools = [], steps = 0, durationMs }) {
  const list = Array.isArray(tools) ? tools : [];
  const [collapsed, setCollapsed] = useState(false);
  if (!list.length) return null;
  const failed = list.filter((tool) => tool?.ok === false).length;

  return (
    <div className="tool-timeline">
      <div className="tool-timeline-head">
        <Wrench size={13} />
        <b>{list.length} tool call{list.length === 1 ? '' : 's'}</b>
        {failed ? <span className="tool-fail-count">{failed} failed</span> : null}
        <span className="tool-timeline-meta">
          {steps ? `${steps} step${steps === 1 ? '' : 's'}` : ''}
          {durationMs ? ` · ${formatDuration(durationMs)}` : ''}
        </span>
        <button type="button" className="tool-toggle" onClick={() => setCollapsed((value) => !value)}>
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </div>
      {!collapsed && (
        <div className="tool-timeline-body">
          {list.map((tool, index) => <ToolRow tool={tool} index={index} key={tool?.id || index} />)}
        </div>
      )}
    </div>
  );
}
