import config from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const RING_MAX = 300;
const ring = [];
const listeners = new Set();

let threshold = LEVELS[config.logLevel] || LEVELS.info;

export function setLogLevel(level) {
  threshold = LEVELS[String(level || '').toLowerCase()] || LEVELS.info;
}

export function ringBuffer(limit = 200) {
  const size = Math.min(Math.max(Number(limit) || 200, 1), RING_MAX);
  return ring.slice(-size);
}

/** Subscribe to log lines (used by the SSE status stream). Returns an unsubscribe function. */
export function onLog(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function write(level, scope, message, meta) {
  if (LEVELS[level] < threshold) return;
  const at = new Date().toISOString();
  const text = String(message ?? '');
  const entry = { at, level, scope, msg: text };
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();

  let line = `${at.slice(11, 23)} ${level.toUpperCase().padEnd(5)} [${scope}] ${text}`;
  if (meta !== undefined) {
    try {
      line += ` ${typeof meta === 'string' ? meta : JSON.stringify(meta)}`;
    } catch {
      line += ' [unserialisable meta]';
    }
  }
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(`${line}\n`);
  for (const fn of listeners) {
    try {
      fn(entry);
    } catch {
      /* a broken listener must never break logging */
    }
  }
}

/**
 * Scoped logger. `logger.make('mcp')` returns a bound child logger.
 */
export const logger = {
  debug: (message, meta) => write('debug', 'core', message, meta),
  info: (message, meta) => write('info', 'core', message, meta),
  warn: (message, meta) => write('warn', 'core', message, meta),
  error: (message, meta) => write('error', 'core', message, meta),
  make(scope) {
    return {
      debug: (message, meta) => write('debug', scope, message, meta),
      info: (message, meta) => write('info', scope, message, meta),
      warn: (message, meta) => write('warn', scope, message, meta),
      error: (message, meta) => write('error', scope, message, meta)
    };
  }
};

export default logger;
