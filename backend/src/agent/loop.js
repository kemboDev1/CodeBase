import { config } from '../config.js';
import * as ollama from '../ollama/client.js';
import { buildSystemPrompt } from '../ollama/prompts.js';
import { detectLanguage, greetingReply } from '../lib/lang.js';
import { estimateTokens, oneLine, truncate, digest } from '../lib/text.js';
import { makeId, saveStore } from '../store.js';
import { logger } from '../lib/logger.js';

const log = logger.make('agent');

const MAX_TOOL_CONTENT = 8_000;
const MAX_TOTAL_TOOL_CHARS = 24_000;

/** Pull `tool_call` fenced blocks out of a plain-text answer (fallback protocol). */
export function parseTextToolCalls(content) {
  const calls = [];
  const pattern = /```tool_call\s*([\s\S]*?)```/gi;
  let match = pattern.exec(String(content || ''));
  while (match) {
    const raw = match[1].trim().replace(/^```|```$/g, '');
    try {
      const parsed = JSON.parse(raw);
      const name = String(parsed?.name || parsed?.tool || '').trim();
      if (name) {
        calls.push({
          id: `text_${calls.length}_${Math.random().toString(36).slice(2, 7)}`,
          name,
          arguments: parsed.arguments || parsed.args || {}
        });
      }
    } catch {
      log.debug(`tool_call bloki JSON emas: ${raw.slice(0, 120)}`);
    }
    match = pattern.exec(content);
  }
  return calls;
}

/** Remove tool_call blocks from the visible answer. */
export function stripToolCalls(content) {
  return String(content || '').replace(/```tool_call\s*[\s\S]*?```/gi, '').trim();
}

function historyToMessages(session, budgetTokens) {
  const history = [];
  let used = 0;
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!['user', 'assistant'].includes(message.role)) continue;
    if (typeof message.content !== 'string' || !message.content.trim()) continue;
    const content = truncate(message.content, 6_000, '\n… [oldingi xabar qisqartirildi]');
    const cost = estimateTokens(content) + 8;
    if (used + cost > budgetTokens) break;
    history.unshift({ role: message.role, content });
    used += cost;
  }
  return { history, used };
}

function memoryText(store) {
  return (store.memories || [])
    .slice(0, 25)
    .map((item) => `- ${String(item.content).slice(0, 500)}`)
    .join('\n')
    .slice(0, 6_000);
}

function skillsSummary(skills) {
  return (skills || [])
    .filter((skill) => skill.enabled !== false)
    .slice(0, 40)
    .map((skill) => `- ${skill.name}: ${skill.description || ''}${skill.whenToUse ? ` (qachon: ${skill.whenToUse})` : ''}`)
    .join('\n')
    .slice(0, 4_000);
}

/**
 * Optional context compression: fold older turns into `session.summary` with the
 * fast model so long chats keep fitting inside the local context window.
 */
async function maybeSummarize({ session, store, fastModel, signal, emit }) {
  if (store.settings?.summarize === false) return session.summary || '';
  const messages = session.messages || [];
  if (messages.length < 12) return session.summary || '';

  const older = messages.slice(0, messages.length - 6);
  const tokens = older.reduce((sum, message) => sum + estimateTokens(message.content || ''), 0);
  if (tokens < 2_500) return session.summary || '';

  try {
    const transcript = older
      .map((message) => `${message.role.toUpperCase()}: ${truncate(message.content || '', 1_200)}`)
      .join('\n');
    const summary = await ollama.generate({
      model: fastModel,
      system: 'You compress coding conversations. Keep facts, decisions, file paths, commands, errors and open tasks. Drop greetings and repetition. Write in the user’s language, max 200 words.',
      prompt: `${session.summary ? `Previous summary:\n${session.summary}\n\n` : ''}Conversation to compress:\n${transcript}`,
      signal
    });
    if (summary) {
      session.summary = summary.slice(0, 4_000);
      if (typeof emit === 'function') emit({ type: 'summary', text: session.summary });
    }
  } catch (error) {
    log.debug(`Summarizatsiya o‘tkazib yuborildi: ${error.message}`);
  }
  return session.summary || '';
}

/**
 * Main agentic loop: stream an answer, execute tool calls with permission checks,
 * feed results back to the model, repeat until the model answers or steps run out.
 */
export async function runAgent({
  prompt,
  project,
  session,
  model,
  mode = 'auto',
  signal,
  emit = () => {},
  registry,
  permissions,
  store,
  skills = [],
  config: runtimeConfig = config,
  workspaceRoot = null,
  runId: providedRunId = ''
}) {
  const started = Date.now();
  const runId = providedRunId || makeId('run');
  const language = detectLanguage(prompt);
  const startedWithGreeting = greetingReply(prompt, language);

  const sse = (payload) => {
    try {
      emit({ runId, ...payload });
    } catch (error) {
      log.debug(`emit xatosi: ${error.message}`);
    }
  };

  const roots = workspaceRoot ? [workspaceRoot, ...(runtimeConfig.workspaceRoots || [])] : runtimeConfig.workspaceRoots || [];

  // ── instant local reply for a bare greeting ────────────────────────────────
  if (startedWithGreeting) {
    const now = new Date().toISOString();
    const userMessage = { id: makeId('msg'), role: 'user', content: prompt, createdAt: now };
    const assistantMessage = {
      id: makeId('msg'), role: 'assistant', content: startedWithGreeting, createdAt: now,
      model: 'local', steps: 0, durationMs: 0, toolCalls: []
    };
    session.messages.push(userMessage, assistantMessage);
    session.updatedAt = now;
    project.updatedAt = now;
    await saveStore();
    sse({ type: 'run_start', model, mode, language: language.name });
    sse({ type: 'token', text: startedWithGreeting });
    sse({
      type: 'done', messageId: assistantMessage.id, sessionId: session.id, content: startedWithGreeting,
      steps: 0, model: 'local', durationMs: Date.now() - started, stopped: false, language: language.name
    });
    return { content: startedWithGreeting, steps: 0, model: 'local', stopped: false, toolCalls: [], runId };
  }

  const useTools = mode !== 'fast';
  const selectedModel = mode === 'fast' ? runtimeConfig.fastModel || model : model;
  const maxSteps = Math.max(1, Math.min(40, mode === 'deep' ? (runtimeConfig.maxSteps || 8) * 2 : runtimeConfig.maxSteps || 8));

  sse({ type: 'run_start', model: selectedModel, mode, language: language.name, roots });

  const ctx = {
    runId,
    sessionId: session.id,
    projectId: project.id,
    projectRoot: workspaceRoot || project.root || roots[0] || null,
    roots,
    permissions,
    registry,
    store,
    logger: logger.make('tool'),
    signal,
    emit: sse,
    config: runtimeConfig,
    skills
  };

  const nativeToolsSupported = useTools && ollama.supportsTools(selectedModel);
  let protocol = nativeToolsSupported ? 'native' : 'text';

  let toolNames = [];
  let ollamaTools = [];
  if (useTools) {
    ollamaTools = registry.toOllamaTools();
    toolNames = ollamaTools.map((tool) => tool.function.name);
    if (protocol === 'text') toolNames = registry.names();
  }
  log.debug(`Run ${runId}: ${ollamaTools.length} tool, protocol=${protocol}, model=${selectedModel}`);

  await maybeSummarize({ session, store, fastModel: runtimeConfig.fastModel || model, signal, emit: sse });
  log.debug(`Run ${runId}: kontekst tayyor (${session.messages.length} xabar, aborted=${Boolean(signal?.aborted)})`);
  const budgetTokens = Math.max(1_200, Math.floor((runtimeConfig.numCtx || 8192) * 0.5));
  const { history } = historyToMessages(session, budgetTokens);

  const systemPrompt = buildSystemPrompt({
    language,
    project,
    memoryText: memoryText(store),
    skillsSummary: skillsSummary(skills),
    roots,
    toolNames,
    protocol,
    mode
  });

  const messages = [{ role: 'system', content: systemPrompt }];
  if (session.summary) messages.push({ role: 'system', content: `OLDER CONVERSATION SUMMARY:\n${session.summary}` });
  messages.push(...history);
  messages.push({ role: 'user', content: prompt });

  const executed = [];
  let finalContent = '';
  let steps = 0;
  let stopped = false;
  let toolChars = 0;
  let lastError = '';

  for (let step = 0; step < maxSteps; step += 1) {
    if (signal?.aborted) {
      stopped = true;
      break;
    }
    steps = step + 1;
    sse({ type: 'step', index: steps, model: selectedModel, protocol });
    log.debug(`Run ${runId}: qadam ${steps}/${maxSteps} → ${selectedModel} (${protocol}, ${messages.length} xabar)`);

    let result;
    try {
      result = await ollama.chat({
        model: selectedModel,
        messages,
        tools: protocol === 'native' ? ollamaTools : undefined,
        stream: runtimeConfig.stream !== false,
        signal,
        keepAlive: '30m',
        options: {
          temperature: runtimeConfig.temperature,
          num_ctx: runtimeConfig.numCtx,
          num_predict: mode === 'deep' ? 4096 : 2048
        },
        onToken: (text) => sse({ type: 'token', text })
      });
    } catch (error) {
      if (error.code === 'tools_unsupported' && protocol === 'native') {
        log.warn('Model native tool callingni qo‘llamaydi — matnli tool protokoliga o‘tildi.');
        protocol = 'text';
        messages[0] = {
          role: 'system',
          content: buildSystemPrompt({
            language, project, memoryText: memoryText(store), skillsSummary: skillsSummary(skills),
            roots, toolNames: registry.names(), protocol: 'text', mode
          })
        };
        step -= 1;
        continue;
      }
      if (error.name === 'AbortError' || signal?.aborted) {
        stopped = true;
        break;
      }
      lastError = error.message;
      sse({ type: 'error', message: error.message, code: error.code });
      break;
    }

    const calls = protocol === 'native'
      ? (result.toolCalls || [])
      : parseTextToolCalls(result.content);
    log.debug(
      `Run ${runId}: model javobi ${result.content.length} belgi, ${calls.length} tool call` +
        (calls.length ? ` (${calls.map((call) => call.name).join(', ')})` : '')
    );

    if (!calls.length) {
      finalContent = protocol === 'native' ? result.content : stripToolCalls(result.content);
      break;
    }

    // Register the assistant turn that requested the tools.
    const assistantTurn = protocol === 'native'
      ? {
          role: 'assistant',
          content: result.content || '',
          tool_calls: calls.map((call) => ({ function: { name: call.name, arguments: call.arguments } }))
        }
      : { role: 'assistant', content: result.content };
    messages.push(assistantTurn);

    for (const call of calls) {
      if (signal?.aborted) {
        stopped = true;
        break;
      }
      const tool = registry.get(call.name);
      const title = tool?.title || call.name;
      sse({ type: 'tool_start', id: call.id, name: call.name, title, args: call.arguments });

      const output = await registry.execute(call.name, call.arguments, ctx);
      const payload = truncate(output.content || output.error || '', MAX_TOOL_CONTENT);
      toolChars += payload.length;

      executed.push({
        id: call.id,
        name: call.name,
        title,
        args: call.arguments,
        ok: output.ok !== false,
        summary: output.summary || output.error || '',
        durationMs: output.ms || 0,
        content: truncate(output.content || output.error || '', 2_000)
      });

      sse({
        type: 'tool_end',
        id: call.id,
        name: call.name,
        title,
        ok: output.ok !== false,
        summary: oneLine(output.summary || output.error || '', 240),
        durationMs: output.ms || 0,
        contentPreview: truncate(output.content || output.error || '', 1_200)
      });

      const body = toolChars > MAX_TOTAL_TOOL_CHARS
        ? 'TOOL RESULT (qisqartirildi): kontekst to‘ldi, keyingi qadamda javob bering.'
        : `TOOL RESULT for ${call.name} (${output.ok === false ? 'FAILED' : 'OK'}):\n${payload}`;

      if (protocol === 'native') {
        messages.push({ role: 'tool', tool_name: call.name, content: body });
      } else {
        messages.push({ role: 'user', content: body });
      }
    }

    if (stopped) break;
    if (toolChars > MAX_TOTAL_TOOL_CHARS * 2) {
      messages.push({ role: 'user', content: 'Kontekst to‘ldi. Hozir mavjud ma’lumot asosida yakuniy javobni ber.' });
    }
  }

  if (!finalContent && !stopped) {
    if (lastError) {
      finalContent = `Xatolik yuz berdi: ${lastError}`;
    } else {
      // Ask once more for a plain answer when the step budget ran out mid-tools.
      try {
        const closing = await ollama.chat({
          model: selectedModel,
          messages: [...messages, { role: 'user', content: 'Endi faqat yakuniy javobni yoz: nima qildim, nima topdim, keyingi qadam nima.' }],
          stream: false,
          signal,
          options: { temperature: runtimeConfig.temperature, num_ctx: runtimeConfig.numCtx, num_predict: 1024 }
        });
        finalContent = stripToolCalls(closing.content) || closing.content || '';
      } catch (error) {
        finalContent = `Javobni yakunlab bo‘lmadi: ${error.message}`;
      }
    }
  }
  if (stopped && !finalContent) finalContent = '_To‘xtatildi._';

  const now = new Date().toISOString();
  const userMessage = { id: makeId('msg'), role: 'user', content: prompt, createdAt: now };
  const assistantMessage = {
    id: makeId('msg'),
    role: 'assistant',
    content: finalContent,
    createdAt: now,
    model: selectedModel,
    steps,
    durationMs: Date.now() - started,
    stopped,
    toolCalls: executed
  };
  session.messages.push(userMessage, assistantMessage);
  session.updatedAt = now;
  project.updatedAt = now;
  if (session.messages.length > 400) session.messages.splice(0, session.messages.length - 400);
  await saveStore();

  sse({
    type: 'done',
    runId,
    messageId: assistantMessage.id,
    sessionId: session.id,
    content: finalContent,
    steps,
    model: selectedModel,
    durationMs: assistantMessage.durationMs,
    stopped,
    toolCalls: executed.map((call) => ({ ...call, content: undefined })),
    digest: digest(finalContent).slice(0, 8)
  });

  return {
    content: finalContent,
    steps,
    model: selectedModel,
    stopped,
    toolCalls: executed,
    runId,
    messageId: assistantMessage.id
  };
}

export default runAgent;
