import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // backend/src

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const list = (value) =>
  String(value || '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean);

const dataDir = process.env.CODEBASE_DATA_DIR
  ? path.resolve(process.env.CODEBASE_DATA_DIR)
  : path.resolve(here, '..', 'data');

/**
 * Runtime configuration. Values here are defaults coming from the environment;
 * the user store can override a subset at runtime through `setRuntimeSettings`.
 */
export const config = {
  version: process.env.CODEBASE_VERSION || '1.0.0',
  port: num(process.env.CODEBASE_PORT, 3030),
  host: process.env.CODEBASE_HOST || '127.0.0.1',
  token: process.env.CODEBASE_TOKEN || '',
  allowAnon: process.env.CODEBASE_ALLOW_ANON === '1',
  dataDir,
  webDir: process.env.CODEBASE_WEB_DIR ? path.resolve(process.env.CODEBASE_WEB_DIR) : '',
  ollamaUrl: (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
  defaultModel: process.env.DEFAULT_MODEL || 'qwen2.5-coder:7b',
  fastModel: process.env.FAST_MODEL || 'qwen3:4b',
  numCtx: num(process.env.NUM_CTX, 8192),
  maxSteps: num(process.env.MAX_STEPS, 8),
  temperature: 0.2,
  requestTimeoutMs: num(process.env.REQUEST_TIMEOUT_MS, 300_000),
  ollamaProbeMs: num(process.env.OLLAMA_PROBE_MS, 2_500),
  shellTimeoutMs: num(process.env.SHELL_TIMEOUT_MS, 120_000),
  maxOutputBytes: num(process.env.MAX_OUTPUT_BYTES, 200_000),
  workspaceRoots: list(process.env.WORKSPACE_ROOTS),
  pluginsDir: process.env.CODEBASE_PLUGINS_DIR
    ? path.resolve(process.env.CODEBASE_PLUGINS_DIR)
    : path.join(dataDir, 'plugins'),
  skillsDir: process.env.CODEBASE_SKILLS_DIR
    ? path.resolve(process.env.CODEBASE_SKILLS_DIR)
    : path.join(dataDir, 'skills'),
  logLevel: process.env.CODEBASE_LOG || 'info',
  maxMcpServers: num(process.env.MAX_MCP_SERVERS, 12),
  maxToolSteps: num(process.env.MAX_TOOL_STEPS, 12),
  startedAt: Date.now()
};

let onSettingsApplied = () => {};

/** Register a callback fired whenever runtime settings change (used to refresh roots). */
export function onRuntimeSettings(fn) {
  onSettingsApplied = typeof fn === 'function' ? fn : () => {};
}

/**
 * Apply the persisted user settings on top of the environment defaults.
 * @param {{model?:string, fastModel?:string, numCtx?:number, temperature?:number, maxSteps?:number,
 *          ollamaUrl?:string, workspaceRoots?:string[]}} settings
 */
export function setRuntimeSettings(settings = {}) {
  if (settings.model) config.defaultModel = String(settings.model).slice(0, 150);
  if (settings.fastModel) config.fastModel = String(settings.fastModel).slice(0, 150);
  if (Number.isFinite(Number(settings.numCtx))) config.numCtx = Math.min(131_072, Math.max(1024, Number(settings.numCtx)));
  if (Number.isFinite(Number(settings.temperature))) config.temperature = Math.min(2, Math.max(0, Number(settings.temperature)));
  if (Number.isFinite(Number(settings.maxSteps))) config.maxSteps = Math.min(40, Math.max(1, Number(settings.maxSteps)));
  if (settings.ollamaUrl) config.ollamaUrl = String(settings.ollamaUrl).trim().replace(/\/+$/, '');
  if (Array.isArray(settings.workspaceRoots)) config.workspaceRoots = settings.workspaceRoots.filter(Boolean).map((p) => path.resolve(p));
  onSettingsApplied(config);
  return config;
}

export default config;
