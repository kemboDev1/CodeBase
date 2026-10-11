import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * Accessible modal shell: portal, Escape to close, backdrop click to close,
 * focus moved inside and restored on close.
 */
export default function Modal({
  open,
  onClose,
  title,
  description,
  icon,
  children,
  footer,
  size = 'md',
  closeOnBackdrop = true,
  labelledBy,
}) {
  const cardRef = useRef(null);
  const restoreRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    restoreRef.current = typeof document !== 'undefined' ? document.activeElement : null;
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closeRef.current?.();
        return;
      }
      if (event.key === 'Tab' && cardRef.current) {
        const focusable = cardRef.current.querySelectorAll(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    const timer = setTimeout(() => {
      const target = cardRef.current?.querySelector('[data-autofocus], input, textarea, select, button');
      target?.focus?.();
    }, 30);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      clearTimeout(timer);
      restoreRef.current?.focus?.();
    };
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  const titleId = labelledBy || `modal-${String(title || 'shell').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => { if (closeOnBackdrop && event.target === event.currentTarget) onClose?.(); }}
    >
      <div className={`modal-card modal-${size}`} ref={cardRef} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-top">
          {icon ? <div className="modal-icon">{icon}</div> : <span />}
          <button type="button" className="modal-close" onClick={() => onClose?.()} title="Yopish" aria-label="Yopish">
            <X size={17} />
          </button>
        </div>
        {title ? <h2 id={titleId}>{title}</h2> : null}
        {description ? <p>{description}</p> : null}
        {children}
        {footer ? <div className="modal-actions">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
