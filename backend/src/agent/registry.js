import { digest, oneLine } from '../lib/text.js';
import { recordAudit } from '../store.js';
import { AppError } from '../lib/errors.js';

const NAME_RE = /^[a-z0-9][a-z0-9._-]{1,79}$/i;

function coerce(value, type) {
  if (value === undefined || value === null) return value;
  switch (type) {
    case 'number':
    case 'integer': {
      if (typeof value === 'number') return type === 'integer' ? Math.trunc(value) : value;
      const parsed = Number(String(value).trim());
      if (!Number.isFinite(parsed)) return value;
      return type === 'integer' ? Math.trunc(parsed) : parsed;
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const text = String(value).trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(text)) return true;
      if (['false', '0', 'no', 'off'].includes(text)) return false;
      return value;
    }
    case 'array': {
      if (Array.isArray(value)) return value;
      if (typeof value === 'string' && value.trim().startsWith('[')) {
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) ? parsed : [value];
        } catch {
          return [value];
        }
      }
      return typeof value === 'string' ? [value] : value;
    }
    case 'object': {
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
      if (typeof value === 'string' && value.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(value);
          if (parsed && typeof parsed === 'object') return parsed;
        } catch {
          /* fall through */
        }
      }
      return value;
    }
    default:
      return value;
  }
}

/**
 * Lightweight JSON-Schema validation: required fields, primitive coercion and
 * unknown-key stripping. Small local models routinely emit `"5"` for a number.
 */
export function validateArgs(schema, rawArgs) {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? { ...rawArgs } : {};
  const properties = schema?.properties || {};
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const out = {};

  for (const [key, value] of Object.entries(args)) {
    const definition = properties[key];
    if (!definition) continue; // drop unknown keys so tools never receive surprises
    out[key] = coerce(value, definition.type);
  }

  for (const key of required) {
    const value = out[key];
    if (value === undefined || value === null || value === '') {
      return { ok: false, error: `Majburiy parametr yetishmayapti: ${key}` };
    }
    const type = properties[key]?.type;
    if (type && type !== 'object' && type !== 'array' && typeof value !== type) {
      return { ok: false, error: `${key} turi ${type} bo‘lishi kerak.` };
    }
    if (type === 'array' && !Array.isArray(value)) return { ok: false, error: `${key} massiv bo‘lishi kerak.` };
    if (type === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
      return { ok: false, error: `${key} obyekt bo‘lishi kerak.` };
    }
  }

  const extra = properties.additionalProperties === true ? {} : {};
  return { ok: true, value: { ...out, ...extra } };
}

/**
 * Tool registry: the single place where tools are declared, converted to Ollama
 * function definitions, permission-checked and executed.
 */
export function createRegistry({ logger } = {}) {
  const tools = new Map();
  const log = logger || { info() {}, warn() {}, error() {}, debug() {} };

  function register(tool) {
    if (!tool || typeof tool !== 'object') throw new AppError('Tool obyekt bo‘lishi kerak.', 500);
    if (!NAME_RE.test(String(tool.name || ''))) throw new AppError(`Tool nomi noto‘g‘ri: ${tool.name}`, 500);
    if (typeof tool.run !== 'function') throw new AppError(`Tool run() funksiyasi yo‘q: ${tool.name}`, 500);
    if (tools.has(tool.name)) {
      log.warn(`Tool allaqachon ro‘yxatda: ${tool.name}`);
      return tools.get(tool.name);
    }
    const entry = {
      source: 'core',
      category: 'system',
      defaultPolicy: 'ask',
      dangerous: false,
      timeoutMs: 120_000,
      parameters: { type: 'object', properties: {} },
      ...tool
    };
    tools.set(entry.name, entry);
    log.debug(`Tool ro‘yxatga olindi: ${entry.name}`);
    return entry;
  }

  function unregister(name) {
    const existed = tools.delete(name);
    if (existed) log.debug(`Tool ro‘yxatdan chiqarildi: ${name}`);
    return existed;
  }

  function unregisterByPrefix(prefix) {
    let count = 0;
    for (const name of [...tools.keys()]) {
      if (name.startsWith(prefix)) {
        tools.delete(name);
        count += 1;
      }
    }
    return count;
  }

  const get = (name) => tools.get(name);
  const names = () => [...tools.keys()];

  function list(policyLookup) {
    return [...tools.values()]
      .map((tool) => ({
        name: tool.name,
        title: tool.title || tool.name,
        description: tool.description,
        category: tool.category,
        parameters: tool.parameters,
        defaultPolicy: tool.defaultPolicy,
        source: tool.source,
        dangerous: Boolean(tool.dangerous),
        enabled: tool.enabled !== false,
        policy: typeof policyLookup === 'function' ? policyLookup(tool) : tool.defaultPolicy
      }))
      .sort((a, b) => (a.category === b.category ? a.name.localeCompare(b.name) : a.category.localeCompare(b.category)));
  }

  function toOllamaTools(filter) {
    const allowed = typeof filter === 'function' ? filter : () => true;
    return [...tools.values()]
      .filter((tool) => tool.enabled !== false && allowed(tool))
      .map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters || { type: 'object', properties: {} }
        }
      }));
  }

  async function execute(name, rawArgs, ctx = {}) {
    const started = Date.now();
    const tool = tools.get(name);
    const emit = typeof ctx.emit === 'function' ? ctx.emit : () => {};
    if (!tool) {
      const available = [...tools.keys()].join(', ');
      const error = `Noma’lum tool: ${name}. Mavjud tool’lar: ${available.slice(0, 900)}`;
      recordAudit({ tool: name, decision: 'error', ok: false, error, projectId: ctx.projectId, sessionId: ctx.sessionId });
      return { ok: false, error, content: `XATO: ${error}` };
    }
    if (tool.enabled === false) {
      return { ok: false, error: `Tool o‘chirilgan: ${name}`, content: `XATO: ${name} tool hozir o‘chirilgan.` };
    }

    const validated = validateArgs(tool.parameters, rawArgs);
    if (validated.ok === false) {
      recordAudit({ tool: name, decision: 'error', ok: false, error: validated.error, projectId: ctx.projectId, sessionId: ctx.sessionId });
      return { ok: false, error: validated.error, content: `XATO: ${validated.error}` };
    }
    const args = validated.value;

    const policy = ctx.permissions?.policyFor ? ctx.permissions.policyFor(tool, args) : tool.defaultPolicy;
    let decision = policy;
    if (policy === 'deny') {
      const error = `"${tool.title || tool.name}" tooli siyosat bo‘yicha taqiqlangan.`;
      recordAudit({ tool: name, argsDigest: digest(args), decision: 'deny', ok: false, error, projectId: ctx.projectId, sessionId: ctx.sessionId });
      emit({ type: 'tool_denied', name, title: tool.title, reason: error });
      return { ok: false, error, content: `XATO: ${error}` };
    }
    if (policy === 'ask') {
      const answer = await ctx.permissions.request({
        tool,
        args,
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        projectId: ctx.projectId
      });
      if (!answer?.approved) {
        const error = 'Foydalanuvchi ruxsat bermadi.';
        recordAudit({ tool: name, argsDigest: digest(args), decision: 'denied', ok: false, error, projectId: ctx.projectId, sessionId: ctx.sessionId });
        return { ok: false, error, content: `XATO: ${error} Boshqa yo‘l tanlang yoki foydalanuvchidan so‘rang.` };
      }
      decision = 'ask';
    }

    const timeoutMs = Math.max(1000, Number(tool.timeoutMs) || 120_000);
    const timer = AbortSignal.timeout(timeoutMs);
    const signal = ctx.signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([ctx.signal, timer]) : timer;

    try {
      const result = await tool.run(args, { ...ctx, signal, tool });
      const ms = Date.now() - started;
      const normalized = result && typeof result === 'object'
        ? result
        : { ok: true, summary: oneLine(String(result), 120), content: String(result ?? '') };
      if (normalized.ok === false) {
        recordAudit({
          tool: name, argsDigest: digest(args), decision, ok: false,
          error: normalized.error || 'tool xatosi', ms, projectId: ctx.projectId, sessionId: ctx.sessionId
        });
        return {
          ok: false,
          error: normalized.error || 'Tool xatosi',
          content: String(normalized.content || `XATO: ${normalized.error || 'tool xatosi'}`),
          ms
        };
      }
      recordAudit({ tool: name, argsDigest: digest(args), decision, ok: true, ms, projectId: ctx.projectId, sessionId: ctx.sessionId });
      return {
        ok: true,
        summary: String(normalized.summary || `${tool.title || tool.name} bajarildi`).slice(0, 300),
        content: String(normalized.content ?? normalized.summary ?? ''),
        data: normalized.data,
        ms
      };
    } catch (error) {
      const ms = Date.now() - started;
      const message = error?.name === 'TimeoutError'
        ? `Tool vaqti tugadi (${Math.round(timeoutMs / 1000)}s): ${tool.name}`
        : String(error?.message || error);
      recordAudit({ tool: name, argsDigest: digest(args), decision: 'error', ok: false, error: message, ms, projectId: ctx.projectId, sessionId: ctx.sessionId });
      return { ok: false, error: message, content: `XATO: ${message}`, ms };
    }
  }

  return { register, unregister, unregisterByPrefix, get, list, names, toOllamaTools, execute, size: () => tools.size };
}

export default createRegistry;
