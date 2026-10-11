/**
 * Skills registry tests (architecture contract §18).
 *
 * Run with: `node --test backend/test/skills.test.mjs`
 * Only Node built-ins and the module under test are imported.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_SKILLS_DIR,
  MAX_SKILL_BYTES,
  importSkill,
  loadSkills,
  parseSkillMarkdown,
  renderSkill,
  skillSummaryPrompt,
} from '../src/skills/registry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED_SKILLS = [
  'code-review',
  'debugging',
  'refactor-safely',
  'write-tests',
  'git-workflow',
  'security-audit',
  'performance-optimization',
  'explain-code',
  'project-scaffold',
  'uzbek-style',
];

/**
 * Create a temporary directory and register it for cleanup.
 *
 * @param {import('node:test').TestContext} t Test context.
 * @param {string} [prefix] Directory prefix.
 * @returns {Promise<string>} Absolute temp directory.
 */
async function tempDir(t, prefix = 'codebase-skills-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

/**
 * Write a file, creating parent directories.
 *
 * @param {string} file Absolute path.
 * @param {string} content File content.
 * @returns {Promise<void>} Resolves when written.
 */
async function write(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

test('parseSkillMarkdown reads YAML frontmatter', () => {
  const parsed = parseSkillMarkdown([
    '---',
    'name: "code review"',
    'description: "Review a diff and report findings: severity first."',
    'whenToUse: "before committing"',
    '---',
    '',
    '# Body heading',
    '',
    'Step 1.',
  ].join('\n'), 'code-review.md');

  assert.equal(parsed.name, 'code review');
  assert.equal(parsed.description, 'Review a diff and report findings: severity first.');
  assert.equal(parsed.whenToUse, 'before committing');
  assert.match(parsed.content, /^# Body heading/);
  assert.match(parsed.content, /Step 1\./);
});

test('parseSkillMarkdown works without frontmatter and infers name and description', () => {
  const parsed = parseSkillMarkdown([
    '# Database migrations',
    '',
    'Apply schema changes safely and reversibly.',
    '',
    '## Steps',
    '1. Inspect the current schema.',
  ].join('\n'), 'db-migrations.md');

  assert.equal(parsed.name, 'Database migrations');
  assert.equal(parsed.description, 'Apply schema changes safely and reversibly.');
  assert.equal(parsed.whenToUse, '');
  assert.match(parsed.content, /## Steps/);
});

test('parseSkillMarkdown tolerates CRLF, BOM, quotes and colons inside values', () => {
  const source = '\uFEFF---\r\nname: "release: checklist"\r\ndescription: \'Ship it: tag, build, verify\'\r\n---\r\n\r\nBody line.\r\n';
  const parsed = parseSkillMarkdown(source, 'release.md');

  assert.equal(parsed.name, 'release: checklist');
  assert.equal(parsed.description, 'Ship it: tag, build, verify');
  assert.equal(parsed.content, 'Body line.');
  assert.ok(!parsed.content.includes('\r'));
});

test('parseSkillMarkdown handles unquoted values, list values and missing frontmatter name', () => {
  const listy = parseSkillMarkdown([
    '---',
    'description: Plain unquoted description',
    'whenToUse: [on a failing build, before a release]',
    '---',
    '',
    'Do the work.',
  ].join('\n'), 'plain.md');

  assert.equal(listy.name, 'plain');
  assert.equal(listy.description, 'Plain unquoted description');
  assert.equal(listy.whenToUse, 'on a failing build, before a release');

  const unterminated = parseSkillMarkdown('---\nname: broken\n\n# Real heading\n\nReal description.', 'x.md');
  assert.equal(unterminated.name, 'Real heading');
  assert.equal(unterminated.description, 'Real description.');
});

test('parseSkillMarkdown does not treat an empty document as a crash', () => {
  const parsed = parseSkillMarkdown('', '');
  assert.equal(parsed.name, 'Untitled skill');
  assert.equal(parsed.content, '');
});

test('builtin skills load from disk with complete metadata', async () => {
  const skills = await loadSkills({ dirs: [] });
  const builtins = skills.filter(skill => skill.source === 'builtin');

  assert.ok(builtins.length >= 10, `expected >= 10 builtin skills, got ${builtins.length}`);
  for (const skill of builtins) {
    assert.ok(skill.id.startsWith('builtin:'), `bad id: ${skill.id}`);
    assert.ok(skill.name && skill.name.trim(), `missing name: ${skill.id}`);
    assert.ok(skill.description && skill.description.trim(), `missing description: ${skill.id}`);
    assert.ok(skill.content && skill.content.trim().length > 200, `thin content: ${skill.id}`);
    assert.equal(skill.enabled, true);
    assert.ok(skill.path && skill.path.startsWith(BUILTIN_SKILLS_DIR), `path should be inside ${BUILTIN_SKILLS_DIR}: ${skill.id}`);
    assert.ok(skill.whenToUse && skill.whenToUse.trim(), `missing whenToUse: ${skill.id}`);
  }
});

test('every required starter skill exists on disk', async () => {
  for (const slug of REQUIRED_SKILLS) {
    const file = path.join(BUILTIN_SKILLS_DIR, `${slug}.md`);
    const stat = await fs.stat(file);
    assert.ok(stat.isFile(), `${file} should be a file`);
    assert.ok(stat.size > 400, `${file} looks too small (${stat.size} bytes)`);
    const text = await fs.readFile(file, 'utf8');
    assert.ok(text.startsWith('---\n'), `${file} should start with YAML frontmatter`);
    const parsed = parseSkillMarkdown(text, file);
    assert.equal(parsed.name, slug, `${file} frontmatter name should be "${slug}"`);
  }
});

test('loadSkills reads extra directories and dedupes by id', async (t) => {
  const dir = await tempDir(t);
  await write(path.join(dir, 'team-conventions', 'SKILL.md'), [
    '---',
    'name: Team conventions',
    'description: House rules for this repository.',
    'whenToUse: always',
    '---',
    '',
    'Rules body.',
  ].join('\n'));
  await write(path.join(dir, 'loose-skill.md'), '# Loose skill\n\nA loose markdown skill file.');
  await write(path.join(dir, 'broken', 'SKILL.md'), '\u0000\u0000 not markdown at all');

  const warnings = [];
  const logger = { warn: (m) => warnings.push(m), debug: () => {} };
  const skills = await loadSkills({ dirs: [dir, path.join(dir, 'missing')], logger });

  const team = skills.find(skill => skill.id === 'file:team-conventions');
  assert.ok(team, 'expected file:team-conventions');
  assert.equal(team.name, 'Team conventions');
  assert.equal(team.source, 'file');
  assert.ok(team.path.endsWith('SKILL.md'));

  assert.ok(skills.some(skill => skill.id === 'file:loose-skill'));

  const inline = {
    id: 'inline:mine',
    name: 'Mine',
    description: 'Inline skill',
    content: 'Inline body',
    enabled: true,
  };
  const merged = await loadSkills({ dirs: [dir], store: { skills: [inline] } });
  assert.ok(merged.some(skill => skill.id === 'inline:mine' && skill.source === 'inline'));

  const deduped = await loadSkills({ dirs: [dir, dir] });
  assert.equal(deduped.filter(skill => skill.id === 'file:team-conventions').length, 1);
});

test('loadSkills never throws on an unreadable directory', async () => {
  const skills = await loadSkills({ dirs: [path.join(os.tmpdir(), 'codebase-missing-dir-xyz')], logger: { warn: () => {}, debug: () => {} } });
  assert.ok(Array.isArray(skills));
});

test('importSkill imports a directory containing SKILL.md', async (t) => {
  const dir = await tempDir(t);
  const skillDir = path.join(dir, 'sql-safety');
  await write(path.join(skillDir, 'SKILL.md'), [
    '---',
    'name: SQL safety',
    'description: Write parameterised queries and safe migrations.',
    'whenToUse: touching a database layer',
    '---',
    '',
    'Always parameterise queries.',
  ].join('\n'));

  const skill = await importSkill({ from: skillDir });
  assert.equal(skill.source, 'file');
  assert.equal(skill.enabled, true);
  assert.equal(skill.id, 'file:sql-safety');
  assert.equal(skill.name, 'SQL safety');
  assert.equal(skill.path, path.join(skillDir, 'SKILL.md'));
  assert.match(skill.content, /parameterise/);
});

test('importSkill imports a single markdown file', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'On Call.md');
  await write(file, '# On call\n\nTriage incoming alerts in a fixed order.');

  const skill = await importSkill({ from: file });
  assert.equal(skill.source, 'file');
  assert.equal(skill.enabled, true);
  assert.equal(skill.id, 'file:on-call');
  assert.equal(skill.name, 'On call');
  assert.equal(skill.path, file);
});

test('importSkill rejects missing paths, empty directories and oversized files', async (t) => {
  await assert.rejects(() => importSkill({ from: path.join(os.tmpdir(), 'codebase-missing-skill-xyz') }), /not found/i);
  await assert.rejects(() => importSkill({ from: '' }), /requires a path/i);

  const dir = await tempDir(t);
  const empty = path.join(dir, 'no-skill');
  await fs.mkdir(empty, { recursive: true });
  await assert.rejects(() => importSkill({ from: empty }), /No SKILL\.md/);

  const big = path.join(dir, 'big.md');
  await write(big, `---\nname: big\n---\n${'x'.repeat(MAX_SKILL_BYTES + 1024)}`);
  await assert.rejects(() => importSkill({ from: big }), /too large/i);

  const notMarkdown = path.join(dir, 'notes.txt');
  await write(notMarkdown, 'plain text');
  await assert.rejects(() => importSkill({ from: notMarkdown }), /markdown/i);
});

test('importSkill rejects non-https and private remote URLs', async () => {
  await assert.rejects(() => importSkill({ from: 'http://example.com/SKILL.md' }), /https/i);
  await assert.rejects(() => importSkill({ from: 'https://127.0.0.1/SKILL.md' }), /private|local/i);
  await assert.rejects(() => importSkill({ from: 'https://localhost/SKILL.md' }), /local|private/i);
  await assert.rejects(() => importSkill({ from: 'https://192.168.1.10/SKILL.md' }), /private/i);
  await assert.rejects(() => importSkill({ from: 'https://10.0.0.5/SKILL.md' }), /private/i);
  await assert.rejects(() => importSkill({ from: 'https://[::1]/SKILL.md' }), /private/i);
  await assert.rejects(() => importSkill({ from: 'file:///etc/passwd' }), /not found|Unsupported/i);
});

test('skillSummaryPrompt and renderSkill produce prompt-ready text', async () => {
  const skills = await loadSkills({ dirs: [] });
  const prompt = skillSummaryPrompt(skills);
  assert.match(prompt, /Available skills/);
  assert.match(prompt, /builtin:code-review/);
  assert.match(prompt, /use when:/);
  assert.equal(skillSummaryPrompt([]), '');
  assert.equal(skillSummaryPrompt(skills.filter(skill => skill.enabled === false)), '');

  const review = skills.find(skill => skill.id === 'builtin:code-review');
  const rendered = renderSkill(review);
  assert.match(rendered, /^# /);
  assert.match(rendered, /id: builtin:code-review/);
  assert.match(rendered, /source: builtin/);
  assert.ok(rendered.length > review.content.length, 'renderSkill should add a header');
});
