import { config } from '../config.js';
import * as ollama from '../ollama/client.js';
import { buildSystemPrompt } from '../ollama/prompts.js';
import { detectLanguage, greetingReply } from '../lib/lang.js';
import { estimateTokens, oneLine, truncate, digest, safeJsonParse } from '../lib/text.js';
import { makeId, saveStore } from '../store.js';
import { logger } from '../lib/logger.js';

const log = logger.make('agent');

const MAX_TOOL_CONTENT = 8_000;
const MAX_TOTAL_TOOL_CHARS = 24_000;

const WRITE_TOOLS = new Set(['fs.write', 'fs.patch', 'fs.append', 'fs.delete', 'fs.move', 'fs.mkdir']);
const CHANGE_REQUEST = /(tuzat|o‘zgartir|o'zgartir|yoz|yarat|qo‘sh|qo'sh|o‘chir|refactor|rename|fix|change|update|create|write|add|remove|delete|move|patch)/i;
// Deliberately stem-based: small models write "tuzatdim", "tuzatildi", "tuzatish kerak" …
// any of those means "I am talking about a change", and if no write tool ran we re-ask.
const CHANGE_CLAIM = /(tuzat|o‘zgartir|o'zgartir|yoz|yarat|qo‘sh|qo'sh|o‘chir|saqla|fixed|updated|created|written|modified|patched|applied|renamed|deleted)/i;

const HONESTY_NUDGE = [
  'DIQQAT: oldingi javobingizda fayl o‘zgartirilganini aytdingiz, lekin bu suhbatda hech qanday yozish tool’i ishlamadi (fs.write / fs.patch / fs.append / fs.delete / fs.move).',
  'Agar vazifa haqiqatan faylni o‘zgartirishni talab qilsa, hozir tegishli tool’ni chaqirib, o‘zgarishni kiriting.',
  'Agar o‘zgarish kerak bo‘lmasa yoki fayl allaqachon to‘g‘ri bo‘lsa, buni aniq va qisqa qilib ayting.'
].join('\n');

/**
 * Extract every balanced JSON object from a string (string-aware brace matching).
 * A regex cannot do this reliably because tool arguments are nested objects.
 */
function extractJsonObjects(source) {
  const text = String(source || '');
  const found = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '{') {
      index += 1;
      continue;
    }
    let depth = 0;
    let inString = false;
    let escaped = false;
    let cursor = index;
    for (; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) break;
    const candidate = text.slice(index, cursor + 1);
    try {
      found.push({ value: JSON.parse(candidate), start: index, end: cursor + 1 });
    } catch {
      /* not JSON — ignore this object */
    }
    index = cursor + 1;
  }
  return found;
}

/** Turn one parsed JSON value into zero or more tool calls. */
function callsFromValue(value) {
  if (Array.isArray(value)) return value.flatMap((entry) => callsFromValue(entry));
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value.tool_calls)) return callsFromValue(value.tool_calls);
  if (Array.isArray(value.toolCalls)) return callsFromValue(value.toolCalls);

  const holder = value.function && typeof value.function === 'object' ? value.function : value;
  const name = holder.name ?? holder.tool ?? holder.tool_name ?? value.name ?? value.tool ?? value.tool_name;
  if (typeof name !== 'string' || !name.trim() || /\s/.test(name.trim())) return [];

  const rawArgs = holder.arguments ?? holder.args ?? holder.parameters ?? value.arguments ?? value.args ?? value.parameters;
  const args = typeof rawArgs === 'string' ? safeJsonParse(rawArgs, {}) : rawArgs;
  if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) return [];
  return [{ name: name.trim(), arguments: args || {} }];
}

/**
 * Parse tool calls out of plain model text.
 *
 * Local models are inconsistent: some emit fenced ```tool_call blocks, some emit bare
 * JSON objects/arrays, some wrap them in {"tool_calls":[...]}. All of those shapes are
 * accepted — but only when the prose around them is short, so JSON that merely appears
 * inside an explanation is never executed.
 *
 * @returns {{id:string,name:string,arguments:object}[]}
 */
export function parseTextToolCalls(content) {
  const text = String(content || '');
  if (!text.trim()) return [];
  const collected = [];

  // 1. Explicit fenced blocks (tool_call / json / tool / none).
  let masked = text;
  const fence = /```(\w*)\s*([\s\S]*?)```/g;
  let match = fence.exec(text);
  while (match) {
    for (const candidate of extractJsonObjects(match[2])) collected.push(...callsFromValue(candidate.value));
    // Blank the fenced region (same length, so offsets stay valid) so the bare scan
    // below cannot count the very same JSON twice.
    const start = match.index;
    const end = fence.lastIndex;
    masked = masked.slice(0, start) + ' '.repeat(end - start) + masked.slice(end);
    match = fence.exec(text);
  }

  // 2. Bare JSON in the message body.
  const objects = extractJsonObjects(masked);
  let remainder = masked;
  for (const object of [...objects].reverse()) {
    remainder = remainder.slice(0, object.start) + remainder.slice(object.end);
  }
  const prose = remainder.replace(/[\s`*_#>\-.,:;!?()[\]]/g, '');
  const bare = objects.flatMap((object) => callsFromValue(object.value));
  const acceptBare = bare.length > 0 && prose.length <= 160;
  if (acceptBare) collected.push(...bare);
  else if (!collected.length && bare.length > 0) {
    log.debug(`Matndagi JSON tool chaqiruvi rad etildi (atrofida ${prose.length} belgi matn bor).`);
  }

  return collected.map((call, index) => ({
    id: `text_${index}_${Math.random().toString(36).slice(2, 7)}`,
    name: call.name,
    arguments: call.arguments || {}
  }));
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
  let honestyChecked = false;

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

    // Local models are inconsistent: even with the tools interface available, some
    // answer with bare JSON. Accept both shapes.
    const nativeCalls = result.toolCalls || [];
    const textCalls = nativeCalls.length ? [] : parseTextToolCalls(result.content);
    const calls = nativeCalls.length ? nativeCalls : textCalls;
    const viaNative = nativeCalls.length > 0;
    log.debug(
      `Run ${runId}: model javobi ${result.content.length} belgi, ${calls.length} tool call` +
        (calls.length ? ` (${calls.map((call) => call.name).join(', ')}${viaNative ? '' : ' [matndan]'})` : '')
    );

    if (!calls.length) {
      const cleaned = stripToolCalls(result.content) || result.content;
      const wroteSomething = executed.some((call) => call.ok && WRITE_TOOLS.has(call.name));
      const claimsChange = CHANGE_CLAIM.test(cleaned);
      const askedForChange = CHANGE_REQUEST.test(prompt);

      // Anti-hallucination guard: a small model may claim it changed a file without
      // ever calling a write tool. Give it exactly one chance to actually do it.
      if (!honestyChecked && !wroteSomething && claimsChange && askedForChange && steps < maxSteps && !stopped) {
        honestyChecked = true;
        log.warn(`Run ${runId}: model o‘zgarish haqida yozdi, lekin yozish tool’i ishlamadi — tekshiruv qadami qo‘shildi.`);
        sse({ type: 'notice', message: 'Model o‘zgarishni yozmagan — qayta tekshirilmoqda.' });
        messages.push({ role: 'assistant', content: result.content });
        messages.push({ role: 'user', content: HONESTY_NUDGE });
        continue;
      }

      // The model ignored the first nudge and still claims a change it never made:
      // keep the answer but mark it clearly so the user is never misled.
      if (honestyChecked && !wroteSomething && claimsChange && askedForChange) {
        log.warn(`Run ${runId}: model yozish amalisiz o‘zgarish da’vo qildi — javob ogohlantirish bilan belgilandi.`);
        sse({ type: 'notice', message: 'Model o‘zgarishni yozmadi (ogohlantirish qo‘shildi).' });
        finalContent = [
          '> ⚠️ **Diqqat:** model fayl o‘zgarganini aytdi, lekin bu suhbatda hech qanday yozish amali bajarilmadi.',
          '> Fayl o‘zgartirilmagan bo‘lishi mumkin — iltimos tekshiring yoki aniqroq qilib qayta so‘rang (masalan: “fs.patch bilan a - b ni a + b ga o‘zgartir”).',
          '',
          cleaned
        ].join('\n');
        break;
      }

      finalContent = cleaned;
      break;
    }

    // Register the assistant turn that requested the tools.
    messages.push(
      viaNative
        ? {
            role: 'assistant',
            content: result.content || '',
            tool_calls: calls.map((call) => ({ function: { name: call.name, arguments: call.arguments } }))
          }
        : { role: 'assistant', content: result.content }
    );

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

      // Native tool calling gets the raw result (the role already says "tool"); the
      // text protocol needs an explicit header because it arrives as a user message.
      const body = toolChars > MAX_TOTAL_TOOL_CHARS
        ? 'Kontekst to‘ldi: keyingi qadamda mavjud ma’lumot asosida yakuniy javobni ber.'
        : viaNative
          ? payload
          : `TOOL RESULT for ${call.name} (${output.ok === false ? 'FAILED' : 'OK'}):\n${payload}`;

      if (viaNative) {
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
