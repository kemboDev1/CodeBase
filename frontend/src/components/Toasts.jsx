import React from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';

const ICONS = {
  ok: CheckCircle2,
  error: XCircle,
  warn: AlertTriangle,
  info: Info,
};

/** Bottom-right toast stack. Auto-dismiss countdown lives in AppContext. */
export default function Toasts({ toasts = [], onDismiss }) {
  const list = Array.isArray(toasts) ? toasts : [];
  if (!list.length) return null;

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {list.map((toast) => {
        const tone = ICONS[toast?.tone] ? toast.tone : 'info';
        const Icon = ICONS[tone];
        return (
          <div className={`toast toast-${tone}`} key={toast?.id || Math.random()}>
            <Icon size={15} />
            <span className="toast-text">{toast?.text}</span>
            <button type="button" onClick={() => onDismiss?.(toast?.id)} title="Yopish" aria-label="Yopish">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
