import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, getOllamaAutostart, onStatus, setOllamaAutostart as bridgeSetAutostart, streamChat } from '../api/client.js';

const AppContext = createContext(null);
const HEALTH_POLL_MS = 10_000;

const EMPTY_SETTINGS = {
  model: '', fastModel: '', numCtx: 8192, temperature: 0.2, maxSteps: 8, ollamaUrl: '',
  workspaceRoots: [], theme: 'dark', autostartOllama: false, autoApproveReads: true,
  mode: 'auto', summarize: true,
};

function tempId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function message(text, tone = 'info') {
  return { id: tempId('toast'), text, tone };
}

/** Turn any thrown value into a short, user-safe sentence. */
export function errorText(error, fallback = 'Amal bajarilmadi') {
  if (!error) return fallback;
  if (error instanceof ApiError) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message) return error.message;
  return fallback;
}

export function AppProvider({ children }) {
  const [projects, setProjects] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState('general');
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState('default');
  const [messages, setMessages] = useState([]);
  const [models, setModels] = useState([]);
  const [model, setModelState] = useState('');
  const [mode, setModeState] = useState('auto');
  const [health, setHealth] = useState(null);
  const [tools, setTools] = useState([]);
  const [mcpServers, setMcpServers] = useState([]);
  const [plugins, setPlugins] = useState([]);
  const [skills, setSkills] = useState([]);
  const [memories, setMemories] = useState([]);
  const [settings, setSettings] = useState(EMPTY_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [error, setErrorState] = useState('');
  const [toasts, setToasts] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [ollamaStatus, setOllamaStatus] = useState(null);
  const [backendStatus, setBackendStatus] = useState(null);
  const [bridgeDataDir, setBridgeDataDir] = useState('');
  const [loading, setLoading] = useState(true);

  const runRef = useRef(null);
  const modelRef = useRef('');
  const modeRef = useRef('auto');
  const projectRef = useRef('general');
  const sessionRef = useRef('');
  const projectsRef = useRef([]);

  modelRef.current = model;
  modeRef.current = mode;
  projectRef.current = activeProjectId;
  sessionRef.current = activeSessionId;
  projectsRef.current = projects;

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const pushToast = useCallback((text, tone = 'info') => {
    const entry = message(text, tone);
    setToasts((prev) => [...prev.slice(-4), entry]);
    return entry.id;
  }, []);

  const clearError = useCallback(() => setErrorState(''), []);
  const setError = useCallback((value) => setErrorState(value ? String(value) : ''), []);

  /** Wrap an API action: pushes an error toast + banner and never lets a rejection escape. */
  const run = useCallback(async (label, fn, { silent = false } = {}) => {
    try {
      return await fn();
    } catch (err) {
      const text = errorText(err, label);
      setErrorState(text);
      if (!silent) pushToast(`${label}: ${text}`, 'error');
      return undefined;
    }
  }, [pushToast]);

  useEffect(() => {
    if (!toasts.length) return undefined;
    const timer = setTimeout(() => setToasts((prev) => prev.slice(1)), 6500);
    return () => clearTimeout(timer);
  }, [toasts]);

  const refreshHealth = useCallback(async () => {
    try {
      const data = await api('/health');
      setHealth(data || {});
      return data;
    } catch (err) {
      setHealth({ ok: false, ollama: { connected: false }, error: errorText(err) });
      return undefined;
    }
  }, []);

  const refreshModels = useCallback(async () => {
    try {
      const data = await api('/models');
      const list = Array.isArray(data?.models) ? data.models : [];
      setModels(list);
      return list;
    } catch {
      return [];
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const data = await api('/settings');
      const next = { ...EMPTY_SETTINGS, ...(data?.settings || {}) };
      if (!Array.isArray(next.workspaceRoots)) next.workspaceRoots = [];
      setSettings(next);
      if (next.mode) {
        setModeState(next.mode);
        modeRef.current = next.mode;
      }
      if (next.model) {
        setModelState((current) => current || next.model);
        modelRef.current = modelRef.current || next.model;
      }
      if (typeof data?.dataDir === 'string') setBridgeDataDir(data.dataDir);
      return next;
    } catch (err) {
      pushToast(`Settings: ${errorText(err)}`, 'error');
      return undefined;
    }
  }, [pushToast]);

  const refreshTools = useCallback(async () => {
    try {
      const data = await api('/tools');
      setTools(Array.isArray(data?.tools) ? data.tools : []);
    } catch {
      setTools([]);
    }
  }, []);

  const refreshMcp = useCallback(async () => {
    try {
      const data = await api('/mcp/servers');
      setMcpServers(Array.isArray(data?.servers) ? data.servers : []);
      return data;
    } catch {
      return undefined;
    }
  }, []);

  const refreshPlugins = useCallback(async () => {
    try {
      const data = await api('/plugins');
      setPlugins(Array.isArray(data?.plugins) ? data.plugins : []);
      return data;
    } catch {
      return undefined;
    }
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const data = await api('/projects');
      const list = Array.isArray(data?.projects) ? data.projects : [];
      projectsRef.current = list;
      setProjects(list);
      setActiveProjectId((current) => {
        if (list.some((item) => item.id === current)) return current;
        const general = list.find((item) => item.id === 'general');
        const next = general?.id || list[0]?.id || current;
        projectRef.current = next;
        return next;
      });
      return list;
    } catch (err) {
      pushToast(`Projects: ${errorText(err)}`, 'error');
      return [];
    }
  }, [pushToast]);

  const refreshSkills = useCallback(async () => {
    try {
      const data = await api('/skills');
      setSkills(Array.isArray(data?.skills) ? data.skills : []);
      return data;
    } catch (err) {
      pushToast(`Skills: ${errorText(err)}`, 'error');
      return undefined;
    }
  }, [pushToast]);

  const refreshMemories = useCallback(async () => {
    try {
      const data = await api('/memories');
      setMemories(Array.isArray(data?.memories) ? data.memories : []);
      return data;
    } catch (err) {
      pushToast(`Memory: ${errorText(err)}`, 'error');
      return undefined;
    }
  }, [pushToast]);

  const loadMessages = useCallback(async (projectId = projectRef.current, sessionId = '') => {
    if (!projectId) return undefined;
    try {
      const query = sessionId ? { sessionId } : undefined;
      const data = await api(`/projects/${encodeURIComponent(projectId)}/messages`, { query });
      const list = Array.isArray(data?.messages) ? data.messages : [];
      const nextSessions = Array.isArray(data?.sessions) ? data.sessions : [];
      setMessages(list);
      setSessions(nextSessions);
      const session = data?.session;
      const resolved = session?.id || nextSessions[0]?.id || sessionId || sessionRef.current;
      setActiveSessionId(resolved);
      sessionRef.current = resolved;
      return data;
    } catch (err) {
      setMessages([]);
      setSessions([]);
      pushToast(`Chat tarixi: ${errorText(err)}`, 'error');
      return undefined;
    }
  }, [pushToast]);

  const loadSessionList = useCallback(async (projectId = projectRef.current) => {
    if (!projectId) return;
    const data = await run('Sessions', () => api(`/projects/${encodeURIComponent(projectId)}/messages`), { silent: true });
    const list = Array.isArray(data?.sessions) ? data.sessions : [];
    setSessions(list);
  }, [run]);

  const refreshAll = useCallback(async ({ silent = false } = {}) => {
    setLoading(true);
    await Promise.all([refreshHealth(), refreshModels(), loadSettings()]);
    await Promise.all([loadProjects(), refreshSkills(), refreshMemories()]);
    if (!silent) await loadMessages(projectRef.current);
    setLoading(false);
  }, [refreshHealth, refreshModels, loadSettings, loadProjects, refreshSkills, refreshMemories, loadMessages]);

  useEffect(() => {
    refreshAll();
    // Initial load only: later refreshes are triggered by explicit actions and the health poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = setInterval(() => { refreshHealth(); }, HEALTH_POLL_MS);
    const onFocus = () => {
      refreshHealth();
      refreshModels();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshHealth, refreshModels]);

  useEffect(() => {
    return onStatus((status) => {
      if (!status || typeof status !== 'object') return;
      if (status.ollama) setOllamaStatus(status.ollama);
      if (status.backend) setBackendStatus(status.backend);
    });
  }, []);

  /* ---------------- model / mode ---------------- */

  const selectModel = useCallback(async (name) => {
    const next = name || '';
    setModelState(next);
    modelRef.current = next;
    setSettings((prev) => ({ ...prev, model: next }));
    try {
      const data = await api('/settings', { method: 'PATCH', body: { model: next } });
      if (data?.settings) setSettings((prev) => ({ ...prev, ...data.settings }));
    } catch (err) {
      pushToast(`Model saqlanmadi: ${errorText(err)}`, 'error');
    }
  }, [pushToast]);

  const selectMode = useCallback((next) => {
    const value = next || 'auto';
    setModeState(value);
    modeRef.current = value;
    setSettings((prev) => ({ ...prev, mode: value }));
  }, []);

  const patchSettings = useCallback(async (partial) => {
    setSettings((prev) => ({ ...prev, ...partial }));
    if (partial?.mode) selectMode(partial.mode);
    if (partial?.model) setModelState(partial.model);
    try {
      const data = await api('/settings', { method: 'PATCH', body: partial });
      if (data?.settings) setSettings((prev) => ({ ...prev, ...data.settings }));
      pushToast('Sozlamalar saqlandi', 'ok');
      return data?.settings;
    } catch (err) {
      pushToast(`Sozlamalar: ${errorText(err)}`, 'error');
      return undefined;
    }
  }, [pushToast, selectMode]);

  /* ---------------- projects ---------------- */

  const selectProject = useCallback(async (id) => {
    setActiveProjectId(id);
    projectRef.current = id;
    setErrorState('');
    await loadMessages(id, '');
  }, [loadMessages]);

  const createProject = useCallback(async (fields) => {
    const data = await run('Project yaratish', () => api('/projects', { method: 'POST', body: fields }));
    if (!data?.project) return undefined;
    setProjects((prev) => [data.project, ...prev]);
    pushToast('Project yaratildi', 'ok');
    await selectProject(data.project.id);
    return data.project;
  }, [run, pushToast, selectProject]);

  const updateProject = useCallback(async (id, fields) => {
    const data = await run('Projectni saqlash', () => api(`/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: fields }));
    if (!data?.project) return undefined;
    setProjects((prev) => prev.map((item) => (item.id === id ? { ...item, ...data.project } : item)));
    pushToast('Project saqlandi', 'ok');
    return data.project;
  }, [run, pushToast]);

  const deleteProject = useCallback(async (id) => {
    const data = await run('Projectni o‘chirish', () => api(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    if (!data) return false;
    const remaining = projectsRef.current.filter((item) => item.id !== id);
    setProjects(remaining);
    if (projectRef.current === id) {
      const next = remaining.find((item) => item.id === 'general') || remaining[0];
      await selectProject(next?.id || 'general');
    }
    pushToast('Project o‘chirildi', 'ok');
    return true;
  }, [run, pushToast, selectProject]);

  /* ---------------- sessions ---------------- */

  const selectSession = useCallback(async (id) => {
    setActiveSessionId(id);
    sessionRef.current = id;
    setErrorState('');
    await loadMessages(projectRef.current, id);
  }, [loadMessages]);

  const createSession = useCallback(async (name = 'Yangi chat') => {
    const data = await run('Yangi chat', () => api(`/projects/${encodeURIComponent(projectRef.current)}/sessions`, { method: 'POST', body: { name } }));
    if (!data?.session) return undefined;
    setSessions((prev) => [...prev, data.session]);
    await selectSession(data.session.id);
    return data.session;
  }, [run, selectSession]);

  const renameSession = useCallback(async (id, name) => {
    const trimmed = String(name || '').trim();
    if (!trimmed) return false;
    const data = await run('Nomni saqlash', () => api(`/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name: trimmed } }));
    if (!data) return false;
    setSessions((prev) => prev.map((item) => (item.id === id ? { ...item, name: data.session?.name || trimmed } : item)));
    pushToast('Chat nomi yangilandi', 'ok');
    return true;
  }, [run, pushToast]);

  const deleteSession = useCallback(async (id) => {
    const data = await run('Chatni o‘chirish', () => api(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    if (!data) return false;
    const remaining = sessions.filter((item) => item.id !== id);
    setSessions(remaining);
    if (sessionRef.current === id) {
      const next = remaining[0]?.id;
      if (next) await selectSession(next);
      else {
        setMessages([]);
        setActiveSessionId('');
        sessionRef.current = '';
      }
    }
    return true;
  }, [run, sessions, selectSession]);

  /* ---------------- agent run (SSE) ---------------- */

  const stop = useCallback(async () => {
    const runId = runRef.current?.runId;
    runRef.current?.controller?.abort();
    if (runId) {
      try {
        await api('/agent/stop', { method: 'POST', body: { runId } });
      } catch {
        /* the closed SSE connection already aborts the run server-side */
      }
    }
  }, []);

  const sendMessage = useCallback(async (text, overrides = {}) => {
    const prompt = String(text || '').trim();
    if (!prompt) return undefined;
    if (runRef.current) {
      pushToast('Avvalgi javob hali tugamadi. Stop tugmasini bosing.', 'warn');
      return undefined;
    }
    if (health && health?.ollama && health.ollama.connected === false) {
      pushToast('Ollama ulanmagan. Settings → Start Ollama bilan ishga tushiring.', 'warn');
    }

    const projectId = overrides.projectId || projectRef.current || activeProjectId;
    const sessionId = overrides.sessionId || sessionRef.current || '';
    const usedModel = overrides.model || modelRef.current || settings.model || '';
    const usedMode = overrides.mode || modeRef.current || 'auto';
    const controller = new AbortController();
    runRef.current = { controller, runId: '' };
    setBusy(true);
    setErrorState('');

    const optimistic = {
      id: tempId('temp_user'),
      role: 'user',
      content: prompt,
      createdAt: new Date().toISOString(),
      pending: true,
    };
    const draftId = tempId('temp_assistant');
    const draft = {
      id: draftId,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      model: usedModel,
      streaming: true,
      steps: 0,
      tools: [],
      pending: true,
    };
    setMessages((prev) => [...prev, optimistic, draft]);

    const patchDraft = (patch) => {
      setMessages((prev) => prev.map((item) => (item.id === draftId ? { ...item, ...patch } : item)));
    };
    const addToolEvent = (event) => {
      setMessages((prev) => prev.map((item) => {
        if (item.id !== draftId) return item;
        const tools = Array.isArray(item.tools) ? [...item.tools] : [];
        if (event.type === 'tool_start') {
          tools.push({ id: event.id || tempId('tool'), name: event.name, title: event.title, args: event.args, running: true });
        } else {
          const index = tools.findIndex((tool) => tool.id === event.id);
          const next = {
            ...(index >= 0 ? tools[index] : { id: event.id || tempId('tool'), name: event.name }),
            name: event.name || tools[index]?.name,
            ok: event.ok !== false,
            summary: event.summary,
            contentPreview: event.contentPreview,
            durationMs: event.durationMs,
            running: false,
          };
          if (index >= 0) tools[index] = next;
          else tools.push(next);
        }
        return { ...item, tools };
      }));
    };

    const result = await streamChat(
      { projectId, sessionId: sessionId || undefined, message: prompt, model: usedModel || undefined, mode: usedMode },
      {
        run_start: (event) => {
          if (runRef.current) runRef.current.runId = event.runId || '';
          patchDraft({ runId: event.runId, model: event.model || usedModel });
        },
        step: (event) => patchDraft({ steps: Number.isFinite(event.index) ? event.index : (event.steps || 0), model: event.model || usedModel }),
        token: (event) => {
          const delta = typeof event.text === 'string' ? event.text : '';
          if (!delta) return;
          setMessages((prev) => prev.map((item) => (item.id === draftId ? { ...item, content: `${item.content || ''}${delta}` } : item)));
        },
        tool_start: addToolEvent,
        tool_end: addToolEvent,
        permission_request: (event) => setApprovals((prev) => [...prev, event]),
        permission_resolved: (event) => {
          setApprovals((prev) => prev.filter((item) => item.id !== event.id));
          setMessages((prev) => prev.map((item) => (
            item.id === draftId
              ? { ...item, permissions: [...(item.permissions || []), { id: event.id, approved: event.approved, decision: event.decision }] }
              : item
          )));
        },
        summary: (event) => patchDraft({ summary: event.summary || event.text || '' }),
        notice: (event) => {
          const text = event.message || event.text || '';
          if (text) pushToast(text, 'warn');
        },
        done: (event) => {
          setMessages((prev) => prev.map((item) => {
            if (item.id !== draftId) return item;
            return {
              ...item,
              id: event.messageId || item.id,
              content: typeof event.content === 'string' && event.content ? event.content : item.content,
              steps: event.steps ?? item.steps,
              model: event.model || item.model,
              durationMs: event.durationMs,
              stopped: Boolean(event.stopped),
              streaming: false,
              pending: false,
              error: undefined,
            };
          }));
        },
        error: (event) => {
          const text = event.message || 'Agent xatosi';
          setErrorState(text);
          pushToast(text, 'error');
          patchDraft({ error: text, streaming: false, pending: false });
        },
        onClose: ({ aborted }) => {
          setMessages((prev) => prev.map((item) => (
            item.id === draftId || item.id === optimistic.id
              ? { ...item, streaming: false, pending: false, stopped: aborted || item.stopped }
              : item
          )));
        },
      },
      { signal: controller.signal },
    );

    setMessages((prev) => prev.map((item) => {
      if (item.id === draftId && !item.content && !item.error && !(item.tools || []).length) {
        return { ...item, content: 'Model bo‘sh javob qaytardi. Boshqa model yoki mode bilan urinib ko‘ring.', error: undefined };
      }
      return item.id === draftId ? { ...item, streaming: false, pending: false } : item;
    }));
    if (result?.error) setErrorState(result.error);
    if (result?.aborted) pushToast('Javob to‘xtatildi', 'warn');

    setBusy(false);
    runRef.current = null;
    setApprovals([]);
    const project = projectsRef.current.find((item) => item.id === projectId);
    if (project) {
      setProjects((prev) => prev.map((item) => (item.id === projectId ? { ...item, messageCount: (item.messageCount || 0) + 2, updatedAt: new Date().toISOString() } : item)));
    }
    loadSessionList(projectId);
    return result;
  }, [activeProjectId, health, settings.model, pushToast, loadSessionList]);

  const resolvePermission = useCallback(async (request, decision) => {
    const id = request?.id;
    if (!id) return;
    setApprovals((prev) => prev.filter((item) => item.id !== id));
    try {
      await api(`/agent/permission/${encodeURIComponent(id)}`, { method: 'POST', body: { approved: decision.approved, remember: decision.remember } });
      setMessages((prev) => prev.map((item) => (
        item.streaming
          ? { ...item, permissions: [...(item.permissions || []), { id, approved: decision.approved, decision: decision.remember }] }
          : item
      )));
    } catch (err) {
      pushToast(`Ruxsat yuborilmadi: ${errorText(err)}`, 'error');
    }
  }, [pushToast]);

  /* ---------------- tools / mcp / plugins / skills / memories ---------------- */

  const setToolPolicy = useCallback(async (name, policy) => {
    const data = await run('Tool policy', () => api(`/tools/${encodeURIComponent(name)}`, { method: 'PATCH', body: { policy } }));
    if (!data) return false;
    setTools((prev) => prev.map((item) => (item.name === name ? { ...item, policy: data.tool?.policy || policy } : item)));
    return true;
  }, [run]);

  const saveMcpServer = useCallback(async (fields, id) => {
    const data = await run('MCP server', () => (
      id
        ? api(`/mcp/servers/${encodeURIComponent(id)}`, { method: 'PATCH', body: fields })
        : api('/mcp/servers', { method: 'POST', body: fields })
    ));
    if (!data) return undefined;
    await refreshMcp();
    pushToast(id ? 'MCP server yangilandi' : 'MCP server qo‘shildi', 'ok');
    return data.server;
  }, [run, refreshMcp, pushToast]);

  const deleteMcpServer = useCallback(async (id) => {
    const data = await run('MCP serverni o‘chirish', () => api(`/mcp/servers/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    if (!data) return false;
    setMcpServers((prev) => prev.filter((item) => item.id !== id));
    return true;
  }, [run]);

  const mcpAction = useCallback(async (id, action) => {
    const data = await run(`MCP ${action}`, () => api(`/mcp/servers/${encodeURIComponent(id)}/${action}`, { method: 'POST' }));
    await refreshMcp();
    return data;
  }, [run, refreshMcp]);

  const loadMcpTools = useCallback(async (id) => {
    try {
      const data = await api(`/mcp/servers/${encodeURIComponent(id)}/tools`);
      return Array.isArray(data?.tools) ? data.tools : [];
    } catch (err) {
      pushToast(`MCP tools: ${errorText(err)}`, 'error');
      return [];
    }
  }, [pushToast]);

  const togglePlugin = useCallback(async (id, enabled) => {
    const data = await run('Plaginni almashtirish', () => api(`/plugins/${encodeURIComponent(id)}/toggle`, { method: 'POST', body: { enabled } }));
    if (!data) return false;
    setPlugins(Array.isArray(data.plugins) ? data.plugins : []);
    return true;
  }, [run]);

  const reloadPlugins = useCallback(async () => {
    const data = await run('Plaginni qayta yuklash', () => api('/plugins/reload', { method: 'POST' }));
    if (!data) return false;
    setPlugins(Array.isArray(data.plugins) ? data.plugins : []);
    pushToast('Plaginlar qayta yuklandi', 'ok');
    return true;
  }, [run, pushToast]);

  const saveSkill = useCallback(async (fields, id) => {
    const data = await run('Skill saqlash', () => (
      id
        ? api(`/skills/${encodeURIComponent(id)}`, { method: 'PATCH', body: fields })
        : api('/skills', { method: 'POST', body: fields })
    ));
    if (!data) return undefined;
    await refreshSkills();
    pushToast(id ? 'Skill yangilandi' : 'Skill yaratildi', 'ok');
    return data.skill;
  }, [run, refreshSkills, pushToast]);

  const deleteSkill = useCallback(async (id) => {
    const data = await run('Skillni o‘chirish', () => api(`/skills/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    if (!data) return false;
    setSkills((prev) => prev.filter((item) => item.id !== id));
    return true;
  }, [run]);

  const importSkill = useCallback(async (from) => {
    const data = await run('Skill import', () => api('/skills/import', { method: 'POST', body: { from } }));
    if (!data) return undefined;
    await refreshSkills();
    pushToast('Skill import qilindi', 'ok');
    return data.skill;
  }, [run, refreshSkills, pushToast]);

  const addMemory = useCallback(async (content) => {
    const data = await run('Memory saqlash', () => api('/memories', { method: 'POST', body: { content } }));
    if (!data) return undefined;
    await refreshMemories();
    pushToast('Memory saqlandi', 'ok');
    return data.memory;
  }, [run, refreshMemories, pushToast]);

  const deleteMemory = useCallback(async (id) => {
    const data = await run('Memoryni o‘chirish', () => api(`/memories/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    if (!data) return false;
    setMemories((prev) => prev.filter((item) => item.id !== id));
    return true;
  }, [run]);

  /* ---------------- ollama / system ---------------- */

  const fetchAutostart = useCallback(async () => {
    const value = await getOllamaAutostart();
    if (value === null) return null;
    setSettings((prev) => ({ ...prev, autostartOllama: value }));
    return value;
  }, []);

  const saveAutostart = useCallback(async (enabled) => {
    const value = await bridgeSetAutostart(enabled);
    if (value === null) {
      pushToast('Autostart faqat desktop ilovada mavjud', 'warn');
      return null;
    }
    setSettings((prev) => ({ ...prev, autostartOllama: value }));
    pushToast(value ? 'Windows autostart yoqildi' : 'Windows autostart o‘chirildi', 'ok');
    return value;
  }, [pushToast]);

  const startOllamaService = useCallback(async () => {
    const data = await run('Ollama start', () => api('/system/ollama/start', { method: 'POST' }));
    await refreshHealth();
    if (data?.ollama) setOllamaStatus(data.ollama);
    return data;
  }, [run, refreshHealth]);

  const value = useMemo(() => {
    const activeProject = projects.find((item) => item.id === activeProjectId) || null;
    const activeSession = sessions.find((item) => item.id === activeSessionId) || null;
    return {
      // data
      projects, activeProject, activeProjectId,
      sessions, activeSession, activeSessionId,
      messages, models, model, mode, health, tools, mcpServers, plugins, skills, memories, settings,
      // ui state
      busy, error, toasts, approvals, loading, ollamaStatus, backendStatus, bridgeDataDir,
      // actions
      refreshAll, refreshHealth, refreshModels, loadSettings, loadProjects, refreshTools,
      refreshMcp, refreshPlugins, refreshSkills, refreshMemories, loadMessages, loadSessionList,
      selectProject, createProject, updateProject, deleteProject,
      selectSession, createSession, renameSession, deleteSession,
      selectModel, selectMode, patchSettings, sendMessage, stop, resolvePermission,
      setToolPolicy, saveMcpServer, deleteMcpServer, mcpAction, loadMcpTools,
      togglePlugin, reloadPlugins, saveSkill, deleteSkill, importSkill,
      addMemory, deleteMemory, fetchAutostart, saveAutostart, startOllamaService,
      pushToast, dismissToast, setError, clearError,
    };
  }, [
    projects, activeProjectId, sessions, activeSessionId, messages, models, model, mode, health, tools,
    mcpServers, plugins, skills, memories, settings, busy, error, toasts, approvals, loading,
    ollamaStatus, backendStatus, bridgeDataDir, refreshAll, refreshHealth, refreshModels, loadSettings,
    loadProjects, refreshTools, refreshMcp, refreshPlugins, refreshSkills, refreshMemories, loadMessages,
    loadSessionList, selectProject, createProject, updateProject, deleteProject, selectSession,
    createSession, renameSession, deleteSession, selectModel, selectMode, patchSettings, sendMessage,
    stop, resolvePermission, setToolPolicy, saveMcpServer, deleteMcpServer, mcpAction, loadMcpTools,
    togglePlugin, reloadPlugins, saveSkill, deleteSkill, importSkill, addMemory, deleteMemory,
    fetchAutostart, saveAutostart, startOllamaService, pushToast, dismissToast, setError, clearError,
  ]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp faqat AppProvider ichida ishlaydi');
  return context;
}
