import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Save } from 'lucide-react';

function beforeUnloadGuard(event) {
  event.preventDefault();
  event.returnValue = '';
  return '';
}

function insertAtSelection(textarea, before, after = before) {
  const start = textarea.selectionStart ?? 0;
  const end = textarea.selectionEnd ?? 0;
  const value = textarea.value ?? '';
  const selected = value.slice(start, end);
  const next = `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`;
  const caret = start + before.length + selected.length + after.length;
  return { next, caret };
}

/**
 * Textarea-based editor with a synced line-number gutter, mono font, Ctrl/Cmd+S save,
 * dirty tracking and an unsaved-changes guard while the page is open.
 */
export default function CodeEditor({
  value = '',
  onChange,
  onSave,
  path,
  readOnly = false,
  truncated = false,
  size,
  saving = false,
  placeholder = 'Fayl bo‘sh. Yozishni boshlang…',
  minLines = 12,
}) {
  const textareaRef = useRef(null);
  const gutterRef = useRef(null);
  const baselineRef = useRef({ path, value: value ?? '' });
  const [cursor, setCursor] = useState({ line: 1, column: 1 });

  const text = value ?? '';
  const dirty = baselineRef.current.path === path && baselineRef.current.value !== text;
  const lines = useMemo(() => text.split('\n').length, [text]);

  // A different file arrives: reset the dirty baseline and go back to the top.
  useEffect(() => {
    baselineRef.current = { path, value: text };
    if (textareaRef.current) textareaRef.current.scrollTop = 0;
    if (gutterRef.current) gutterRef.current.scrollTop = 0;
    setCursor({ line: 1, column: 1 });
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!dirty) return undefined;
    window.addEventListener('beforeunload', beforeUnloadGuard);
    return () => window.removeEventListener('beforeunload', beforeUnloadGuard);
  }, [dirty]);

  const syncScroll = useCallback(() => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  }, []);

  const updateCursor = useCallback(() => {
    const area = textareaRef.current;
    if (!area) return;
    const upto = (area.value ?? '').slice(0, area.selectionStart ?? 0);
    const parts = upto.split('\n');
    setCursor({ line: parts.length, column: (parts[parts.length - 1] || '').length + 1 });
  }, []);

  const save = useCallback(async () => {
    if (readOnly || saving) return;
    // Clear the dirty flag before awaiting so Ctrl+S feels instant, then confirm with the returned text.
    baselineRef.current = { path, value: text };
    const saved = await onSave?.(text);
    if (typeof saved === 'string' && saved !== text) baselineRef.current = { path, value: saved };
  }, [readOnly, saving, onSave, text, path]);

  const onKeyDown = useCallback((event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      const area = event.currentTarget;
      if (event.shiftKey) {
        const start = area.selectionStart ?? 0;
        const lineStart = area.value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
        const head = area.value.slice(lineStart, lineStart + 2);
        if (head === '  ') {
          const next = `${area.value.slice(0, lineStart)}${area.value.slice(lineStart + 2)}`;
          onChange?.(next);
          requestAnimationFrame(() => {
            area.selectionStart = Math.max(lineStart, start - 2);
            area.selectionEnd = area.selectionStart;
          });
        }
        return;
      }
      const { next, caret } = insertAtSelection(area, '  ', '');
      onChange?.(next);
      requestAnimationFrame(() => {
        area.selectionStart = caret;
        area.selectionEnd = caret;
      });
    }
  }, [onChange, save]);

  return (
    <div className="editor-shell">
      <div className="editor-bar">
        <span className="editor-path" title={path || ''}>{path || 'Yangi fayl'}</span>
        {dirty ? <span className="dirty-flag"><AlertTriangle size={11} /> unsaved</span> : <span className="saved-flag">saved</span>}
        {truncated ? <span className="editor-note" title="Fayl katta, faqat bir qismi ko‘rsatilgan">truncated</span> : null}
        {typeof size === 'number' ? <span className="editor-note">{size} B</span> : null}
        <span className="editor-note">{lines} lines</span>
        <button type="button" className="primary-btn editor-save" onClick={save} disabled={readOnly || saving || !dirty}>
          <Save size={14} /> {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <div className="editor-body">
        <div className="editor-gutter" ref={gutterRef} aria-hidden="true">
          {Array.from({ length: Math.max(lines, minLines) }, (_, index) => (
            <span className={index + 1 === cursor.line ? 'active' : ''} key={index}>{index + 1}</span>
          ))}
        </div>
        <textarea
          ref={textareaRef}
          className="editor-textarea"
          value={text}
          spellCheck={false}
          readOnly={readOnly}
          placeholder={placeholder}
          onChange={(event) => onChange?.(event.target.value)}
          onScroll={syncScroll}
          onKeyDown={onKeyDown}
          onKeyUp={updateCursor}
          onClick={updateCursor}
          onSelect={updateCursor}
        />
      </div>
      <div className="editor-foot">
        <span>Ln {cursor.line}, Col {cursor.column}</span>
        <span>{text.length} chars</span>
        <span className="editor-foot-hint"><kbd>Ctrl</kbd> + <kbd>S</kbd> save · <kbd>Tab</kbd> indent</span>
      </div>
    </div>
  );
}
