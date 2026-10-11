import React, { useState } from 'react';
import { Check, Copy, LoaderCircle } from 'lucide-react';

const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;

/** Convert **bold**, `code` and *italic* spans to React nodes. Safe: never uses innerHTML. */
export function inlineNodes(text) {
  const source = String(text ?? '');
  const parts = source.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

function CopyButton({ text, label = 'Kodni nusxalash' }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    const value = String(text ?? '');
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok && typeof document !== 'undefined') {
      try {
        const area = document.createElement('textarea');
        area.value = value;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        ok = document.execCommand('copy');
        document.body.removeChild(area);
      } catch {
        ok = false;
      }
    }
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }
  return (
    <button type="button" className="code-copy" onClick={copy} title={copied ? 'Nusxalandi' : label} aria-label={label}>
      {copied ? <Check size={12} /> : <Copy size={12} />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

export function CodeBlock({ code, language }) {
  const lang = String(language || '').trim();
  return (
    <div className="code-block-wrap">
      <div className="code-block-head">
        <span className="code-lang">{lang || 'text'}</span>
        <CopyButton text={code} />
      </div>
      <pre className="code-block"><code>{code}</code></pre>
    </div>
  );
}

function renderTextBlocks(text, keyPrefix) {
  const lines = String(text ?? '').split('\n');
  const nodes = [];
  let list = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    nodes.push(<p key={`${keyPrefix}-p${nodes.length}`}>{inlineNodes(paragraph.join('\n'))}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? 'ol' : 'ul';
    nodes.push(
      <Tag className="md-list" key={`${keyPrefix}-l${nodes.length}`}>
        {list.items.map((item, index) => <li key={index}>{inlineNodes(item)}</li>)}
      </Tag>,
    );
    list = null;
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);

    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length, 4);
      nodes.push(
        <div className={`md-heading h${level}`} key={`${keyPrefix}-h${nodes.length}`}>{inlineNodes(heading[2])}</div>,
      );
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushAll();
      nodes.push(<div className="md-rule" key={`${keyPrefix}-r${nodes.length}`} />);
      continue;
    }
    if (bullet || ordered) {
      flushParagraph();
      const orderedList = Boolean(ordered);
      if (!list || list.ordered !== orderedList) {
        flushList();
        list = { ordered: orderedList, items: [] };
      }
      list.items.push((bullet || ordered)[1]);
      continue;
    }
    if (quote) {
      flushAll();
      nodes.push(<div className="md-quote" key={`${keyPrefix}-q${nodes.length}`}>{inlineNodes(quote[1])}</div>);
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushAll();
  return nodes;
}

/**
 * Small, dependency-free markdown renderer: fenced code (language label + copy), headings,
 * lists, blockquotes, inline code and bold. Renders React nodes only — no innerHTML.
 *
 * The two shared page primitives (LoadingState, EmptyState) live in this module as well, so a
 * page has a single import for its small presentational helpers.
 */
export default function MarkdownLite({ text, className = '' }) {
  const source = String(text ?? '');
  if (!source) return null;

  const segments = [];
  let cursor = 0;
  FENCE_RE.lastIndex = 0;
  let match = FENCE_RE.exec(source);
  while (match) {
    if (match.index > cursor) segments.push({ kind: 'text', value: source.slice(cursor, match.index) });
    segments.push({ kind: 'code', language: (match[1] || '').trim(), value: match[2] });
    cursor = match.index + match[0].length;
    match = FENCE_RE.exec(source);
  }
  if (cursor < source.length) segments.push({ kind: 'text', value: source.slice(cursor) });

  return (
    <div className={`message-copy ${className}`.trim()}>
      {segments.map((segment, index) => (
        segment.kind === 'code'
          ? <CodeBlock code={segment.value} language={segment.language} key={`seg-${index}`} />
          : renderTextBlocks(segment.value, `seg-${index}`)
      ))}
    </div>
  );
}

/** Centred spinner with a helper sentence — used for every page's first load. */
export function LoadingState({ text = 'Yuklanmoqda…', rows = 0 }) {
  return (
    <div className="cb-loading">
      <LoaderCircle className="spin" size={22} />
      <span>{text}</span>
      {rows > 0 && (
        <div className="cb-skeleton">
          {Array.from({ length: rows }, (_, index) => <div className="cb-skeleton-row" key={index} />)}
        </div>
      )}
    </div>
  );
}

/** Consistent empty panel: icon, headline, one helper sentence and optional actions. */
export function EmptyState({ icon, title, hint, children, compact = false }) {
  return (
    <div className={`empty-panel ${compact ? 'compact' : ''}`}>
      {icon ? <div className="empty-icon">{icon}</div> : null}
      <b>{title}</b>
      {hint ? <span>{hint}</span> : null}
      {children ? <div className="cb-empty-actions">{children}</div> : null}
    </div>
  );
}
