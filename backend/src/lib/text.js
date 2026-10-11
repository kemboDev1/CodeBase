import crypto from 'node:crypto';

/** Cheap token estimate that matches small local models well enough for budgeting. */
export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** Truncate text with an explicit marker so the model knows content was cut. */
export function truncate(value, max = 4000, marker = '\n… [qisqartirildi]') {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - marker.length)) + marker;
}

/** Keep the tail (useful for command output, where errors appear last). */
export function tail(value, max = 4000) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `… [bosh qismi qisqartirildi]\n${text.slice(text.length - max)}`;
}

export function digest(value) {
  return crypto.createHash('sha1').update(typeof value === 'string' ? value : JSON.stringify(value ?? '')).digest('hex').slice(0, 12);
}

export function stripAnsi(value) {
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

export function normalizeNewlines(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function oneLine(value, max = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function safeJsonParse(value, fallback = null) {
  if (value && typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

/** Normalise a relative or absolute path string to forward slashes for display. */
export function posix(value) {
  return String(value ?? '').split('\\').join('/');
}

/** Byte size for humans. */
export function humanBytes(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
