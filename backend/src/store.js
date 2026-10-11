import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { badRequest, notFound } from './lib/errors.js';

export const SCHEMA_VERSION = 2;

const dataDir = config.dataDir;
const dataFile = path.join(dataDir, 'store.json');
const backupDir = path.join(dataDir, 'backups');

export function makeId(prefix = 'item') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export const defaultSettings = () => ({
  model: config.defaultModel,
  fastModel: config.fastModel,
  numCtx: config.numCtx,
  temperature: config.temperature,
  maxSteps: config.maxSteps,
  ollamaUrl: config.ollamaUrl,
  workspaceRoots: Array.isArray(config.workspaceRoots) ? [...config.workspaceRoots] : [],
  theme: 'dark',
  autostartOllama: false,
  autoApproveReads: true,
  mode: 'auto',
  summarize: true,
  stream: true
});

function generalProject() {
  const now = new Date().toISOString();
  const session = { id: 'main', name: 'Asosiy suhbat', createdAt: now, updatedAt: now, messages: [] };
  return {
    id: 'general',
    name: 'General',
    description: 'Umumiy ish maydoni — savollar, tajribalar va tezkor vazifalar.',
    instructions:
      'Amaliy, aniq va tekshiriladigan yechim ber. Foydalanuvchi qaysi tilda yozsa, o‘sha tilda javob ber ' +
      '(o‘zbekcha so‘rovga o‘zbekcha, lotin yozuvida). Natijani o‘ylab topma: fayl o‘qigan bo‘lsang, ' +
      'haqiqiy mazmuniga tayan; buyruq ishlatmagan bo‘lsang, "ishlatmadim" deb ayt. Kod kerak bo‘lsa, ' +
      'fayl nomi va ishga tushirish buyrug‘ini ko‘rsat.',
    root: null,
    sessions: [session],
    activeSessionId: session.id,
    createdAt: now,
    updatedAt: now
  };
}

export const initialState = () => ({
  version: SCHEMA_VERSION,
  projects: [generalProject()],
  memories: [],
  skills: [],
  mcpServers: [],
  plugins: [],
  toolPolicies: {},
  pathRules: [],
  audit: [],
  settings: defaultSettings()
});

let state = null;
let writeQueue = Promise.resolve();

function migrate(raw) {
  const data = raw;
  const from = Number(data?.version) || 1;

  if (from < 2) {
    data.projects = (Array.isArray(data.projects) ? data.projects : []).map((project) => {
      if (Array.isArray(project.sessions) && project.sessions.length) return project;
      const now = project.updatedAt || new Date().toISOString();
      const session = {
        id: 'main',
        name: 'Asosiy suhbat',
        createdAt: project.createdAt || now,
        updatedAt: now,
        messages: Array.isArray(project.messages) ? project.messages : []
      };
      const { messages, ...rest } = project;
      void messages;
      return { ...rest, sessions: [session], activeSessionId: session.id, root: project.root || null };
    });
    data.version = 2;
    logger.info('Store v1 → v2 migratsiya qilindi (messages → sessions).');
  }

  if (!data.projects?.length) data.projects = [generalProject()];
  data.version = SCHEMA_VERSION;
  data.memories = Array.isArray(data.memories) ? data.memories : [];
  data.skills = Array.isArray(data.skills) ? data.skills : [];
  data.mcpServers = Array.isArray(data.mcpServers) ? data.mcpServers : [];
  data.plugins = Array.isArray(data.plugins) ? data.plugins : [];
  data.toolPolicies = data.toolPolicies && typeof data.toolPolicies === 'object' ? data.toolPolicies : {};
  data.pathRules = Array.isArray(data.pathRules) ? data.pathRules : [];
  data.audit = Array.isArray(data.audit) ? data.audit : [];
  data.settings = { ...defaultSettings(), ...(data.settings || {}) };

  for (const project of data.projects) {
    if (!Array.isArray(project.sessions) || !project.sessions.length) {
      const now = project.updatedAt || new Date().toISOString();
      project.sessions = [{ id: 'main', name: 'Asosiy suhbat', createdAt: now, updatedAt: now, messages: [] }];
    }
    for (const session of project.sessions) {
      if (!Array.isArray(session.messages)) session.messages = [];
    }
    if (!project.sessions.some((s) => s.id === project.activeSessionId)) {
      project.activeSessionId = project.sessions[0].id;
    }
    project.root = project.root || null;
  }
  return data;
}

export async function getStore() {
  if (state) return state;
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const raw = await fs.readFile(dataFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.projects)) throw new Error('Invalid store schema');
    const before = Number(parsed.version) || 1;
    state = migrate(parsed);
    if (before < SCHEMA_VERSION) {
      await backupStore(`pre-v${SCHEMA_VERSION}`);
      await saveStore();
    }
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError || error.message === 'Invalid store schema') {
      if (error instanceof SyntaxError) {
        const broken = path.join(dataDir, `store.corrupt-${Date.now()}.json`);
        try {
          await fs.copyFile(dataFile, broken);
          logger.warn(`Buzilgan store.json nusxasi saqlandi: ${broken}`);
        } catch {
          /* nothing else to do */
        }
      }
      state = initialState();
      await saveStore();
    } else {
      throw error;
    }
  }
  return state;
}

export async function saveStore() {
  if (!state) return;
  await fs.mkdir(dataDir, { recursive: true });
  const snapshot = JSON.stringify(state, null, 2);
  writeQueue = writeQueue
    .then(async () => {
      const temp = `${dataFile}.tmp`;
      await fs.writeFile(temp, snapshot, 'utf8');
      await fs.rename(temp, dataFile);
    })
    .catch((error) => {
      logger.error(`Store saqlanmadi: ${error.message}`);
    });
  await writeQueue;
}

/** Copy the current store file into <dataDir>/backups (keeps the newest 10). */
export async function backupStore(label = 'manual') {
  try {
    await fs.mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(backupDir, `store-${stamp}-${label}.json`);
    await fs.copyFile(dataFile, target);
    const files = (await fs.readdir(backupDir)).filter((f) => f.endsWith('.json')).sort();
    for (const old of files.slice(0, Math.max(0, files.length - 10))) {
      await fs.rm(path.join(backupDir, old), { force: true });
    }
    return target;
  } catch (error) {
    if (error.code !== 'ENOENT') logger.warn(`Backup qilinmadi: ${error.message}`);
    return null;
  }
}

/** Append an audit entry (ring buffer, newest first, max 500). */
export function recordAudit(entry) {
  if (!state) return null;
  const record = {
    id: makeId('audit'),
    at: new Date().toISOString(),
    tool: String(entry.tool || 'unknown').slice(0, 80),
    argsDigest: String(entry.argsDigest || '').slice(0, 40),
    decision: ['allow', 'ask', 'deny', 'denied', 'error'].includes(entry.decision) ? entry.decision : 'allow',
    ok: entry.ok !== false,
    ms: Math.max(0, Math.round(Number(entry.ms) || 0)),
    error: entry.error ? String(entry.error).slice(0, 300) : undefined,
    projectId: entry.projectId,
    sessionId: entry.sessionId
  };
  state.audit.unshift(record);
  if (state.audit.length > 500) state.audit.length = 500;
  return record;
}

// ── lookups / helpers used by the routes ──────────────────────────────────────

export function findProject(store, projectId) {
  const project = store.projects.find((item) => item.id === projectId);
  if (!project) throw notFound('Project topilmadi.');
  return project;
}

export function findSession(project, sessionId) {
  if (!project.sessions?.length) {
    const now = new Date().toISOString();
    project.sessions = [{ id: 'main', name: 'Asosiy suhbat', createdAt: now, updatedAt: now, messages: [] }];
    project.activeSessionId = 'main';
  }
  const id = sessionId || project.activeSessionId;
  const session = project.sessions.find((item) => item.id === id);
  if (!session) throw notFound('Suhbat (session) topilmadi.');
  return session;
}

export function createSession(project, name = 'Yangi suhbat') {
  const now = new Date().toISOString();
  const session = {
    id: makeId('session'),
    name: String(name || '').slice(0, 80) || 'Yangi suhbat',
    createdAt: now,
    updatedAt: now,
    messages: []
  };
  project.sessions.unshift(session);
  project.activeSessionId = session.id;
  project.updatedAt = now;
  return session;
}

export function projectSummary(project) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    instructions: project.instructions,
    root: project.root,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    activeSessionId: project.activeSessionId,
    sessionCount: project.sessions?.length || 0,
    messageCount: (project.sessions || []).reduce((sum, session) => sum + (session.messages?.length || 0), 0)
  };
}

export function assertProjectRoot(root) {
  if (!root) return null;
  if (typeof root !== 'string' || root.length > 500) throw badRequest('root yo‘li noto‘g‘ri.');
  return path.resolve(root);
}
