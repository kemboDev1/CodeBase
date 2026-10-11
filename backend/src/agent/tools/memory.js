import { makeId, saveStore } from '../../store.js';
import { truncate } from '../../lib/text.js';

const def = (name, title, description, parameters, run) => ({
  name, title, description, category: 'memory', defaultPolicy: 'allow', parameters, run, source: 'core'
});

export const memorySave = def(
  'memory.save',
  'Save memory',
  'Persist a durable fact about the user or the project so future conversations remember it (preferences, stack, conventions, goals).',
  {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'The fact to remember, one or two sentences.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' }
    },
    required: ['content']
  },
  async (args, ctx) => {
    const content = String(args.content || '').trim().slice(0, 2_000);
    if (!content) return { ok: false, error: 'Memory matni bo‘sh.' };
    const memory = {
      id: makeId('memory'),
      content,
      tags: Array.isArray(args.tags) ? args.tags.map((tag) => String(tag).slice(0, 40)).slice(0, 8) : [],
      createdAt: new Date().toISOString()
    };
    ctx.store.memories.unshift(memory);
    if (ctx.store.memories.length > 200) ctx.store.memories.length = 200;
    await saveStore();
    return { ok: true, summary: `Memory saqlandi: ${truncate(content, 60)}`, content: `OK: memory saqlandi (${ctx.store.memories.length} ta).`, data: { id: memory.id } };
  }
);

export const memoryList = def(
  'memory.list',
  'List memories',
  'List the memories CodeBase has stored about the user and the project.',
  { type: 'object', properties: {}, required: [] },
  async (_args, ctx) => {
    const memories = ctx.store.memories || [];
    return {
      ok: true,
      summary: `${memories.length} memory`,
      content: memories.length
        ? memories.slice(0, 50).map((memory) => `- ${truncate(memory.content, 200)}`).join('\n')
        : 'NO MEMORIES.',
      data: { count: memories.length }
    };
  }
);

export const memoryTools = [memorySave, memoryList];
export default memoryTools;
