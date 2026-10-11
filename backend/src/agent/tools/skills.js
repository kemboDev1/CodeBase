import { truncate } from '../../lib/text.js';

const def = (name, title, description, parameters, run) => ({
  name, title, description, category: 'skills', defaultPolicy: 'allow', parameters, run, source: 'core'
});

function findSkill(ctx, name) {
  const wanted = String(name || '').trim().toLowerCase();
  const pool = (ctx.skills && ctx.skills.length ? ctx.skills : ctx.store.skills || []).filter((skill) => skill.enabled !== false);
  return (
    pool.find((skill) => skill.id.toLowerCase() === wanted) ||
    pool.find((skill) => skill.name.toLowerCase() === wanted) ||
    pool.find((skill) => skill.name.toLowerCase().includes(wanted)) ||
    pool.find((skill) => wanted.includes(skill.name.toLowerCase()))
  );
}

export const skillList = def(
  'skill.list',
  'List skills',
  'List the available skills with their purpose. Load a skill with skill.load before following it.',
  { type: 'object', properties: {}, required: [] },
  async (_args, ctx) => {
    const skills = (ctx.skills && ctx.skills.length ? ctx.skills : ctx.store.skills || []).filter((skill) => skill.enabled !== false);
    return {
      ok: true,
      summary: `${skills.length} skill mavjud`,
      content: skills.length
        ? skills.map((skill) => `- ${skill.id} | ${skill.name}: ${truncate(skill.description || '', 160)}${skill.whenToUse ? ` [qachon: ${truncate(skill.whenToUse, 100)}]` : ''}`).join('\n')
        : 'NO SKILLS.',
      data: { count: skills.length }
    };
  }
);

export const skillLoad = def(
  'skill.load',
  'Load skill instructions',
  'Load the full instructions of a skill by its id or name, then follow them for the current task.',
  {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill id or name, e.g. "code-review" or "Code review".' }
    },
    required: ['name']
  },
  async (args, ctx) => {
    const skill = findSkill(ctx, args.name);
    if (!skill) {
      const available = (ctx.store.skills || []).map((item) => item.id).join(', ');
      return { ok: false, error: `Skill topilmadi: ${args.name}. Mavjud: ${available || 'yo‘q'}` };
    }
    return {
      ok: true,
      summary: `${skill.name} yuklandi`,
      content: [`SKILL: ${skill.name}`, skill.description ? `PURPOSE: ${skill.description}` : '', '', String(skill.content || '').slice(0, 12_000)]
        .filter(Boolean)
        .join('\n'),
      data: { id: skill.id, name: skill.name }
    };
  }
);

export const skillTools = [skillList, skillLoad];
export default skillTools;
