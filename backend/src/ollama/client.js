import config from '../config.js';
import { logger } from '../lib/logger.js';
import { AppError, upstream } from '../lib/errors.js';
import { safeJsonParse } from '../lib/text.js';

const log = logger.make('ollama');

let ollamaUrl = config.ollamaUrl;

export function setOllamaUrl(url) {
  ollamaUrl = String(url || '').trim().replace(/\/+$/, '') || config.ollamaUrl;
  return ollamaUrl;
}

export function getOllamaUrl() {
  return ollamaUrl;
}

/** Models that are known to expose native function/tool calling in Ollama. */
const TOOL_CAPABLE = /(qwen2\.5|qwen3|qwen2|llama3\.[1-9]|llama4|mistral|devstral|magistral|granite|cogito|command-r|firefunction|hermes3|nemotron)/i;

export function supportsTools(model) {
  return TOOL_CAPABLE.test(String(model || ''));
}

function buildSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || config.requestTimeoutMs));
  if (!signal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  return signal;
}

async function request(endpoint, { method = 'GET', body, signal, timeoutMs, accept = 'application/json' } = {}) {
  const url = `${ollamaUrl}${endpoint}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { Accept: accept, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: buildSignal(signal, timeoutMs)
    });
  } catch (error) {
    if (error.name === 'AbortError' && signal?.aborted) {
      const abort = new Error('So‘rov bekor qilindi.');
      abort.name = 'AbortError';
      throw abort;
    }
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new AppError('Ollama javobi juda kechikdi. Model ishlayotganini tekshiring.', 504, 'ollama_timeout');
    }
    throw new AppError(
      `Ollama bilan bog‘lanib bo‘lmadi (${ollamaUrl}). Ollama ishlayotganini tekshiring.`,
      503,
      'ollama_unreachable'
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const message = `Ollama ${response.status}${detail ? `: ${detail.slice(0, 400)}` : ''}`;
    const error = upstream(message, 'ollama_error');
    error.status = response.status === 404 ? 404 : 502;
    error.detail = detail;
    if (response.status === 400 && /tools?|function/i.test(detail)) error.code = 'tools_unsupported';
    throw error;
  }
  return response;
}

export async function listModels() {
  const response = await request('/api/tags', { timeoutMs: 10_000 });
  const data = await response.json().catch(() => ({}));
  return (data.models || []).map((model) => ({
    name: model.name,
    size: model.size,
    modifiedAt: model.modified_at,
    family: model.details?.family,
    parameters: model.details?.parameter_size,
    tools: supportsTools(model.name)
  }));
}

export async function health() {
  try {
    const models = await listModels();
    return { connected: true, models, url: ollamaUrl };
  } catch (error) {
    return { connected: false, models: [], url: ollamaUrl, error: error.message, code: error.code };
  }
}

export async function version() {
  try {
    const response = await request('/api/version', { timeoutMs: 5_000 });
    const data = await response.json().catch(() => ({}));
    return data.version || '';
  } catch {
    return '';
  }
}

function normalizeToolCalls(raw, index = 0) {
  const calls = Array.isArray(raw) ? raw : [];
  return calls
    .map((call, i) => {
      const fn = call?.function || {};
      const name = String(fn.name || call?.name || '').trim();
      if (!name) return null;
      const args = typeof fn.arguments === 'string' ? safeJsonParse(fn.arguments, {}) : fn.arguments || {};
      return {
        id: String(call?.id || `call_${index}_${i}_${Math.random().toString(36).slice(2, 7)}`),
        name,
        arguments: args && typeof args === 'object' ? args : {}
      };
    })
    .filter(Boolean);
}

/**
 * Chat with an Ollama model. Supports streaming, tool calling, abort and thinking suppression.
 * @returns {Promise<{content:string, toolCalls:Array, model:string, promptTokens:number, evalTokens:number, doneReason:string}>}
 */
export async function chat({
  model,
  messages,
  tools,
  options = {},
  stream = true,
  signal,
  onToken,
  onThinking,
  keepAlive = '30m',
  timeoutMs
} = {}) {
  if (!model) throw new AppError('Model tanlanmagan.', 400, 'no_model');
  const payload = {
    model,
    messages,
    stream: Boolean(stream),
    keep_alive: keepAlive,
    options: {
      temperature: options.temperature ?? config.temperature,
      top_p: options.top_p ?? 0.9,
      repeat_penalty: options.repeat_penalty ?? 1.05,
      num_ctx: options.num_ctx ?? config.numCtx,
      num_predict: options.num_predict ?? 2048,
      ...options
    }
  };
  if (Array.isArray(tools) && tools.length) payload.tools = tools;

  const response = await request('/api/chat', { method: 'POST', body: payload, signal, timeoutMs });

  if (!payload.stream) {
    const data = await response.json().catch(() => ({}));
    const message = data.message || {};
    const content = String(message.content || '');
    if (message.thinking && onThinking) onThinking(String(message.thinking));
    return {
      content,
      toolCalls: normalizeToolCalls(message.tool_calls),
      model: data.model || model,
      promptTokens: data.prompt_eval_count || 0,
      evalTokens: data.eval_count || 0,
      doneReason: data.done_reason || 'stop'
    };
  }

  if (!response.body) throw new AppError('Ollama stream bo‘sh qaytdi.', 502, 'ollama_empty_stream');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let thinking = '';
  let toolCalls = [];
  let evalTokens = 0;
  let promptTokens = 0;
  let doneReason = 'stop';
  let modelName = model;

  const handleChunk = (chunk) => {
    if (chunk.error) throw new AppError(`Ollama: ${chunk.error}`, 502, 'ollama_error');
    const message = chunk.message || {};
    if (typeof message.content === 'string' && message.content) {
      content += message.content;
      if (onToken) onToken(message.content);
    }
    if (typeof message.thinking === 'string' && message.thinking) {
      thinking += message.thinking;
      if (onThinking) onThinking(message.thinking);
    }
    if (message.tool_calls) toolCalls = toolCalls.concat(normalizeToolCalls(message.tool_calls, toolCalls.length));
    if (chunk.model) modelName = chunk.model;
    if (chunk.done) {
      evalTokens = chunk.eval_count || evalTokens;
      promptTokens = chunk.prompt_eval_count || promptTokens;
      doneReason = chunk.done_reason || doneReason;
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) handleChunk(safeJsonParse(line, {}));
        newline = buffer.indexOf('\n');
      }
    }
    const rest = buffer.trim();
    if (rest) handleChunk(safeJsonParse(rest, {}));
  } catch (error) {
    if (error.name === 'AbortError') {
      logger.debug('Stream bekor qilindi (abort).');
    } else {
      throw error;
    }
  } finally {
    try { reader.cancel(); } catch { /* stream already closed */ }
  }

  return { content, thinking, toolCalls, model: modelName, promptTokens, evalTokens, doneReason };
}

/** Single-shot generation used for titles and summaries. */
export async function generate({ model, prompt, system, options = {}, signal, timeoutMs } = {}) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: String(prompt || '') });
  const result = await chat({
    model,
    messages,
    options: { temperature: options.temperature ?? 0.1, num_predict: options.num_predict ?? 256, ...options },
    stream: false,
    signal,
    timeoutMs,
    keepAlive: '5m'
  });
  return result.content.trim();
}

export default { chat, generate, listModels, health, version, supportsTools, setOllamaUrl, getOllamaUrl };
