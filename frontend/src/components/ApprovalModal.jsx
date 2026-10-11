import React, { useCallback, useEffect, useRef } from 'react';
import { ShieldAlert, ShieldCheck, X } from 'lucide-react';
import Modal from './Modal.jsx';

function truncate(value, max = 420) {
  let text;
  if (value === undefined || value === null) text = '';
  else if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const OPTIONS = [
  { key: 'once', label: 'Allow once', className: 'primary-btn', approved: true, remember: 'once' },
  { key: 'session', label: 'Allow for session', className: 'secondary-btn', approved: true, remember: 'session' },
  { key: 'always', label: 'Always allow', className: 'secondary-btn', approved: true, remember: 'always' },
];

/**
 * Renders the oldest pending `permission_request` from the SSE stream and queues the rest.
 * Escape denies the current request (documented behaviour of the approval flow).
 */
export default function ApprovalModal({ requests = [], onResolve }) {
  const queue = Array.isArray(requests) ? requests.filter(Boolean) : [];
  const current = queue[0];
  const primaryRef = useRef(null);

  useEffect(() => {
    if (!current) return undefined;
    const timer = setTimeout(() => primaryRef.current?.focus?.(), 30);
    return () => clearTimeout(timer);
  }, [current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape denies the pending request (the shell modal ignores Escape on purpose).
  useEffect(() => {
    if (!current) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      deny();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [current?.id, deny]); // eslint-disable-line react-hooks/exhaustive-deps

  const decide = useCallback((option) => {
    if (!current) return;
    onResolve?.(current, { approved: option.approved, remember: option.remember });
  }, [current, onResolve]);

  const deny = useCallback(() => {
    if (!current) return;
    onResolve?.(current, { approved: false, remember: 'once' });
  }, [current, onResolve]);

  if (!current) return null;

  const args = truncate(current.args);
  const reason = current.reason || current.summary || '';

  return (
    <Modal
      open
      size="md"
      // Escape is owned by the approval flow (Escape = deny); the modal must not silently close.
      onClose={() => {}}
      closeOnBackdrop={false}
      icon={<ShieldAlert size={19} />}
      title={current.title || current.tool?.title || current.tool?.name || current.tool || 'Ruxsat so‘ralmoqda'}
      description="Agent bu amalni bajarishdan oldin sizdan ruxsat so‘rayapti. Sabab va argumentlarni tekshirib, qaror qabul qiling."
      footer={(
        <>
          <button type="button" className="danger-btn" onClick={deny}>
            <X size={14} /> Deny
          </button>
          <span className="modal-spacer" />
          <button type="button" className="secondary-btn" onClick={() => decide(OPTIONS[2])}>Always allow</button>
          <button type="button" className="secondary-btn" onClick={() => decide(OPTIONS[1])}>Allow for session</button>
          <button type="button" className="primary-btn" ref={primaryRef} onClick={() => decide(OPTIONS[0])}>
            <ShieldCheck size={14} /> Allow once
          </button>
        </>
      )}
    >
      <div className="approval-body">
        <div className="approval-meta">
          <span className="approval-chip">{current.tool?.name || current.tool || 'tool'}</span>
          {current.tool?.category ? <span className="approval-chip subtle">{current.tool.category}</span> : null}
          {current.expiresAt ? <span className="approval-note">120 s ichida javob bering</span> : null}
          {queue.length > 1 ? <span className="approval-note">{queue.length - 1} more waiting</span> : null}
        </div>
        {reason ? (
          <div className="approval-reason"><ShieldAlert size={13} /><span>{reason}</span></div>
        ) : null}
        <div className="approval-args">
          <span className="tool-block-label">Arguments</span>
          <pre className="tool-pre">{args || '—'}</pre>
        </div>
        {queue.length > 1 ? (
          <div className="approval-queue">
            {queue.slice(1, 4).map((item) => (
              <span className="approval-chip subtle" key={item.id}>{item.title || item.tool?.name || item.tool}</span>
            ))}
          </div>
        ) : null}
        <p className="approval-hint">
          <kbd>Esc</kbd> deny · “Allow for session” shu suhbat davomida eslab qoladi, “Always allow” esa doimiy siyosat yozadi.
          Kutayotgan so‘rovlarni bekor qilish uchun chatdagi Stop tugmasidan foydalaning.
        </p>
      </div>
    </Modal>
  );
}
