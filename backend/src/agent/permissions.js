import { makeId, saveStore } from '../store.js';
import { digest } from '../lib/text.js';

const READ_ONLY_CATEGORIES = new Set(['search']);
const READ_ONLY_PATTERN = /(^|\.)(read|list|stat|search|tree|detect|status|diff|log|info|health|version|models|list)(\.|$)/i;
const ASK_TIMEOUT_MS = 120_000;

function globToRegExp(pattern) {
  const escaped = String(pattern || '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/\?/g, '.')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`, process.platform === 'win32' ? 'i' : '');
}

function targetPathOf(args) {
  if (!args || typeof args !== 'object') return '';
  return String(args.path || args.file || args.cwd || args.dir || args.root || '').replace(/\\/g, '/');
}

function isReadOnlyTool(tool) {
  if (tool.dangerous) return false;
  if (READ_ONLY_CATEGORIES.has(tool.category)) return true;
  if (tool.defaultPolicy !== 'allow') return false;
  return READ_ONLY_PATTERN.test(tool.name);
}

/**
 * Permission engine. Resolution order: path rules → explicit tool policy →
 * tool default policy (with an optional "auto approve reads" upgrade).
 * `ask` requests are pushed to the UI over SSE and resolved by the renderer.
 */
export function createPermissions({ store, emit, logger } = {}) {
  const pending = new Map();
  const sessionGrants = new Map(); // sessionId → Set<toolName>
  const log = logger || { info() {}, warn() {}, debug() {} };

  function getStoreRef() {
    if (!store) throw new Error('Permissions: store kerak.');
    return store;
  }

  function policyFor(tool, args = {}) {
    const data = getStoreRef();
    const target = targetPathOf(args);

    for (const rule of data.pathRules || []) {
      if (!rule?.pattern || !rule?.policy) continue;
      try {
        if (globToRegExp(rule.pattern).test(target)) return rule.policy;
      } catch {
        /* invalid rule is ignored */
      }
    }

    const explicit = data.toolPolicies?.[tool.name];
    if (explicit && ['allow', 'ask', 'deny'].includes(explicit)) return explicit;

    if (data.settings?.autoApproveReads !== false && isReadOnlyTool(tool) && tool.defaultPolicy === 'allow') {
      return 'allow';
    }
    return tool.defaultPolicy || 'ask';
  }

  async function setPolicy(toolName, policy) {
    const data = getStoreRef();
    if (!['allow', 'ask', 'deny'].includes(policy)) throw new Error(`Noto‘g‘ri policy: ${policy}`);
    data.toolPolicies[toolName] = policy;
    await saveStore();
    return policy;
  }

  async function setPathRule(pattern, policy) {
    const data = getStoreRef();
    if (!pattern || !['allow', 'ask', 'deny'].includes(policy)) throw new Error('Noto‘g‘ri path rule.');
    globToRegExp(pattern); // throws on a broken pattern
    data.pathRules = (data.pathRules || []).filter((rule) => rule.pattern !== pattern);
    data.pathRules.unshift({ pattern: String(pattern), policy });
    await saveStore();
    return data.pathRules;
  }

  async function removePathRule(pattern) {
    const data = getStoreRef();
    data.pathRules = (data.pathRules || []).filter((rule) => rule.pattern !== pattern);
    await saveStore();
    return data.pathRules;
  }

  function pendingList() {
    return [...pending.values()].map(({ id, tool, title, args, reason, expiresAt, createdAt, sessionId, runId }) => ({
      id, tool, title, args, reason, expiresAt, createdAt, sessionId, runId
    }));
  }

  function resolve(id, { approved = false, remember = 'once' } = {}) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.finish({ approved: Boolean(approved), remember });
    log.debug(`Ruxsat ${approved ? 'berildi' : 'rad etildi'}: ${entry.tool} (${remember})`);
    return true;
  }

  /** Ask the user. Resolves with `{approved, remember}`; times out as denied. */
  function request({ tool, args = {}, sessionId, runId, projectId }) {
    const data = getStoreRef();

    const grants = sessionId ? sessionGrants.get(sessionId) : null;
    if (grants?.has(tool.name)) return Promise.resolve({ approved: true, remember: 'session', auto: true });

    const id = makeId('perm');
    const expiresAt = Date.now() + ASK_TIMEOUT_MS;
    const title = tool.title || tool.name;
    const reason = tool.dangerous
      ? 'Bu amal tizimga o‘zgartirish kiritadi.'
      : 'Bu tool sizning tasdiqlashingizni talab qiladi.';

    if (typeof emit === 'function') {
      emit({
        type: 'permission_request',
        id,
        tool: tool.name,
        title,
        category: tool.category,
        args,
        argsDigest: digest(args),
        reason,
        projectId,
        runId,
        createdAt: new Date().toISOString(),
        expiresAt
      });
    }

    return new Promise((resolvePromise) => {
      const finish = (answer) => {
        if (typeof emit === 'function') {
          emit({ type: 'permission_resolved', id, tool: tool.name, approved: answer.approved, remember: answer.remember });
        }
        resolvePromise(answer);
      };
      const timer = setTimeout(() => {
        pending.delete(id);
        log.warn(`Ruxsat so‘rovi vaqti tugadi: ${tool.name}`);
        finish({ approved: false, remember: 'once', timeout: true });
      }, ASK_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      pending.set(id, { id, tool: tool.name, title, args, reason, expiresAt, createdAt: Date.now(), sessionId, runId, finish, timer });

      void data;
    });
  }

  /** Persist a decision so future identical calls are not asked again. */
  async function remember(toolName, remember) {
    if (remember === 'always') await setPolicy(toolName, 'allow');
    return remember;
  }

  function grantSession(sessionId, toolName) {
    if (!sessionId) return;
    if (!sessionGrants.has(sessionId)) sessionGrants.set(sessionId, new Set());
    sessionGrants.get(sessionId).add(toolName);
  }

  function clearSession(sessionId) {
    sessionGrants.delete(sessionId);
  }

  return {
    policyFor,
    setPolicy,
    setPathRule,
    removePathRule,
    request,
    resolve,
    pending: pendingList,
    remember,
    grantSession,
    clearSession,
    isReadOnlyTool
  };
}

export default createPermissions;
