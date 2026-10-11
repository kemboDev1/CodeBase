// CodeBase API client — implements docs/ARCHITECTURE.md §14 (HTTP API + SSE) and §16 (window.codebase).
//
// - `api(path, { method, body, query })` returns parsed JSON and throws ApiError on failure.
// - `streamChat(body, handlers, { signal })` reads the SSE stream of POST /chat with fetch +
//   ReadableStream and dispatches one handler call per event envelope.

const TOKEN_KEY = 'codebase_token';
const DEV_FALLBACK_BASE = '/api';

function bridge() {
  return typeof window !== 'undefined' ? window.codebase : undefined;
}

/** True when the Electron preload bridge is present (desktop shell, not browser dev). */
export function hasBridge() {
  return Boolean(bridge()?.ready || bridge()?.apiBase);
}

function readQueryToken() {
  if (typeof window === 'undefined') return '';
  try {
    return new URLSearchParams(window.location.search).get('token') || '';
  } catch {
    return '';
  }
}

function readStoredToken() {
  try {
    return window.localStorage?.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

/** Resolve the auth token: preload bridge first, then ?token=, then localStorage (§16). */
export function resolveToken() {
  const bridgeToken = bridge()?.token;
  if (typeof bridgeToken === 'string' && bridgeToken) return bridgeToken;
  return readQueryToken() || readStoredToken() || '';
}

/** Resolve the API base URL: preload bridge first, then same-origin /api (§16). */
export function resolveApiBase() {
  const fromBridge = bridge()?.apiBase;
  if (typeof fromBridge === 'string' && fromBridge.trim()) return fromBridge.replace(/\/+$/, '');
  const port = bridge()?.port;
  if (port) return `http://127.0.0.1:${port}/api`;
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${DEV_FALLBACK_BASE}`;
  }
  return `http://127.0.0.1:3030/api`;
}

export const token = resolveToken();
export const apiBase = resolveApiBase();

/** Normalised API failure: `message` is always human-readable, `status` is 0 for network errors. */
export class ApiError extends Error {
  constructor(message, { status = 0, path = '', body = null } = {}) {
    super(message || 'Noma’lum API xatosi');
    this.name = 'ApiError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

function isAbort(error) {
  return error?.name === 'AbortError' || error?.code === 20 || error?.code === 'ABORT_ERR';
}

function buildUrl(path, query) {
  let url = `${apiBase}${path.startsWith('/') ? path : `/${path}`}`;
  if (query && typeof query === 'object') {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }
    const qs = params.toString();
    if (qs) url += `${url.includes('?') ? '&' : '?'}${qs}`;
  }
  return url;
}

function headersFor(extra = {}) {
  const headers = { Accept: 'application/json', ...extra };
  const current = resolveToken();
  if (current) headers['X-CodeBase-Token'] = current;
  return headers;
}

function normaliseBody(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (typeof FormData !== 'undefined' && body instanceof FormData) return body;
  return JSON.stringify(body);
}

function describeNetworkError(error) {
  if (error?.message === 'Failed to fetch' || error?.name === 'TypeError') {
    return 'Local backendga ulanib bo‘lmadi. Backend ishga tushganini va portni tekshiring.';
  }
  return error?.message || 'Tarmoq xatosi';
}

async function readPayload(response) {
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json')) return response.json().catch(() => null);
  const text = await response.text().catch(() => '');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 400) };
  }
}

/**
 * Perform one JSON API call.
 * @param {string} path e.g. '/projects/general/messages'
 * @param {{method?:string, body?:any, query?:object, signal?:AbortSignal, headers?:object}} options
 */
export async function api(path, { method = 'GET', body, query, signal, headers } = {}) {
  const url = buildUrl(path, query);
  const payload = normaliseBody(body);
  const options = {
    method,
    headers: headersFor(payload ? { 'Content-Type': 'application/json', ...headers } : headers),
    signal,
  };
  if (payload !== undefined) options.body = payload;

  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiError(describeNetworkError(error), { status: 0, path });
  }

  const data = await readPayload(response);
  if (!response.ok) {
    const message = (data && (data.error || data.message)) || `HTTP ${response.status}`;
    throw new ApiError(message, { status: response.status, path, body: data });
  }
  return data ?? {};
}

const NOOP_HANDLERS = {};

/**
 * Stream agent output from POST /chat.
 * Events (§14): run_start, step, token, tool_start, tool_end, permission_request,
 * permission_resolved, summary, done, error, ping.
 * Handler keys match the event type; an unexpected key is ignored.
 * @returns {Promise<{ok:boolean, aborted:boolean, error?:string}>}
 */
export async function streamChat(body, handlers = NOOP_HANDLERS, { signal } = {}) {
  const emit = (type, data) => {
    if (type === 'ping') return;
    const handler = handlers[type] || handlers.onEvent;
    if (typeof handler !== 'function') return;
    try {
      handler(data);
    } catch (error) {
      if (typeof handlers.onHandlerError === 'function') handlers.onHandlerError(error, data);
    }
  };
  const finish = (result) => {
    if (typeof handlers.onClose === 'function') {
      try {
        handlers.onClose(result);
      } catch {
        /* a close handler must never break the stream contract */
      }
    }
    return result;
  };

  let response;
  try {
    response = await fetch(buildUrl('/chat'), {
      method: 'POST',
      headers: headersFor({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
      body: normaliseBody(body),
      signal,
    });
  } catch (error) {
    if (isAbort(error)) return finish({ ok: false, aborted: true });
    const message = describeNetworkError(error);
    emit('error', { type: 'error', message });
    return finish({ ok: false, aborted: false, error: message });
  }

  if (!response.ok) {
    const data = await readPayload(response);
    const message = (data && (data.error || data.message)) || `HTTP ${response.status}`;
    emit('error', { type: 'error', message, status: response.status });
    return finish({ ok: false, aborted: false, error: message });
  }
  if (!response.body) {
    const message = 'Bu muhitda streaming (ReadableStream) mavjud emas.';
    emit('error', { type: 'error', message });
    return finish({ ok: false, aborted: false, error: message });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let doneSeen = false;

  const consume = (block) => {
    for (const rawLine of block.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (!line || line.startsWith(':') || line.startsWith('event:')) continue;
      if (!line.startsWith('data:')) continue;
      const chunk = line.slice(5).trim();
      if (!chunk || chunk === '[DONE]') continue;
      let event;
      try {
        event = JSON.parse(chunk);
      } catch {
        continue;
      }
      if (!event || typeof event !== 'object') continue;
      const type = event.type || 'message';
      if (type === 'done') doneSeen = true;
      emit(type, event);
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        consume(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
  } catch (error) {
    if (isAbort(error)) return finish({ ok: false, aborted: true });
    const message = describeNetworkError(error);
    emit('error', { type: 'error', message });
    return finish({ ok: false, aborted: false, error: message });
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* reader may already be released after an abort */
    }
  }

  return finish({ ok: true, aborted: false, done: doneSeen });
}

/* ---------- Electron bridge helpers (§16) — all no-ops when window.codebase is missing ---------- */

export async function pickFolder() {
  const fn = bridge()?.pickFolder;
  if (typeof fn !== 'function') return null;
  try {
    return (await fn()) || null;
  } catch {
    return null;
  }
}

export async function openPath(target) {
  const fn = bridge()?.openPath;
  if (typeof fn !== 'function' || !target) return false;
  try {
    await fn(target);
    return true;
  } catch {
    return false;
  }
}

export async function showInFolder(target) {
  const fn = bridge()?.showInFolder;
  if (typeof fn !== 'function' || !target) return false;
  try {
    await fn(target);
    return true;
  } catch {
    return false;
  }
}

export async function systemInfo() {
  const fn = bridge()?.systemInfo;
  if (typeof fn !== 'function') return null;
  try {
    return (await fn()) || null;
  } catch {
    return null;
  }
}

export async function getOllamaAutostart() {
  const fn = bridge()?.getOllamaAutostart;
  if (typeof fn !== 'function') return null;
  try {
    return Boolean(await fn());
  } catch {
    return null;
  }
}

export async function setOllamaAutostart(enabled) {
  const fn = bridge()?.setOllamaAutostart;
  if (typeof fn !== 'function') return null;
  try {
    return Boolean(await fn(Boolean(enabled)));
  } catch {
    return null;
  }
}

export async function startOllama() {
  const fn = bridge()?.startOllama;
  if (typeof fn !== 'function') return null;
  try {
    return (await fn()) || null;
  } catch {
    return null;
  }
}

export async function restartBackend() {
  const fn = bridge()?.restartBackend;
  if (typeof fn !== 'function') return null;
  try {
    return (await fn()) || null;
  } catch {
    return null;
  }
}

/** Subscribe to preload status pushes (`{ ollama, backend }`). Returns an unsubscribe function. */
export function onStatus(callback) {
  const fn = bridge()?.onStatus;
  if (typeof fn !== 'function' || typeof callback !== 'function') return () => {};
  try {
    const off = fn(callback);
    return typeof off === 'function' ? off : () => {};
  } catch {
    return () => {};
  }
}
